// Provider adapters. Each one turns (thread, prompt) into a stream of events:
//   {type:'session', id}            provider session handle to persist
//   {type:'candidate-reset'}         begin/restart the currently written block
//   {type:'candidate-delta', text}   live text whose final role is not known yet
//   {type:'progress', text}          completed user-visible work note
//   {type:'delta', text}            streamed assistant text
//   {type:'tool', name, detail}     a tool / command the model used
//   {type:'status', text}           progress notes
//   {type:'done', text, usage, costUsd}
//   {type:'error', message}
//
// Claude and Codex are driven through their CLIs so runs ride the user's
// existing subscriptions instead of API billing. OpenRouter covers open models.

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliBinary } from './cli-binaries.mjs';
import { lastAnswerIndex, tabTranscriptLine } from './tabmail.mjs';
import { DATA_DIR, getSettings } from './store.mjs';
import { codexBrowserRecoveryArgs } from './codex-browser-runtime.mjs';
import { BROWSER_CONNECTION_POLICY, createBrowserConnectionMonitor } from './browser-connection.mjs';
import { normalizeWrittenOutput } from './written-output.mjs';

// Provider CLIs can start browser/computer helpers of their own. Those helpers
// must leave with the exact Supreme process that started them; otherwise a
// stale local controller can interfere with Computer Use in ChatGPT after a
// Supreme turn has finished. Track only descendants of our own child process,
// give them a real graceful-shutdown window, then reap that private tree.
const PROVIDER_SHUTDOWN_GRACE_MS = Math.max(100, Number(process.env.WB_PROVIDER_SHUTDOWN_GRACE_MS) || 2_000);
const PROVIDER_SHUTDOWN_TERM_MS = Math.max(50, Number(process.env.WB_PROVIDER_SHUTDOWN_TERM_MS) || 750);
const PROVIDER_TREE_POLL_MS = Math.max(50, Number(process.env.WB_PROVIDER_TREE_POLL_MS) || 1_000);
const activeProviderProcesses = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// The process table is read once for every live provider at a time, and never
// on the event loop's time: the old per-run `execFileSync('ps')` every second
// blocked the whole service for as long as ps took, which the watchdog
// measured at 1.6s with five runs live (2026-09-07), and it ran again every
// 50ms while a turn was shutting down.
const PS_BINARY = fs.existsSync('/bin/ps') ? '/bin/ps' : 'ps';
let processTableRead = null;

function readProcessTable() {
  if (process.platform === 'win32') return Promise.resolve(new Map());
  if (processTableRead) return processTableRead;
  processTableRead = new Promise((resolve) => {
    execFile(PS_BINARY, ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
      processTableRead = null;
      const children = new Map();
      if (error || !output) return resolve(children);
      for (const line of String(output).split(/\r?\n/)) {
        const [pidRaw, parentRaw] = line.trim().split(/\s+/, 2);
        const pid = Number(pidRaw);
        const parent = Number(parentRaw);
        if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid <= 1) continue;
        const siblings = children.get(parent) || [];
        siblings.push(pid);
        children.set(parent, siblings);
      }
      resolve(children);
    });
  });
  return processTableRead;
}

function descendantsOf(children, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const found = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length) {
    const parent = queue.shift();
    for (const pid of children.get(parent) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  // Children before parents prevents a parent from disappearing before its
  // descendants have been signalled and reparented.
  return found.reverse();
}

async function processTree(rootPid) {
  if (process.platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 1) return [];
  return descendantsOf(await readProcessTable(), rootPid);
}

function signalPid(pid, signal) {
  if (!pidIsAlive(pid)) return;
  try { process.kill(pid, signal); } catch {}
}

function signalProviderTree(record, signal) {
  if (record.isolatedGroup && process.platform !== 'win32' && record.rootPid > 1) {
    try { process.kill(-record.rootPid, signal); } catch {}
  }
  for (const pid of record.knownPids) if (pid !== record.rootPid) signalPid(pid, signal);
  signalPid(record.rootPid, signal);
}

async function waitForProviderTree(record, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    await record.capture();
    const alive = [...record.knownPids].some(pidIsAlive);
    if (!alive) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (true);
}

function trackProviderProcess(child, label, { isolatedGroup = false } = {}) {
  const record = {
    child,
    label,
    rootPid: Number(child?.pid) || 0,
    isolatedGroup,
    knownPids: new Set(),
    cleanupPromise: null,
    poll: null,
    capturing: null,
    async capture() {
      if (this.rootPid > 1) this.knownPids.add(this.rootPid);
      if (this.capturing) return this.capturing;
      this.capturing = processTree(this.rootPid).then((pids) => {
        for (const pid of pids) this.knownPids.add(pid);
      }).catch(() => {}).finally(() => { this.capturing = null; });
      return this.capturing;
    },
  };
  void record.capture();
  record.poll = setInterval(() => { void record.capture(); }, PROVIDER_TREE_POLL_MS);
  record.poll.unref?.();
  activeProviderProcesses.add(record);

  const cleanup = ({ reason = 'turn-finished', graceMs = PROVIDER_SHUTDOWN_GRACE_MS } = {}) => {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      await record.capture();
      clearInterval(record.poll);
      // A paused process cannot consume EOF or run its own MCP cleanup.
      signalProviderTree(record, 'SIGCONT');
      try {
        if (child?.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.end();
      } catch {}

      if (!(await waitForProviderTree(record, graceMs))) {
        const descendants = Math.max(0, record.knownPids.size - 1);
        console.warn(`[provider:${label}] forcing local helper cleanup reason=${reason} descendants=${descendants}`);
        if (process.platform === 'win32' && record.rootPid > 1) {
          try {
            execFileSync('taskkill', ['/PID', String(record.rootPid), '/T', '/F'], {
              stdio: 'ignore', timeout: 3_000,
            });
          } catch {}
        } else {
          await record.capture();
          signalProviderTree(record, 'SIGTERM');
          if (!(await waitForProviderTree(record, PROVIDER_SHUTDOWN_TERM_MS))) {
            await record.capture();
            signalProviderTree(record, 'SIGKILL');
            if (!(await waitForProviderTree(record, PROVIDER_SHUTDOWN_TERM_MS))) {
              console.error(`[provider:${label}] local helper cleanup did not settle reason=${reason}`);
            }
          }
        }
      }
    })().finally(() => {
      clearInterval(record.poll);
      activeProviderProcesses.delete(record);
    });
    return record.cleanupPromise;
  };

  record.shutdown = cleanup;
  return { cleanup };
}

export async function shutdownProviderProcesses({ reason = 'service-shutdown', graceMs = PROVIDER_SHUTDOWN_GRACE_MS } = {}) {
  const records = [...activeProviderProcesses];
  if (!records.length) return;
  await Promise.allSettled(records.map((record) => {
    // Reuse the record's one cleanup promise if the turn is already finishing.
    if (record.cleanupPromise) return record.cleanupPromise;
    return record.shutdown({ reason, graceMs });
  }));
}

// ---------------------------------------------------------------------------
// Model registry

export const MODELS = [
  // atCapacity: the model a turn carries on with when the provider turns this
  // one away as full (capacityFallback).
  { id: 'fable', label: 'Fable 5.1', provider: 'claude', cli: 'fable', family: 'Anthropic', atCapacity: 'opus' },
  { id: 'opus', label: 'Opus 5.5', provider: 'claude', cli: 'opus', family: 'Anthropic', atCapacity: 'fable' },
  { id: 'sonnet', label: 'Sonnet 5.5', provider: 'claude', cli: 'sonnet', family: 'Anthropic', atCapacity: 'opus' },
  { id: 'haiku', label: 'Haiku 4.5', provider: 'claude', cli: 'claude-haiku-4-5-20251001', family: 'Anthropic', atCapacity: 'sonnet' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'codex', cli: 'gpt-6-astra', family: 'OpenAI', minCodex: '0.160.0', atCapacity: 'gpt-6.1-sol' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'codex', cli: 'gpt-6.1-sol', family: 'OpenAI', minCodex: '0.160.0', atCapacity: 'gpt-6-astra' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'codex', cli: 'gpt-6-luna', family: 'OpenAI', minCodex: '0.160.0', atCapacity: 'gpt-6.1-sol' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'codex', cli: 'gpt-5.6-sol', family: 'OpenAI', retired: true, replacedBy: 'gpt-6.1-sol', atCapacity: 'gpt-5.6-terra' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'codex', cli: 'gpt-5.6-terra', family: 'OpenAI', retired: true, replacedBy: 'gpt-6-luna', atCapacity: 'gpt-5.6-sol' },
];

const AT_CAPACITY = /\bat capacity\b|overloaded|\b529\b|experiencing high load/i;
export function atCapacity(text) {
  return AT_CAPACITY.test(String(text || ''));
}

// The model a turn carries on with when its own is full, from the same
// provider, when this Mac and account can run it; one hop only, so two full
// models fail the turn honestly.
export function capacityFallback(model, canRun = () => true) {
  const next = model?.atCapacity ? MODELS.find((m) => m.id === model.atCapacity) : null;
  return next && next.provider === model.provider && canRun(next) ? next : null;
}

// Codex says so when a thread resumes on another model than it was recorded
// with. Supreme does that on purpose after a capacity switch, so it is not
// news for the run card.
export function codexModelSwitchNotice(text) {
  return /recorded with model .{1,80} but is resuming with/i.test(String(text || ''));
}

export function currentModelId(id, canRun = () => true) {
  const model = MODELS.find((m) => m.id === id);
  const next = model?.retired && model.replacedBy ? MODELS.find((m) => m.id === model.replacedBy) : null;
  return next && canRun(next) ? next.id : id;
}

// Advertised context windows, for the per-tab meter. The UI presents these as
// estimates; an unresolvable model falls back to the smallest common window.
export function modelContextWindow(model) {
  // Codex's default window, not the larger API/opt-in long-context limit.
  if (model?.provider === 'codex' && /^gpt-6/.test(model.cli || '')) return 272_000;
  if (model?.provider === 'codex') return 400_000;
  if (model?.provider === 'openrouter') return 128_000;
  return 200_000;
}

// `recommended` is a stable, user-selectable pseudo-model. It is deliberately
// kept out of MODELS because a run must resolve to a real provider model first.
// A concrete model pin always bypasses this router.
export const RECOMMENDED_MODEL_ID = 'recommended';
export const PERFORMANCE_POLICIES = ['max-performance', 'favor-quality', 'balanced', 'lean', 'max-roi'];

export function normalizePerformancePolicy(value) {
  return PERFORMANCE_POLICIES.includes(value) ? value : 'balanced';
}

export function isSelectableModel(id) {
  return id === RECOMMENDED_MODEL_ID || !!resolveModel(id);
}

const ROUTES = {
  'max-performance': {
    browser: 'gpt-6.1-sol', strategy: 'opus', review: 'fable', research: 'opus', writing: 'gpt-6-luna', mechanical: 'gpt-6-luna', general: 'opus',
  },
  'favor-quality': {
    browser: 'gpt-6.1-sol', strategy: 'opus', review: 'fable', research: 'sonnet', writing: 'gpt-6-luna', mechanical: 'sonnet', general: 'sonnet',
  },
  balanced: {
    browser: 'gpt-6.1-sol', strategy: 'opus', review: 'fable', research: 'sonnet', writing: 'gpt-6-luna', mechanical: 'haiku', general: 'gpt-6-luna',
  },
  lean: {
    browser: 'gpt-6.1-sol', strategy: 'sonnet', review: 'sonnet', research: 'sonnet', writing: 'gpt-6-luna', mechanical: 'haiku', general: 'haiku',
  },
  'max-roi': {
    browser: 'gpt-6.1-sol', strategy: 'haiku', review: 'haiku', research: 'haiku', writing: 'haiku', mechanical: 'haiku', general: 'haiku',
  },
};

const CATEGORY_COPY = {
  browser: 'browser runs',
  strategy: 'strategy and high-stakes judgment',
  review: 'skeptic review and risk checks',
  research: 'research and judgment calls',
  writing: 'drafts people read',
  mechanical: 'formatting, extraction, and glue',
  general: 'general knowledge work',
};

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// A small, deterministic router is more useful than an opaque recommendation:
// it can be tested, explained in the receipt, and replaced by learned routing
// later without changing the UI or stored data shape.
export function recommendModel({ prompt, policy } = {}) {
  const text = String(prompt || '').toLowerCase();
  let category = 'general';
  if (matchesAny(text, [
    /\b(browser|chrome|website|webpage|web page|navigate|click|upload|download|log[ -]?in|ui|prototype)\b/,
    /\b(gmail|notion|calendar|smartlead|linkedin|google drive|google docs|google sheets)\b/,
  ])) category = 'browser';
  else if (matchesAny(text, [/\b(strategy|strategic|positioning|roadmap|prioriti[sz]e|trade[ -]?off|decision|go-to-market|gtm)\b/])) category = 'strategy';
  else if (matchesAny(text, [/\b(critique|critic|skeptic|review|red[ -]?team|challenge|risk|weakness|fact[ -]?check|stress[ -]?test)\b/])) category = 'review';
  else if (matchesAny(text, [/\b(research|investigate|analy[sz]e|compare|synthesi[sz]e|evaluate|verify|find|source|ramp up|market|prospect)\b/])) category = 'research';
  else if (matchesAny(text, [/\b(write|rewrite|draft|edit|email|message|copy|memo|brief|proposal|subject line|post|narrative)\b/])) category = 'writing';
  else if (matchesAny(text, [/\b(extract|format|convert|rename|sort|dedupe|clean|classify|tag|transcribe|summari[sz]e|table|list)\b/])) category = 'mechanical';

  const normalizedPolicy = normalizePerformancePolicy(policy);
  const modelId = ROUTES[normalizedPolicy][category];
  return { modelId, policy: normalizedPolicy, category, usedFor: CATEGORY_COPY[category] };
}

// Open models are addressed as "or:<openrouter model id>". A starter list is
// offered in the picker; any OpenRouter id can be typed in.
export const OPENROUTER_STARTERS = [
  'deepseek/deepseek-chat',
  'moonshotai/kimi-k2',
  'qwen/qwen3-235b-a22b',
  'meta-llama/llama-4-maverick',
  'mistralai/mistral-large',
];

const MODEL_VERSIONS_FILE = path.join(DATA_DIR, 'model-versions.json');

export function versionLabel(apiModel) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(String(apiModel || '').trim());
  if (!match) return null;
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

// The Claude CLI version the aliases were last asked about ("_cli" in the file).
let probedCli = null;

function saveResolvedModels() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const saved = Object.fromEntries(MODELS.filter((m) => m.apiModel).map((m) => [m.id, m.apiModel]));
    if (probedCli) saved._cli = probedCli;
    fs.writeFileSync(MODEL_VERSIONS_FILE, JSON.stringify(saved, null, 2));
  } catch { /* the label still updates for this boot */ }
}

export function noteResolvedModel(modelId, apiModel) {
  const entry = MODELS.find((m) => m.id === modelId && m.provider === 'claude');
  const label = versionLabel(apiModel);
  if (!entry || !label || (entry.label === label && entry.apiModel === apiModel)) return false;
  entry.label = label;
  entry.apiModel = apiModel;
  saveResolvedModels();
  console.info(`[models] ${modelId} answers as ${apiModel}; shown as ${label}`);
  return true;
}

const ALIAS_PROBE_TIMEOUT_MS = Number(process.env.SUPREME_ALIAS_PROBE_TIMEOUT_MS || 90_000);

export function aliasProbeDue(cliVersion) {
  const aliases = MODELS.filter((m) => m.provider === 'claude' && !m.cli.startsWith('claude-'));
  return aliases.some((m) => !m.apiModel) || (!!cliVersion && cliVersion !== probedCli);
}

export async function probeClaudeAliases(file, cliVersion = null) {
  const aliases = MODELS.filter((m) => m.provider === 'claude' && !m.cli.startsWith('claude-'));
  const found = {};
  for (const model of aliases) {
    const apiModel = await new Promise((resolve) => {
      execFile(file, ['-p', '--model', model.cli, '--output-format', 'json', '--max-turns', '1', 'Reply with OK.'], { timeout: ALIAS_PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (error, stdout) => {
        if (error) return resolve(null);
        const usage = safeJson(String(stdout || '').trim().split('\n').at(-1))?.modelUsage || {};
        // A turn can touch a small helper model too; the alias is the one of its family.
        resolve(Object.keys(usage).find((id) => new RegExp(`^claude-${model.cli}-\\d`).test(id)) || null);
      });
    });
    if (apiModel) { found[model.id] = apiModel; noteResolvedModel(model.id, apiModel); }
  }
  if (cliVersion && Object.keys(found).length === aliases.length) { probedCli = cliVersion; saveResolvedModels(); }
  return found;
}

function loadResolvedModels() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(MODEL_VERSIONS_FILE, 'utf8')) || {}; } catch { return; }
  if (typeof saved._cli === 'string') probedCli = saved._cli;
  delete saved._cli;
  for (const [modelId, apiModel] of Object.entries(saved)) {
    const entry = MODELS.find((m) => m.id === modelId && m.provider === 'claude');
    const label = versionLabel(apiModel);
    if (entry && label) { entry.label = label; entry.apiModel = apiModel; }
  }
}
loadResolvedModels();

export function resolveModel(id) {
  if (!id) return null;
  if (id.startsWith('or:')) {
    const orId = id.slice(3);
    return { id, label: orId, provider: 'openrouter', cli: orId, family: 'Open' };
  }
  return MODELS.find((m) => m.id === id) || null;
}

// ---------------------------------------------------------------------------
// Shared helpers

function transcriptBlock(messages) {
  const lines = [];
  for (const m of messages) {
    // Section 26: a message between tabs reads as what it was, not as a turn.
    if (m.role === 'tab') { lines.push(tabTranscriptLine(m)); continue; }
    const who = m.role === 'user' ? 'User' : `Assistant${m.model ? ` (${m.model})` : ''}`;
    lines.push(`${who}:\n${m.content}\n`);
  }
  return lines.join('\n');
}

// Replay compaction: past this size the oldest turns are represented by the
// tab's rolling summary and only a recent tail is replayed verbatim. The full
// transcript stays saved on the tab — this only bounds what a resume-miss
// re-feeds the model. With no summary available the full replay is kept, so
// compaction can never silently drop history it cannot represent.
export const REPLAY_MAX_CHARS = Number(process.env.WB_REPLAY_MAX_CHARS) || 60_000;
const REPLAY_TAIL_CHARS = Number(process.env.WB_REPLAY_TAIL_CHARS) || 24_000;

// Ordinary local files stay filenames. Web documents remain links and output
// images retain their Markdown so the UI can show a private local preview.
export function stripCodexCitations(text) {
  return normalizeWrittenOutput(text);
}

// Which turns a replay sends verbatim and which fold into the summary. One
// function for the replay and for the pane-header context meter so the two
// never disagree. A user sum-up (thread.compaction, from "Sum up older
// messages") compacts at any size and never replays the turns it folded;
// otherwise compaction is size-driven.
export function replayPlan(thread, priorCount) {
  // A note (a message sent to a person, not the model) sits in the transcript
  // but never in what the model sees.
  // Section 26: a tab message this tab has not read yet (after its last
  // answer) is injected into the turn itself, so the replay leaves it out.
  const lastAnswer = lastAnswerIndex(thread.messages || []);
  const prior = (thread.messages || []).slice(0, priorCount).filter((m, index) => !m?.note && !(m?.role === 'tab' && m.direction === 'in' && index > lastAnswer));
  const summary = String(thread.summary || '').trim();
  const anchor = thread.compaction && Number.isInteger(thread.compaction.keptFrom) ? thread.compaction : null;
  const full = transcriptBlock(prior);
  const wanted = !!summary && (!!anchor || full.length > REPLAY_MAX_CHARS);
  if (!prior.length || !wanted) return { prior, summary, compact: false, tail: prior, elided: 0, keptFrom: 0 };
  // The anchor pins where the verbatim tail may start; the budget below only
  // trims it further.
  const start = anchor ? Math.min(Math.max(0, anchor.keptFrom), prior.length) : 0;
  const candidates = prior.slice(start);
  // A fold (or a sum-up) already chose what stays verbatim, and its summary
  // covers exactly what it folded, so the replay sends everything from the
  // kept point: trimming further here left the turns between the fold and
  // the tail neither summarized nor replayed (2026-09-12). Without an anchor
  // the rolling summary stands in for the rest and only a recent tail is
  // verbatim: whole messages within the budget, always at least the final
  // exchange, even when a single message overruns it.
  const tail = [];
  if (anchor) tail.push(...candidates);
  else {
    let used = 0;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const block = transcriptBlock([candidates[i]]);
      if (tail.length >= 2 && used + block.length > REPLAY_TAIL_CHARS) break;
      used += block.length;
      tail.unshift(candidates[i]);
    }
  }
  const keptFrom = prior.length - tail.length;
  return { prior, summary, compact: keptFrom > 0, tail, elided: keptFrom, keptFrom };
}

// When a provider cannot natively resume (first run on this provider, or the
// thread moved on under a different model), hand it the transcript so far.
// Node's readline glues a line together until it sees "\n". A child that
// prints one enormous line (Codex's thread/resume answer for a long
// computer-use session carries every screenshot it took) grows that string
// past V8's limit and the whole service dies with "RangeError: Invalid string
// length" (2026-09-03: twice in three minutes on the LI Outbound tab, after an
// eight-minute freeze that morning). This reader splits on newlines itself
// and drops any line over the cap, so one oversized reply costs that reply,
// not every run on the Mac.
const MAX_LINE_BYTES = Math.max(1_048_576, Number(process.env.WB_MAX_LINE_BYTES) || 32 * 1024 * 1024);

// How much of a child's stderr is kept: the close handlers read its last
// lines, nothing more.
const STDERR_TAIL_BYTES = 16_384;

export function readLines(stream, onLine, { maxLine = MAX_LINE_BYTES } = {}) {
  const reader = { overflow: null, dropped: 0 };
  let parts = [];
  let size = 0;
  let dropping = false;
  let droppedBytes = 0;
  const flush = () => {
    const line = size ? (parts.length === 1 ? parts[0] : Buffer.concat(parts, size)).toString('utf8') : '';
    parts = [];
    size = 0;
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  stream.on('data', (chunk) => {
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(10, start);
      const piece = nl < 0 ? chunk.subarray(start) : chunk.subarray(start, nl);
      if (dropping) {
        droppedBytes += piece.length;
      } else if (size + piece.length > maxLine) {
        dropping = true;
        droppedBytes = size + piece.length;
        parts = [];
        size = 0;
        reader.dropped += 1;
        if (reader.overflow) reader.overflow(droppedBytes);
        else console.error(`[provider] dropped a line over ${Math.round(maxLine / 1048576)}MB from a model process`);
      } else if (piece.length) {
        parts.push(piece);
        size += piece.length;
      }
      if (nl < 0) break;
      if (dropping) { dropping = false; droppedBytes = 0; } else flush();
      start = nl + 1;
    }
  });
  stream.on('end', () => { if (!dropping && size) flush(); });
  return reader;
}

export function buildHandoffPrompt(thread, prompt, priorCount) {
  const plan = replayPlan(thread, priorCount);
  if (plan.prior.length === 0) return prompt;
  const continuation = 'You are continuing an existing working thread. The earlier turns below may have been answered by other models. Pick up naturally as the assistant; do not restate or summarize the history unless asked.';
  if (!plan.compact) {
    return [
      continuation,
      '',
      '<thread_history>',
      transcriptBlock(plan.prior),
      '</thread_history>',
      '',
      'New user message:',
      prompt,
    ].join('\n');
  }
  return [
    continuation,
    '',
    `<thread_summary elided_turns="${plan.elided}">`,
    `The oldest ${plan.elided} turns are not replayed. Summary of the thread so far: ${plan.summary}`,
    '</thread_summary>',
    '',
    '<thread_history>',
    transcriptBlock(plan.tail),
    '</thread_history>',
    '',
    'New user message:',
    prompt,
  ].join('\n');
}

export function sessionResume(thread, model, priorCount) {
  const provider = model?.provider;
  if (provider !== 'claude' && provider !== 'codex') return null;
  const session = thread?.sessions?.[provider];
  if (!session || session.model !== model.cli) return null;
  const count = Number(session.msgCount);
  if (!Number.isFinite(count) || count < 0 || count > priorCount) return null;
  if (provider === 'claude' && !claudeSessionAvailable(session.id, providerWorkingDirectory(thread))) return null;
  if (provider === 'codex' && !codexSessionAvailable(session.id)) return null;
  return { session, unseen: priorCount - count };
}

export function contextLabel(resume) {
  if (!resume) return 'transcript';
  return resume.unseen ? `resume+${resume.unseen}` : 'resume';
}

// The session resumes natively and gets just the messages it has not seen,
// the way a tab message is handed in: the provider keeps its cache and the
// turn costs the delta.
export function buildDeltaPrompt(thread, prompt, resume, priorCount) {
  const unseen = Number(resume?.unseen) || 0;
  if (unseen <= 0) return prompt;
  const messages = thread.messages || [];
  const lastAnswer = lastAnswerIndex(messages);
  const from = Math.max(0, priorCount - unseen);
  const since = messages.slice(from, priorCount).filter((m, offset) => !m?.note && !(m?.role === 'tab' && m.direction === 'in' && from + offset > lastAnswer));
  if (!since.length) return prompt;
  return [
    '<thread_history since_your_last_turn="true">',
    'These messages were exchanged on this thread since your last turn, by the person or by another model working here. They are context, not new instructions.',
    transcriptBlock(since),
    '</thread_history>',
    '',
    'New user message:',
    prompt,
  ].join('\n');
}

function promptWithLocalImages(prompt, images) {
  const paths = (Array.isArray(images) ? images : []).map((value) => String(value || '')).filter(Boolean);
  if (!paths.length) return prompt;
  return [
    String(prompt || ''),
    '',
    'The user attached the following image files. Inspect every image before answering:',
    ...paths.map((filePath, index) => `${index + 1}. ${filePath}`),
  ].join('\n');
}

// Non-image attachments are copied into the run's working directory before the
// model starts, so the note just points at their on-disk paths — the model reads
// them with its normal file tools (no -i / extraDir needed the way images use).
function promptWithLocalFiles(prompt, files) {
  const paths = (Array.isArray(files) ? files : []).map((value) => String(value || '')).filter(Boolean);
  if (!paths.length) return prompt;
  return [
    String(prompt || ''),
    '',
    'The user attached these files. Read them as needed before answering:',
    ...paths.map((filePath, index) => `${index + 1}. ${filePath}`),
  ].join('\n');
}

function codexBrowserPrompt(prompt) {
  return providerBrowserEnabled('codex') ? `${BROWSER_CONNECTION_POLICY}\n\n${prompt}` : prompt;
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function providerBrowserEnabled(provider) {
  const settings = getSettings();
  const perProvider = settings.browserControlByProvider && typeof settings.browserControlByProvider === 'object'
    ? settings.browserControlByProvider
    : {};
  return typeof perProvider[provider] === 'boolean'
    ? perProvider[provider]
    : settings.browserControlEnabled !== false;
}

// Browser/computer tools carry a deliberately user-facing title in their
// result metadata. Keep that small safe surface separate from tool arguments,
// which can contain shell commands, local paths, prompts, and session details.
function safeComputerStep(value, fallback = 'Working in the browser') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (/\b(?:sed|grep|rg|cat|bash|zsh|powershell)\b|(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\)/i.test(text)) return fallback;
  return text.slice(0, 120);
}

function computerApp(title, pageUrl) {
  const value = `${String(title || '')} ${String(pageUrl || '')}`.toLowerCase();
  if (/linkedin/.test(value)) return 'LinkedIn';
  if (/gmail|mail\.google|email/.test(value)) return 'Gmail';
  if (/calendar\.google|google calendar/.test(value)) return 'Google Calendar';
  if (/notion/.test(value)) return 'Notion';
  if (/granola/.test(value)) return 'Granola';
  if (/smartlead/.test(value)) return 'Smartlead';
  if (/docs\.google|google docs/.test(value)) return 'Google Docs';
  if (/sheets\.google|google sheets/.test(value)) return 'Google Sheets';
  if (/drive\.google|google drive/.test(value)) return 'Google Drive';
  return 'Chrome';
}

function objectResult(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.length > 20_000_000) return null;
  return safeJson(value);
}

const CONNECTOR_NAMES = [
  [/google[ _-]*calendar|\bgcal\b/, 'Google Calendar'],
  [/google[ _-]*(?:docs?|document)/, 'Google Docs'],
  [/google[ _-]*(?:sheets?|spreadsheet)/, 'Google Sheets'],
  [/google[ _-]*drive|\bgdrive\b/, 'Google Drive'],
  [/linkedin/, 'LinkedIn'],
  [/smartlead/, 'Smartlead'],
  [/uber[ _-]*eats/, 'Uber Eats'],
  [/booking(?:\.com|[ _-]*com)?/, 'Booking.com'],
  [/apollo(?:\.io|[ _-]*io)?/, 'Apollo.io'],
  [/granola/, 'Granola'],
  [/circleback/, 'Circleback'],
  [/higgsfield/, 'Higgsfield'],
  [/instacart/, 'Instacart'],
  [/calendar/, 'Google Calendar'],
  [/gmail/, 'Gmail'],
  [/notion/, 'Notion'],
  [/slack/, 'Slack'],
  [/posthog/, 'PostHog'],
  [/descript/, 'Descript'],
  [/clay/, 'Clay'],
  [/vercel/, 'Vercel'],
  [/godaddy/, 'GoDaddy'],
  [/natural/, 'Natural'],
  [/\buber\b/, 'Uber'],
];

const INTERNAL_MCP = /node[ _-]*repl|browser|chrome|computer|playwright|filesystem|shell|terminal|web[ _-]*(?:search|fetch)|context7|sequential[ _-]*thinking|skill|memory/;

function safeConnectorText(value, max = 72) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || /^https?:\/\//i.test(text)) return '';
  if (/\b(?:sed|grep|rg|cat|bash|zsh|powershell)\b|(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\)/i.test(text)) return '';
  return text.slice(0, max);
}

// Keep destination URLs out of human-readable connector copy, but retain a
// separately validated HTTPS URL so completed actions can link back to the
// exact Gmail thread, Notion page, LinkedIn conversation, and so on.
function safeExternalUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = url.hash.slice(0, 500);
    return url.toString().slice(0, 2_000);
  } catch {
    return '';
  }
}

function findConnectorUrl(value, depth = 0, seen = new Set()) {
  if (!value || depth > 4) return '';
  if (typeof value === 'string') {
    const direct = safeExternalUrl(value);
    if (direct) return direct;
    const match = value.match(/https:\/\/[^\s<>"']{6,2000}/i);
    return match ? safeExternalUrl(match[0].replace(/[),.;]+$/, '')) : '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const preferredKeys = [
    'thread_url', 'threadUrl', 'message_url', 'messageUrl', 'page_url', 'pageUrl',
    'document_url', 'documentUrl', 'record_url', 'recordUrl', 'permalink', 'web_url',
    'webUrl', 'url', 'link',
  ];
  for (const key of preferredKeys) {
    const found = safeExternalUrl(value[key]);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findConnectorUrl(child, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

function connectorName(server, tool) {
  const raw = `${String(server || '')} ${String(tool || '')}`.toLowerCase();
  if (INTERNAL_MCP.test(raw)) return null;
  // LinkedIn is a browser surface in Supreme. It is reached through the
  // user's signed-in Chrome session and must never be presented as a direct
  // connector, even if a provider reports an MCP-ish internal tool name.
  if (/linkedin/.test(raw)) return null;
  for (const [pattern, name] of CONNECTOR_NAMES) {
    if (pattern.test(raw)) return name;
  }
  if (!/\bmcp\b|mcp__|connector|plugin/.test(raw)) return null;
  const mcpSegment = String(tool || '').match(/^mcp__([^]+?)__/i)?.[1] || String(server || '');
  const candidate = mcpSegment
    .replace(/^(?:claude[ _-]*ai|codex[ _-]*apps?|plugin)[ _-]*/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate || INTERNAL_MCP.test(candidate) || /^(?:mcp|app|apps|tool|tools)$/i.test(candidate)) return 'Connected tool';
  return candidate.replace(/\b\w/g, (char) => char.toUpperCase()).slice(0, 40);
}

function connectorAction(connector, tool) {
  const value = String(tool || '').toLowerCase();
  if (connector === 'Granola' && /search|query|find|get|fetch|read|list|meeting|transcript|note/.test(value)) return 'listen';
  if (connector === 'LinkedIn' && /connect|invite/.test(value)) return 'connect';
  if (/publish|post|comment/.test(value)) return 'publish';
  if (/send|deliver|reply|forward/.test(value)) return 'send';
  if (/draft/.test(value)) return 'draft';
  if (/schedule|book|reserve/.test(value)) return 'schedule';
  if (/upload|import/.test(value)) return 'upload';
  if (/delete|remove/.test(value)) return 'delete';
  if (/create|new/.test(value)) return 'create';
  if (/update|edit|patch|write|append|insert|replace|move|archive|add/.test(value)) return 'update';
  if (/search|query|find|lookup/.test(value)) return 'search';
  if (/get|fetch|read|list|load|retrieve|download|export/.test(value)) return 'read';
  return 'use';
}

function findConnectorValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return '';
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === 'string' || typeof direct === 'number') {
      const safe = safeConnectorText(direct);
      if (safe) return safe;
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = findConnectorValue(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function connectorCount(value) {
  const parsed = objectResult(value);
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) return null;
    seen.add(node);
    const units = [
      ['pages', 'page'], ['rows', 'row'], ['meetings', 'meeting'], ['messages', 'message'],
      ['events', 'event'], ['files', 'file'], ['documents', 'document'], ['records', 'record'],
      ['results', 'result'], ['items', 'item'],
    ];
    for (const key of ['duration_minutes', 'durationMinutes', 'minutes']) {
      if (Number.isFinite(Number(node[key])) && Number(node[key]) >= 0) return { count: Number(node[key]), unit: 'minute' };
    }
    for (const key of ['duration_seconds', 'durationSeconds']) {
      if (Number.isFinite(Number(node[key])) && Number(node[key]) >= 0) return { count: Number(node[key]), unit: 'second' };
    }
    for (const [key, unit] of units) {
      if (Array.isArray(node[key])) return { count: node[key].length, unit };
      if (Number.isFinite(Number(node[key])) && Number(node[key]) >= 0) return { count: Number(node[key]), unit };
    }
    for (const key of ['total', 'count', 'resultCount', 'result_count']) {
      if (Number.isFinite(Number(node[key])) && Number(node[key]) >= 0) return { count: Number(node[key]), unit: 'result' };
    }
    for (const child of Object.values(node)) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const structured = walk(parsed);
  if (structured) return structured;
  if (typeof value === 'string' && value.length < 200_000) {
    const match = value.match(/\b(\d{1,6})\s+(pages?|rows?|meetings?|messages?|events?|files?|documents?|records?|results?|items?)\b/i);
    if (match) return { count: Number(match[1]), unit: match[2].replace(/s$/i, '').toLowerCase() };
  }
  return {};
}

function connectorMetadata(input, result) {
  const inputObject = objectResult(input) || {};
  const resultObject = objectResult(result) || {};
  // Titles first, then what a search asked for, so five searches read as
  // five different steps instead of one verb five times.
  const detailKeys = ['meeting_title', 'meetingTitle', 'document_title', 'documentTitle', 'database_name', 'databaseName', 'page_title', 'pageTitle', 'file_name', 'fileName', 'title', 'meeting', 'document', 'database', 'calendar', 'subject', 'query', 'q', 'search_query', 'searchQuery', 'search', 'keywords', 'question'];
  const accountKeys = ['account_email', 'accountEmail', 'user_email', 'userEmail', 'mailbox', 'account', 'workspace'];
  const outcomeKeys = ['result_status', 'resultStatus', 'new_status', 'newStatus', 'status', 'state', 'stage'];
  const detail = findConnectorValue(inputObject, detailKeys) || findConnectorValue(resultObject, detailKeys);
  const account = findConnectorValue(inputObject, accountKeys) || findConnectorValue(resultObject, accountKeys);
  const outcome = findConnectorValue(resultObject, outcomeKeys);
  const url = findConnectorUrl(resultObject) || findConnectorUrl(inputObject) || findConnectorUrl(result);
  return { detail, account, outcome, url, ...connectorCount(result) };
}

function connectorToolEvent(item, phase, fallbackId) {
  const server = item?.server || item?.server_name || '';
  const tool = item?.tool || item?.name || '';
  const connector = connectorName(server, tool);
  if (!connector) return null;
  const input = item?.arguments ?? item?.input ?? null;
  const result = item?.result ?? item?.output ?? item?.content ?? null;
  return {
    type: 'connector',
    id: safeConnectorText(item?.id || item?.call_id || fallbackId, 96) || fallbackId,
    phase,
    connector,
    action: connectorAction(connector, tool),
    ...connectorMetadata(input, result),
  };
}

function codexComputerEvent(item) {
  const result = objectResult(item?.result) || objectResult(item?.output) || null;
  const meta = result?._meta?.['codex/toolSurface'] || result?._meta?.browser_use || null;
  const server = String(item?.server || item?.server_name || '');
  const tool = String(item?.tool || item?.name || '');
  const browserTool = meta?.kind === 'browserUse'
    || meta?.backend === 'chrome'
    || (/node_repl|browser|chrome|computer|playwright/i.test(server) && /js|browser|chrome|computer|playwright/i.test(tool));
  if (!browserTool) return null;

  const title = item?.arguments?.title || item?.input?.title || item?.title;
  const screenshot = meta?.screenshot || null;
  const pageUrl = screenshot?.pageUrl || (screenshot?.url?.startsWith('http') ? screenshot.url : '');
  return {
    type: 'computer',
    phase: meta?.sessionEnded ? 'released' : 'step',
    surface: meta?.backend === 'chrome' ? 'Chrome' : 'browser',
    app: computerApp(title, pageUrl),
    step: safeComputerStep(title),
    url: safeExternalUrl(pageUrl),
    previewDataUrl: typeof screenshot?.url === 'string' && screenshot.url.startsWith('data:image/') ? screenshot.url : null,
  };
}

function claudeComputerEvent(block) {
  const name = String(block?.name || '');
  if (!/chrome|computer|browser|playwright/i.test(name)) return null;
  const title = block?.input?.title || block?.input?.description;
  const pageUrl = findConnectorUrl(block?.input);
  return {
    type: 'computer',
    phase: 'step',
    surface: /chrome/i.test(name) ? 'Chrome' : 'browser',
    app: computerApp(title, pageUrl),
    step: safeComputerStep(title),
    url: pageUrl,
  };
}

// SIGSTOP/SIGCONT gives the inline Pause control real semantics for CLI-backed
// agents: the model stops issuing browser actions and can continue in place.
// (OpenRouter has no local process and therefore does not expose this control.)
function attachChildControl(child, control) {
  if (!control || process.platform === 'win32') return () => {};
  let alive = true;
  let paused = false;
  const pause = () => {
    if (!alive || paused) return false;
    try {
      const ok = child.kill('SIGSTOP');
      if (ok) paused = true;
      return ok;
    } catch {
      return false;
    }
  };
  const resume = () => {
    if (!alive || !paused) return false;
    try {
      const ok = child.kill('SIGCONT');
      if (ok) paused = false;
      return ok;
    } catch {
      return false;
    }
  };
  const isPaused = () => paused;
  control.pause = pause;
  control.resume = resume;
  control.isPaused = isPaused;
  return () => {
    alive = false;
    if (control.pause === pause) delete control.pause;
    if (control.resume === resume) delete control.resume;
    if (control.isPaused === isPaused) delete control.isPaused;
  };
}

// ---------------------------------------------------------------------------
// Claude Code CLI

// Map the UI effort label to each provider's accepted reasoning level.
// claude --effort: low|medium|high|xhigh|max ; codex model_reasoning_effort:
// low|medium|high|xhigh|max on the current GPT-5.6 models.
const CLAUDE_EFFORT = { Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Maximum: 'max' };
const CODEX_EFFORT = { Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Maximum: 'max' };
export function claudeEffort(label) { return CLAUDE_EFFORT[label] || 'medium'; }
export function codexEffort(label) { return CODEX_EFFORT[label] || 'medium'; }

function existingDirectory(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

// Synced threads can retain a worktree path from another machine. Node reports
// an invalid spawn cwd as ENOENT against the executable, which makes a healthy
// provider binary look missing. Keep runs available and omit inaccessible
// context directories until that worktree exists on this machine.
export function providerWorkingDirectory(thread = {}) {
  return existingDirectory(thread.cwd) || os.homedir();
}

function claudeProjectDirectory(cwd, home = os.homedir()) {
  const resolved = path.resolve(String(cwd || home));
  // Claude stores print-mode sessions under ~/.claude/projects using the
  // absolute working directory with path punctuation replaced by dashes.
  const projectKey = resolved.replace(/[^a-z0-9]/gi, '-');
  return path.join(home, '.claude', 'projects', projectKey);
}

export function claudeSessionAvailable(sessionId, cwd, { home = os.homedir() } = {}) {
  const id = String(sessionId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  const candidates = [path.resolve(String(cwd || home))];
  try {
    const real = fs.realpathSync(candidates[0]);
    if (!candidates.includes(real)) candidates.push(real);
  } catch {}
  return candidates.some((directory) => fs.existsSync(path.join(claudeProjectDirectory(directory, home), `${id}.jsonl`)));
}

// Codex rollouts live under ~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl
// and never leave the Mac that wrote them, exactly like Claude session files.
// A shared thread can carry a teammate's thread id (their Mac ran the last
// turn), and resuming it here fails with "no rollout found" — so only resume
// when the rollout actually exists on this Mac.
export function codexSessionAvailable(sessionId, { home = os.homedir() } = {}) {
  const id = String(sessionId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  try {
    return fs.readdirSync(path.join(home, '.codex', 'sessions'), { recursive: true })
      .some((name) => String(name).includes(id));
  } catch {
    return false;
  }
}

// Section 26: Supreme's own MCP server, one implementation every model family
// loads. The CLI spawns it per run with the calling tab in its environment.
const SUPREME_MCP_PATH = fileURLToPath(new URL('./supreme-mcp.mjs', import.meta.url));
const SUPREME_TOOL_NAMES = ['list_tabs', 'send_to_tab', 'read_tab', 'recall', 'read_slack_context', 'read_slack_people'];
function supremeMcpEnv(thread) {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    SUPREME_PORT: String(thread.tabmail.port || 4747),
    SUPREME_TASK_ID: String(thread.tabmail.taskId || ''),
    SUPREME_TAB_ID: String(thread.tabmail.tabId || ''),
    // Section 27: an orchestrator tab gets the roster tools.
    SUPREME_TAB_TYPE: String(thread.tabmail.type || ''),
  };
}
function supremeMcpForClaude(thread) {
  if (!thread.tabmail) return {};
  return { supreme: { command: process.execPath, args: [SUPREME_MCP_PATH], env: supremeMcpEnv(thread) } };
}
function supremeMcpForCodex(thread) {
  if (!thread.tabmail) return [];
  const env = supremeMcpEnv(thread);
  const table = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',');
  return [
    '-c', `mcp_servers.supreme.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.supreme.args=[${JSON.stringify(SUPREME_MCP_PATH)}]`,
    '-c', `mcp_servers.supreme.env={${table}}`,
    // Supreme runs unattended (approval policy never), and codex 0.153 asks
    // approval for an MCP tool unless its server pre-approves; verified
    // against the real CLI on 2026-09-06.
    '-c', 'mcp_servers.supreme.default_tools_approval_mode="approve"',
  ];
}

// Which long options this Claude CLI takes, read once per binary from
// `claude --help` (an update lands as a new file, so the real path, size and
// time say when to read again). Unknown until read, and empty when the read
// fails, so a flag is only ever passed to a CLI that lists it.
const CLAUDE_HELP_TIMEOUT_MS = 8_000;
const claudeHelpByBinary = new Map();
function binaryIdentity(file) {
  try {
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return file;
  }
}
export function claudeSupports(file, flag) {
  const key = binaryIdentity(file);
  if (!claudeHelpByBinary.has(key)) {
    claudeHelpByBinary.set(key, new Promise((resolve) => {
      execFile(file, ['--help'], { timeout: CLAUDE_HELP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (error, stdout) => {
        resolve(new Set(error ? [] : String(stdout || '').match(/--[a-z][a-z0-9-]*/g) || []));
      });
    }));
  }
  return claudeHelpByBinary.get(key).then((flags) => flags.has(flag));
}

function claudeArgs(thread, model, { resumeId, effort, thinkingDisplay = false }) {
  const args = [
    '-p',
    '--model',
    model.cli,
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  // Without this the CLI streams thinking as empty "updates" (token counts,
  // no words); with it, a model-written summary of the thinking, which
  // becomes the tab's work notes below. Only for a CLI that lists the flag.
  if (thinkingDisplay) args.push('--thinking-display', 'summarized');
  if (effort) args.push('--effort', claudeEffort(effort));
  if (resumeId) args.push('--resume', resumeId);
  const trim = thread.mcpTrim?.claude || null;
  const supreme = supremeMcpForClaude(thread);
  if (!thread.connectors || trim?.mode === 'empty') {
    // Skip the user's claude.ai connector MCP servers (they add ~100k tokens
    // of tool schemas per call). Connectors are opt-in per thread, and a tab
    // summed up without ever using one runs without any of them. Supreme's
    // own server rides along regardless.
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { ...supreme } }));
  } else if (trim?.mode === 'config') {
    // Keep only the local servers this tab actually uses. A scope that needs
    // an account connector arrives as mode 'none' and keeps the full set.
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { ...trim.servers, ...supreme } }));
  } else if (Object.keys(supreme).length) {
    // Without a strict config this merges with the user's own servers.
    args.push('--mcp-config', JSON.stringify({ mcpServers: supreme }));
  }
  const tools = thread.tools || 'safe';
  if (tools === 'off') {
    args.push('--tools', '');
  } else if (tools === 'safe') {
    args.push('--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', ...(thread.tabmail ? SUPREME_TOOL_NAMES.map((name) => `mcp__supreme__${name}`) : []));
  } else if (tools === 'full') {
    args.push('--dangerously-skip-permissions');
    // Claude for Chrome integration — lets full-tool Claude tabs drive the
    // user's Chrome (needs the extension installed + Chrome running), the
    // Claude-side equivalent of codex's browser control.
    args.push(providerBrowserEnabled('claude') ? '--chrome' : '--no-chrome');
  }
  const threadDirectory = existingDirectory(thread.cwd);
  if (threadDirectory) args.push('--add-dir', threadDirectory);
  for (const directory of thread.extraDirs || []) {
    const extraDirectory = existingDirectory(directory);
    if (extraDirectory && extraDirectory !== threadDirectory) args.push('--add-dir', extraDirectory);
  }
  return args;
}

export function runClaude(options, emit) {
  const file = resolveCliBinary('claude') || 'claude';
  // One `--help` read per binary; the answer is cached, so this is a few
  // hundred milliseconds once, then nothing.
  return claudeSupports(file, '--thinking-display').then((thinkingDisplay) => {
    if (options.signal?.aborted) return { ok: true, stopped: true, text: '', workNotes: [], sessionId: null, usage: null, costUsd: null };
    return runClaudeWith(options, emit, file, thinkingDisplay);
  });
}

function runClaudeWith({ thread, model, prompt, images = [], files = [], priorCount, signal, effort, control }, emit, file, thinkingDisplay) {
  return new Promise((resolve) => {
    const session = thread.sessions?.claude;
    const cwd = providerWorkingDirectory(thread);
    // Supreme transcripts sync across computers, but Claude CLI session files
    // do not. Only pass --resume when that session exists for this exact local
    // working directory. Otherwise rebuild the turn from Supreme's transcript
    // so a tab opened on another Mac keeps working instead of failing with
    // "No conversation found with session ID".
    // A session that has not seen the newest messages (the other person's
    // turn landed here) resumes with just those (sessionResume).
    const resume = sessionResume(thread, model, priorCount);
    const canResume = !!resume;
    console.info(`[provider:claude] start model=${model.cli} context=${contextLabel(resume)} cwd=${cwd === thread.cwd ? 'thread' : 'fallback'}`);
    const attachmentPrompt = promptWithLocalFiles(promptWithLocalImages(prompt, images), files);
    const finalPrompt = canResume ? buildDeltaPrompt(thread, attachmentPrompt, resume, priorCount) : buildHandoffPrompt(thread, attachmentPrompt, priorCount);
    const args = claudeArgs(thread, model, { resumeId: canResume ? session.id : null, effort, thinkingDisplay });

    const child = spawn(file, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const providerProcess = trackProviderProcess(child, 'claude');
    let stderr = '';
    let sawStreamText = false;
    let text = '';
    let candidateText = '';
    const workNotes = [];
    let finalCommitted = false;
    let sessionId = null;
    let usage = null;
    let costUsd = null;
    let finished = false;
    let stdinOpen = true;
    let inputCount = 0;
    let resultCount = 0;
    let lastResultText = '';
    let lastResultError = null;
    let closeInputTimer = null;
    const computerBlocks = new Set();
    const connectorCalls = new Map();
    const completedConnectors = new Set();
    let connectorSeq = 0;
    const detachControl = attachChildControl(child, control);

    const emitConnector = (block, phase = 'start') => {
      const fallbackId = `claude-connector-${++connectorSeq}`;
      const connector = connectorToolEvent(block, phase, block?.id || fallbackId);
      if (!connector) return false;
      const prior = connectorCalls.get(connector.id);
      connectorCalls.set(connector.id, { ...prior, ...connector });
      if (phase !== 'start') completedConnectors.add(connector.id);
      emit({ ...prior, ...connector });
      return true;
    };

    const finishOpenConnectors = (phase) => {
      for (const connector of connectorCalls.values()) {
        if (completedConnectors.has(connector.id)) continue;
        completedConnectors.add(connector.id);
        emit({ ...connector, phase });
      }
    };

    const finish = (ev) => {
      if (finished) return;
      finished = true;
      void providerProcess.cleanup({ reason: signal?.aborted ? 'turn-interrupted' : 'turn-finished' })
        .catch((error) => console.warn(`[provider:claude] cleanup failed: ${error?.message || error}`))
        .finally(() => resolve(ev));
    };

    const beginCandidateBlock = () => {
      if (candidateText && !/\n\s*$/.test(candidateText)) {
        candidateText += '\n\n';
        emit({ type: 'candidate-delta', text: '\n\n' });
      } else if (!candidateText) {
        emit({ type: 'candidate-reset' });
      }
    };

    const appendCandidate = (value) => {
      const chunk = String(value || '');
      if (!chunk) return;
      candidateText += chunk;
      emit({ type: 'candidate-delta', text: chunk });
    };

    let thinkingText = '';
    const flushThinking = (all) => {
      const parts = thinkingText.split(/\n\s*\n/);
      const ready = all ? parts : parts.slice(0, -1);
      thinkingText = all ? '' : parts[parts.length - 1] || '';
      for (const part of ready) {
        const note = part.trim().slice(0, 2_000);
        if (!note) continue;
        workNotes.push(note);
        emit({ type: 'progress', text: note });
      }
    };

    // Claude can write a short narration, call a tool, then write the actual
    // response. A tool boundary is the provider-native signal that the preceding
    // text was a work note rather than part of the deliverable.
    const promoteCandidate = () => {
      const note = candidateText.trim();
      if (note) {
        workNotes.push(note);
        emit({ type: 'progress', text: note });
      }
      candidateText = '';
      emit({ type: 'candidate-reset' });
    };

    // A message sent while Claude is still answering never swallows that
    // answer: what it finished for the earlier message stands as its own reply
    // (an interim), and the follow-up gets its own. Ids pair each interim with
    // the steer it landed in front of.
    const pendingSteerIds = [];
    const splitAnswer = (steerId) => {
      const answer = candidateText.trim();
      candidateText = '';
      emit({ type: 'candidate-reset' });
      if (answer) emit({ type: 'interim', steerId: steerId || null, text: answer });
    };

    const commitFinal = (fallback = '') => {
      if (finalCommitted) return text;
      const finalText = candidateText.trim() ? candidateText.trim() : String(fallback || '').trim();
      candidateText = '';
      emit({ type: 'candidate-reset' });
      if (finalText) emit({ type: 'delta', text: finalText });
      text = finalText;
      finalCommitted = true;
      return text;
    };

    const closeInputWhenCaughtUp = () => {
      if (!stdinOpen || finished || resultCount < inputCount) return;
      clearTimeout(closeInputTimer);
      // Keep a tiny acceptance window after Claude finishes a response. A
      // message sent while the run still looks active can then become the next
      // realtime input instead of racing stdin shutdown.
      closeInputTimer = setTimeout(() => {
        if (!stdinOpen || finished || resultCount < inputCount) return;
        stdinOpen = false;
        child.stdin.end();
      }, 90);
      closeInputTimer.unref?.();
    };

    const writeUserInput = ({ prompt: nextPrompt, images: nextImages = [], files: nextFiles = [], id: steerId = null } = {}) => new Promise((resolveWrite) => {
      if (!stdinOpen || finished || child.killed || child.stdin.destroyed) return resolveWrite(false);
      clearTimeout(closeInputTimer);
      const value = promptWithLocalFiles(promptWithLocalImages(nextPrompt, nextImages), nextFiles);
      if (!value.trim()) return resolveWrite(false);
      // Claude answers the earlier message before it reads this one; that
      // answer is split off as an interim when its result arrives (below),
      // never folded into work notes.
      if (inputCount > 0) pendingSteerIds.push(steerId || null);
      inputCount += 1;
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: value }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) inputCount = Math.max(resultCount, inputCount - 1);
        resolveWrite(!error);
      });
    });

    let steerChain = Promise.resolve(true);
    const steer = (value) => {
      steerChain = steerChain.then(() => writeUserInput(value), () => writeUserInput(value));
      return steerChain;
    };
    if (control) {
      control.steer = steer;
      control.steerMode = 'live';
    }
    const detachSteer = () => {
      clearTimeout(closeInputTimer);
      if (control?.steer === steer) delete control.steer;
      if (control?.steerMode === 'live') delete control.steerMode;
    };

    signal?.addEventListener('abort', () => {
      try {
        if (control?.isPaused?.()) control.resume?.();
      } catch {}
      void providerProcess.cleanup({ reason: 'turn-interrupted', graceMs: 250 });
    });

    child.stdin.on('error', () => { stdinOpen = false; });
    void writeUserInput({ prompt: finalPrompt });

    // Only the tail is ever read (the last lines at close); the whole of a
    // long turn's stderr used to sit in memory until the child ended.
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-STDERR_TAIL_BYTES); });

    let reportedModel = null;
    readLines(child.stdout, (line) => {
      const ev = safeJson(line);
      if (!ev) return;
      if (ev.type === 'assistant' && ev.message?.model && !reportedModel) {
        // The concrete model behind the alias, so the picker can say Fable 5.1.
        reportedModel = String(ev.message.model);
        emit({ type: 'model', id: reportedModel });
      }
      if (ev.session_id && !sessionId) {
        sessionId = ev.session_id;
        emit({ type: 'session', id: sessionId });
      }
      if (ev.type === 'stream_event' && ev.event) {
        const e = ev.event;
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') {
          thinkingText += String(e.delta.thinking || '');
          flushThinking(false);
        } else if (e.type === 'content_block_stop' || e.type === 'content_block_start') {
          // A block ending, or any block starting, ends the thinking before it.
          flushThinking(true);
        }
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
          beginCandidateBlock();
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          sawStreamText = true;
          appendCandidate(e.delta.text);
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          promoteCandidate();
          const computer = claudeComputerEvent(e.content_block);
          if (computer) {
            const key = e.content_block.id || `${computer.surface}:${computer.step}`;
            computerBlocks.add(key);
            emit(computer);
          } else if (emitConnector(e.content_block)) {
            // Connector calls get their own visible lifecycle instead of the
            // generic tool line. Raw names and arguments never reach the UI.
          } else {
            emit({ type: 'tool', name: e.content_block.name });
          }
        }
        return;
      }
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && !sawStreamText) {
            beginCandidateBlock();
            appendCandidate(block.text);
          }
          if (block.type === 'tool_use') {
            if (!sawStreamText) promoteCandidate();
            const computer = claudeComputerEvent(block);
            const key = block.id || (computer && `${computer.surface}:${computer.step}`);
            if (computer && !computerBlocks.has(key)) {
              computerBlocks.add(key);
              emit(computer);
            } else if (!computer && !connectorCalls.has(block.id) && emitConnector(block)) {
              // Some Claude CLI versions provide only the completed assistant
              // block, so treat it as the connector's visible start.
            } else if (!computer) {
              const connector = connectorToolEvent(block, 'start', block.id || `claude-connector-${connectorSeq + 1}`);
              if (connector && connectorCalls.has(connector.id)) {
                const prior = connectorCalls.get(connector.id);
                const enriched = { ...prior, ...connector };
                connectorCalls.set(connector.id, enriched);
                if ((connector.detail && connector.detail !== prior.detail) || (connector.account && connector.account !== prior.account)) emit(enriched);
              } else if (!connector) {
                emit({ type: 'tool', name: block.name });
              }
            }
          }
        }
        return;
      }
      if (ev.type === 'user' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type !== 'tool_result') continue;
          const prior = connectorCalls.get(block.tool_use_id);
          if (!prior || completedConnectors.has(prior.id)) continue;
          const resultMeta = connectorMetadata(null, block.content);
          completedConnectors.add(prior.id);
          emit({ ...prior, ...resultMeta, phase: block.is_error ? 'error' : 'complete' });
        }
        return;
      }
      if (ev.type === 'result') {
        usage = ev.usage || null;
        costUsd = ev.total_cost_usd ?? null;
        // A result flagged is_error (a model this account cannot use, an
        // unavailable model on an old CLI, a rate limit) is a failed turn.
        // It used to be saved as an ordinary answer, and a Duel offered it
        // as pickable.
        lastResultError = ev.is_error ? String(ev.result || 'Claude returned an error') : null;
        if (ev.is_error) {
          emit({ type: 'error', message: lastResultError });
        }
        resultCount += 1;
        lastResultText = String(ev.result || '');
        if (resultCount < inputCount) splitAnswer(pendingSteerIds.shift() || null);
        else closeInputWhenCaughtUp();
      }
    });

    child.on('error', (err) => {
      detachControl();
      detachSteer();
      finishOpenConnectors('error');
      console.error(`[provider:claude] launch failed code=${err.code || 'unknown'} message=${err.message}`);
      emit({ type: 'error', message: `Could not start claude: ${err.message}` });
      finish({ ok: false, text: '', workNotes, sessionId, usage, costUsd });
    });

    child.on('close', (code) => {
      detachControl();
      detachSteer();
      stdinOpen = false;
      if (signal?.aborted) {
        finishOpenConnectors('stopped');
        const finalText = commitFinal();
        emit({ type: 'stopped', text: finalText });
        finish({ ok: true, stopped: true, text: finalText, workNotes, sessionId, usage, costUsd });
        return;
      }
      commitFinal(lastResultText);
      if (code !== 0 && !text) {
        finishOpenConnectors('error');
        const msg = stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with code ${code}`;
        console.error(`[provider:claude] exited code=${code} message=${msg}`);
        emit({ type: 'error', message: msg });
        finish({ ok: false, text: '', workNotes, sessionId, usage, costUsd });
        return;
      }
      if (lastResultError) {
        finishOpenConnectors('error');
        console.error(`[provider:claude] error result: ${lastResultError.slice(0, 200)}`);
        finish({ ok: false, text, workNotes, sessionId, usage, costUsd, error: lastResultError });
        return;
      }
      finishOpenConnectors('complete');
      emit({ type: 'done', text, usage, costUsd });
      finish({ ok: true, text, workNotes, sessionId, usage, costUsd });
    });
  });
}

// ---------------------------------------------------------------------------
// Codex CLI

function codexSandbox(tools) {
  // Non-coding work needs codex's Chrome/browser control (the ChatGPT app's
  // node_repl MCP server) and connector access, which the workspace-write
  // Seatbelt profile blocks (no spawning the app / outbound network). Match the
  // user's own codex setup (danger-full-access) so those tools work. This drops
  // the per-worktree write confinement for codex tabs — acceptable for a
  // single-user local product; gate per-thread later if isolation is needed.
  if (tools === 'full') return 'danger-full-access';
  return 'read-only';
}

function runCodexAttempt({ thread, model, prompt, images = [], files = [], priorCount, signal, effort, control }, emit) {
  return new Promise((resolve) => {
    const session = thread.sessions?.codex;
    const resume = sessionResume(thread, model, priorCount);
    const canResume = !!resume;
    // Images ride codex's -i flag; files are already copied into the cwd, so they
    // reach the model as an in-prompt note pointing at their paths.
    const filePrompt = codexBrowserPrompt(promptWithLocalFiles(prompt, files));
    const finalPrompt = canResume ? buildDeltaPrompt(thread, filePrompt, resume, priorCount) : buildHandoffPrompt(thread, filePrompt, priorCount);
    console.info(`[provider:codex] start model=${model.cli} context=${contextLabel(resume)}`);
    const lastMsgFile = path.join(os.tmpdir(), `workbench-codex-${process.pid}-${Date.now()}.txt`);
    const threadDirectory = existingDirectory(thread.cwd);
    const cwd = threadDirectory || os.homedir();

    const browserConfig = providerBrowserEnabled('codex') ? codexBrowserRecoveryArgs() : [
      '-c', 'plugins."chrome@openai-bundled".enabled=false',
      '-c', 'plugins."computer-use@openai-bundled".enabled=false',
      '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.computer-use.enabled=false',
    ];
    // A per-tab connector scope disables the local servers it does not use.
    const scopeConfig = [...(thread.mcpTrim?.codex?.disable || []).flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]), ...supremeMcpForCodex(thread)];
    let args;
    const imageArgs = images.flatMap((filePath) => ['-i', filePath]);
    if (canResume) {
      // `codex exec resume` does not accept -s/--sandbox or -C/--cd (only the
      // parent `codex exec` does). The resumed session inherits the sandbox it
      // was created with, and the working directory comes from the spawn cwd
      // below, so passing those flags here makes the CLI reject the command.
      args = ['exec', 'resume', ...browserConfig, ...scopeConfig, ...imageArgs, session.id, '--json', '--skip-git-repo-check', '-o', lastMsgFile, '-'];
    } else {
      args = [
        'exec',
        ...browserConfig,
        ...scopeConfig,
        '--json',
        '-m',
        model.cli,
        '-c',
        `model_reasoning_effort=${codexEffort(effort)}`,
        '-s',
        codexSandbox(thread.tools),
        '--skip-git-repo-check',
        '-o',
        lastMsgFile,
        ...imageArgs,
      ];
      if (threadDirectory) args.push('-C', threadDirectory);
      args.push('-');
    }

    const child = spawn(resolveCliBinary('codex') || 'codex', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const providerProcess = trackProviderProcess(child, 'codex');
    let stderr = '';
    let text = '';
    let candidateText = '';
    const workNotes = [];
    let finalCommitted = false;
    let threadId = canResume ? session.id : null;
    let usage = null;
    let finished = false;
    let failureMessage = '';
    const connectorCalls = new Map();
    const completedConnectors = new Set();
    let connectorSeq = 0;
    const detachControl = attachChildControl(child, control);

    // exec cannot steer a running turn. Keep truthful failure reporting there;
    // the initial browser policy supplies the same bounded recovery guidance.
    const browserConnection = createBrowserConnectionMonitor({ emit });

    const emitCodexConnector = (item, phase) => {
      const rawId = item?.id || item?.call_id || `${item?.server || ''}:${item?.tool || item?.name || ''}` || `codex-connector-${++connectorSeq}`;
      const connector = connectorToolEvent(item, phase, rawId);
      if (!connector) return false;
      const prior = connectorCalls.get(connector.id);
      const next = { ...prior, ...connector };
      connectorCalls.set(connector.id, next);
      if (phase !== 'start') completedConnectors.add(connector.id);
      emit(next);
      return true;
    };

    const finishOpenConnectors = (phase) => {
      for (const connector of connectorCalls.values()) {
        if (completedConnectors.has(connector.id)) continue;
        completedConnectors.add(connector.id);
        emit({ ...connector, phase });
      }
    };
    const finish = (ev) => {
      if (finished) return;
      browserConnection.finish();
      finished = true;
      try {
        fs.unlinkSync(lastMsgFile);
      } catch {}
      void providerProcess.cleanup({ reason: signal?.aborted ? 'turn-interrupted' : 'turn-finished' })
        .catch((error) => console.warn(`[provider:codex] cleanup failed: ${error?.message || error}`))
        .finally(() => resolve(ev));
    };

    const setCandidate = (value) => {
      const next = String(value || '').trim();
      if (!next) return;
      candidateText = next;
      emit({ type: 'candidate-reset' });
      emit({ type: 'candidate-delta', text: next });
    };

    const promoteCandidate = () => {
      const note = candidateText.trim();
      if (!note) return;
      workNotes.push(note);
      candidateText = '';
      emit({ type: 'progress', text: note });
      emit({ type: 'candidate-reset' });
    };

    const commitFinal = (fallback = '') => {
      if (finalCommitted) return text;
      const finalText = candidateText.trim() || String(fallback || '').trim();
      candidateText = '';
      emit({ type: 'candidate-reset' });
      if (finalText) emit({ type: 'delta', text: finalText });
      text = finalText;
      finalCommitted = true;
      return text;
    };

    signal?.addEventListener('abort', () => {
      try {
        if (control?.isPaused?.()) control.resume?.();
      } catch {}
      void providerProcess.cleanup({ reason: 'turn-interrupted', graceMs: 250 });
    });

    child.stdin.on('error', () => {});
    child.stdin.write(finalPrompt);
    child.stdin.end();
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-STDERR_TAIL_BYTES); });

    readLines(child.stdout, (line) => {
      const ev = safeJson(line);
      if (!ev) return;
      if (ev.type === 'thread.started' && ev.thread_id) {
        threadId = ev.thread_id;
        emit({ type: 'session', id: threadId });
        return;
      }
      if (['item.started', 'item.completed', 'item.failed'].includes(ev.type) && ev.item) {
        const it = ev.item;
        const itemType = String(it.type || '').replace(/[^a-z]/gi, '').toLowerCase();
        if (ev.type === 'item.completed' && itemType === 'agentmessage' && it.text) {
          promoteCandidate();
          setCandidate(it.text);
        } else if (ev.type === 'item.completed' && itemType === 'commandexecution') {
          promoteCandidate();
          emit({ type: 'tool', name: 'shell', detail: it.command });
        } else if (ev.type === 'item.completed' && itemType === 'reasoning' && it.text) {
          emit({ type: 'status', text: it.text.slice(0, 200) });
        } else if (itemType === 'mcptoolcall') {
          if (ev.type === 'item.started') promoteCandidate();
          const phase = ev.type === 'item.started' ? 'start' : ev.type === 'item.failed' ? 'error' : 'complete';
          const disconnected = ev.type !== 'item.started' && browserConnection.observe(ev.type === 'item.failed' ? { ...it, status: 'failed' } : it);
          if (disconnected) return;
          const computer = ev.type === 'item.completed' ? codexComputerEvent(it) : null;
          if (computer) emit(computer);
          else if (!emitCodexConnector(it, phase) && ev.type === 'item.completed') {
            emit({ type: 'tool', name: `${it.server || ''} ${it.tool || it.name || 'connected tool'}`.trim() });
          }
        }
        return;
      }
      if (ev.type === 'turn.completed') {
        usage = ev.usage || null;
        commitFinal();
        return;
      }
      if (ev.type === 'error' && ev.message) {
        failureMessage = ev.message;
        emit({ type: 'error', message: ev.message });
      }
    });

    child.on('error', (err) => {
      detachControl();
      finishOpenConnectors('error');
      failureMessage = `Could not start codex: ${err.message}`;
      emit({ type: 'error', message: failureMessage });
      finish({ ok: false, text: '', workNotes, sessionId: threadId, usage, error: failureMessage });
    });

    child.on('close', (code) => {
      detachControl();
      let last = '';
      if (!text) {
        try {
          last = fs.readFileSync(lastMsgFile, 'utf8').trim();
        } catch {}
        commitFinal(last);
      }
      const authTransportFailed = CODEX_AUTH_TRANSPORT_ERROR.test(`${failureMessage}\n${stderr}`);
      if (signal?.aborted) {
        finishOpenConnectors('stopped');
        emit({ type: 'stopped', text });
        finish({ ok: true, stopped: true, text, workNotes, sessionId: threadId, usage });
        return;
      }
      if (authTransportFailed || ((code !== 0 || failureMessage) && !text)) {
        finishOpenConnectors('error');
        const msg = failureMessage || stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `codex exited with code ${code}`;
        failureMessage = msg;
        emit({ type: 'error', message: msg });
        finish({ ok: false, text: '', workNotes, sessionId: threadId, usage, error: msg });
        return;
      }
      finishOpenConnectors('complete');
      emit({ type: 'done', text, usage, costUsd: null });
      finish({ ok: true, text, workNotes, sessionId: threadId, usage });
    });
  });
}

function codexAppUserInput(prompt, images = []) {
  const input = [{ type: 'text', text: String(prompt || ''), text_elements: [] }];
  for (const filePath of images || []) {
    const value = String(filePath || '').trim();
    if (value) input.push({ type: 'localImage', path: value });
  }
  return input;
}

function codexAppSandboxPolicy(tools) {
  return tools === 'full'
    ? { type: 'dangerFullAccess' }
    : { type: 'readOnly', networkAccess: false };
}

// Normal Supreme tabs use Codex app-server instead of `codex exec`. The app
// server owns the same local ChatGPT subscription/session, but—critically—it
// exposes `turn/steer`, so follow-ups sent during work join the active turn at
// a safe model boundary instead of waiting for a disconnected second process.
function runCodexAppServer({ thread, model, prompt, images = [], files = [], priorCount, signal, effort, control }, emit) {
  return new Promise((resolve) => {
    const session = thread.sessions?.codex;
    const resume = sessionResume(thread, model, priorCount);
    const canResume = !!resume;
    // Images ride codex's localImage input; files are already copied into the cwd,
    // so they reach the model as an in-prompt note pointing at their paths.
    const filePrompt = codexBrowserPrompt(promptWithLocalFiles(prompt, files));
    const finalPrompt = canResume ? buildDeltaPrompt(thread, filePrompt, resume, priorCount) : buildHandoffPrompt(thread, filePrompt, priorCount);
    console.info(`[provider:codex] start model=${model.cli} context=${contextLabel(resume)} server=app`);
    const threadDirectory = existingDirectory(thread.cwd);
    const cwd = threadDirectory || os.homedir();
    const browserConfig = providerBrowserEnabled('codex') ? codexBrowserRecoveryArgs() : [
      '-c', 'plugins."chrome@openai-bundled".enabled=false',
      '-c', 'plugins."computer-use@openai-bundled".enabled=false',
      '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.computer-use.enabled=false',
    ];
    // A per-tab connector scope disables the local servers it does not use.
    const scopeConfig = [...(thread.mcpTrim?.codex?.disable || []).flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]), ...supremeMcpForCodex(thread)];
    const child = spawn(resolveCliBinary('codex') || 'codex', [
      'app-server',
      ...browserConfig,
      ...scopeConfig,
      '--listen',
      'stdio://',
    ], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const providerProcess = trackProviderProcess(child, 'codex');

    let stderr = '';
    let nextRequestId = 0;
    let finished = false;
    let threadId = canResume ? session.id : null;
    let turnId = null;
    let turnStarted = false;
    let text = '';
    let candidateText = '';
    const workNotes = [];
    let usage = null;
    let failureMessage = '';
    const pending = new Map();
    const itemPhases = new Map();
    const agentDeltas = new Map();
    const connectorCalls = new Map();
    const completedConnectors = new Set();
    let connectorSeq = 0;
    let turnReadyResolve;
    const turnReady = new Promise((resolveReady) => { turnReadyResolve = resolveReady; });
    const detachControl = attachChildControl(child, control);
    let browserConnection;

    const write = (value) => {
      if (finished || child.killed || child.stdin.destroyed || !child.stdin.writable) return false;
      try { return child.stdin.write(`${JSON.stringify(value)}\n`); } catch { return false; }
    };

    const request = (method, params, timeoutMs = 30_000) => new Promise((resolveRequest, rejectRequest) => {
      const id = ++nextRequestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
        reject: (error) => { clearTimeout(timer); rejectRequest(error); },
      });
      if (!write({ method, id, params })) {
        pending.delete(id);
        clearTimeout(timer);
        rejectRequest(new Error('Codex app server is not writable'));
      }
    });

    const notify = (method, params) => write({ method, params });

    const emitCodexConnector = (item, phase) => {
      const rawId = item?.id || `${item?.server || ''}:${item?.tool || ''}` || `codex-connector-${++connectorSeq}`;
      const connector = connectorToolEvent(item, phase, rawId);
      if (!connector) return false;
      const prior = connectorCalls.get(connector.id);
      const next = { ...prior, ...connector };
      connectorCalls.set(connector.id, next);
      if (phase !== 'start') completedConnectors.add(connector.id);
      emit(next);
      return true;
    };

    const finishOpenConnectors = (phase) => {
      for (const connector of connectorCalls.values()) {
        if (completedConnectors.has(connector.id)) continue;
        completedConnectors.add(connector.id);
        emit({ ...connector, phase });
      }
    };

    const resetCandidate = () => {
      candidateText = '';
      emit({ type: 'candidate-reset' });
    };

    const setCandidate = (value) => {
      const next = String(value || '').trim();
      if (!next || candidateText.trim() === next) return;
      candidateText = next;
      emit({ type: 'candidate-reset' });
      emit({ type: 'candidate-delta', text: next });
    };

    const promoteCandidate = () => {
      const note = candidateText.trim();
      if (!note) return;
      workNotes.push(note);
      emit({ type: 'progress', text: note });
      resetCandidate();
    };

    // A steered message never swallows what Codex had already written: that
    // text stands as its own reply (an interim) and the turn continues. If an
    // agent message was mid-stream, only what came after the split counts
    // toward the continuing answer.
    let lastAgentItemId = null;
    const splitAt = new Map();
    const splitAnswer = (steerId) => {
      const answer = candidateText.trim();
      if (lastAgentItemId) splitAt.set(lastAgentItemId, (agentDeltas.get(lastAgentItemId) || '').length);
      candidateText = '';
      emit({ type: 'candidate-reset' });
      if (answer) emit({ type: 'interim', steerId: steerId || null, text: answer });
    };

    const commitFinal = () => {
      if (text) return text;
      text = candidateText.trim();
      candidateText = '';
      emit({ type: 'candidate-reset' });
      if (text) emit({ type: 'delta', text });
      return text;
    };

    const removeSteerControl = () => {
      if (control?.steer === steer) delete control.steer;
      if (control?.steerMode === 'live') delete control.steerMode;
    };

    const finish = (result) => {
      if (finished) return;
      browserConnection?.finish();
      finished = true;
      turnReadyResolve(null);
      detachControl();
      removeSteerControl();
      for (const entry of pending.values()) entry.reject(new Error('Codex app server closed'));
      pending.clear();
      void providerProcess.cleanup({ reason: signal?.aborted ? 'turn-interrupted' : 'turn-finished' })
        .catch((error) => console.warn(`[provider:codex] cleanup failed: ${error?.message || error}`))
        .finally(() => resolve(result));
    };

    let steerChain = Promise.resolve(true);
    const steer = (value = {}) => {
      const deliver = async () => {
        const readyTurn = turnId || await turnReady;
        if (!readyTurn || !threadId || finished) return false;
        const nextPrompt = String(value.prompt || '').trim();
        if (!nextPrompt) return false;
        try {
          const response = await request('turn/steer', {
            threadId,
            input: codexAppUserInput(promptWithLocalFiles(nextPrompt, value.files), value.images),
            expectedTurnId: readyTurn,
          }, 15_000);
          const accepted = response?.turnId === readyTurn;
          if (accepted) splitAnswer(value.id || null);
          return accepted;
        } catch {
          return false;
        }
      };
      steerChain = steerChain.then(deliver, deliver);
      return steerChain;
    };
    if (control) {
      control.steer = steer;
      control.steerMode = 'live';
    }

    browserConnection = createBrowserConnectionMonitor({ emit, recover: (recoveryPrompt) => {
      const deliver = async () => {
        if (finished || signal?.aborted || !threadId || !turnId) return false;
        try {
          const response = await request('turn/steer', {
            threadId, expectedTurnId: turnId, input: codexAppUserInput(recoveryPrompt),
          }, 15_000);
          return response?.turnId === turnId;
        } catch { return false; }
      };
      // Serialize with user steering without splitting the answer, displaying
      // an internal repair request as a user message, or replaying the goal.
      steerChain = steerChain.then(deliver, deliver);
      return steerChain;
    } });

    const handleItem = (phase, item) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'agentMessage') {
        itemPhases.set(item.id, item.phase || null);
        if (phase === 'start') {
          agentDeltas.set(item.id, '');
          if (item.phase !== 'commentary') resetCandidate();
          return;
        }
        const full = stripCodexCitations(String(item.text || agentDeltas.get(item.id) || ''));
        const value = full.slice(splitAt.get(item.id) || 0).trim();
        if (item.phase === 'commentary') {
          if (value) {
            workNotes.push(value);
            emit({ type: 'progress', text: value });
          }
        } else {
          setCandidate(value);
        }
        return;
      }
      if (item.type === 'reasoning') {
        if (phase === 'complete') {
          const note = [...(item.summary || []), ...(item.content || [])].join(' ').trim();
          if (note) emit({ type: 'status', text: note.slice(0, 200) });
        }
        return;
      }
      if (item.type === 'commandExecution') {
        if (phase === 'start') promoteCandidate();
        if (phase === 'complete') emit({ type: 'tool', name: 'shell', detail: item.command });
        return;
      }
      if (item.type === 'fileChange') {
        if (phase === 'start') promoteCandidate();
        if (phase === 'complete') emit({ type: 'tool', name: 'patch' });
        return;
      }
      if (item.type === 'webSearch') {
        if (phase === 'start') promoteCandidate();
        if (phase === 'complete') emit({ type: 'tool', name: 'websearch' });
        return;
      }
      if (item.type === 'mcpToolCall') {
        if (phase === 'start') promoteCandidate();
        const connectorPhase = phase === 'start' ? 'start' : item.status === 'failed' ? 'error' : 'complete';
        if (phase === 'complete' && browserConnection.observe(item)) return;
        const computer = phase === 'complete' ? codexComputerEvent(item) : null;
        if (computer) emit(computer);
        else if (!emitCodexConnector(item, connectorPhase) && phase === 'complete') {
          emit({ type: 'tool', name: `${item.server || ''} ${item.tool || 'connected tool'}`.trim() });
        }
      }
    };

    let overflowed = false;
    const reader = readLines(child.stdout, (line) => {
      const message = safeJson(line);
      if (!message) return;
      if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'Codex app server request failed'));
        else entry.resolve(message.result);
        return;
      }
      if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
        // Supreme runs are intentionally unattended. `approvalPolicy: never`
        // prevents normal approval requests; reject any unexpected interactive
        // request instead of leaving the model hung forever.
        write({ id: message.id, error: { code: -32601, message: 'Interactive provider request is not available in this run.' } });
        return;
      }
      const params = message.params || {};
      // A late notification for another turn must not steer this turn or
      // overwrite its browser connection state.
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (params.turnId && turnId && params.turnId !== turnId) return;
      if (message.method === 'thread/started') {
        const id = params.thread?.id;
        if (id && id !== threadId) {
          threadId = id;
          emit({ type: 'session', id });
        }
      } else if (message.method === 'turn/started') {
        turnStarted = true;
        turnId = params.turn?.id || turnId;
        if (turnId) turnReadyResolve(turnId);
      } else if (message.method === 'item/started') {
        handleItem('start', params.item);
      } else if (message.method === 'item/completed') {
        handleItem('complete', params.item);
      } else if (message.method === 'item/agentMessage/delta') {
        const itemId = params.itemId;
        const delta = String(params.delta || '');
        const next = `${agentDeltas.get(itemId) || ''}${delta}`;
        agentDeltas.set(itemId, next);
        if (itemPhases.get(itemId) !== 'commentary') {
          lastAgentItemId = itemId;
          candidateText += delta;
          emit({ type: 'candidate-delta', text: delta });
        }
      } else if (message.method === 'item/reasoning/summaryTextDelta') {
        if (params.delta) emit({ type: 'status', text: String(params.delta).slice(0, 200) });
      } else if (message.method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage?.last || params.tokenUsage?.total || usage;
      } else if (message.method === 'rawResponse/completed') {
        usage = params.usage || usage;
      } else if (message.method === 'warning') {
        if (params.message && !codexModelSwitchNotice(params.message)) emit({ type: 'status', text: String(params.message).slice(0, 200) });
      } else if (message.method === 'error') {
        const value = String(params.error?.message || 'Codex returned an error');
        if (codexModelSwitchNotice(value)) return;
        failureMessage = value;
        if (!params.willRetry) emit({ type: 'error', message: value });
      } else if (message.method === 'turn/completed') {
        const completed = params.turn || {};
        if (turnId && completed.id && completed.id !== turnId) return;
        commitFinal();
        if (completed.status === 'interrupted' || signal?.aborted) {
          finishOpenConnectors('stopped');
          emit({ type: 'stopped', text });
          finish({ ok: true, stopped: true, text, workNotes, sessionId: threadId, usage });
        } else if (completed.status === 'failed') {
          finishOpenConnectors('error');
          const error = String(completed.error?.message || failureMessage || 'Codex could not complete this response.');
          emit({ type: 'error', message: error });
          finish({ ok: false, text, workNotes, sessionId: threadId, usage, error });
        } else {
          finishOpenConnectors('complete');
          emit({ type: 'done', text, usage, costUsd: null });
          finish({ ok: true, text, workNotes, sessionId: threadId, usage });
        }
      }
    });

    child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-STDERR_TAIL_BYTES); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      failureMessage = `Could not start codex: ${error.message}`;
      // A launch/setup failure can still use the proven `codex exec`
      // compatibility path. Keep that handoff calm; only surface an error once
      // an app-server turn actually began and therefore cannot be replayed.
      if (turnStarted) emit({ type: 'error', message: failureMessage });
      finish({ ok: false, text: '', workNotes, sessionId: threadId, usage, error: failureMessage, appServerUnavailable: !turnStarted });
    });
    child.on('close', (code) => {
      if (finished) return;
      const error = failureMessage || stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || `codex app server exited with code ${code}`;
      if (signal?.aborted) {
        commitFinal();
        finishOpenConnectors('stopped');
        emit({ type: 'stopped', text });
        finish({ ok: true, stopped: true, text, workNotes, sessionId: threadId, usage });
      } else {
        if (turnStarted) emit({ type: 'error', message: error });
        finish({ ok: false, text, workNotes, sessionId: threadId, usage, error, appServerUnavailable: !turnStarted });
      }
    });

    signal?.addEventListener('abort', () => {
      if (threadId && turnId && !finished) {
        void request('turn/interrupt', { threadId, turnId }, 3_000).catch(() => {});
        const forceTimer = setTimeout(() => {
          if (!finished) void providerProcess.cleanup({ reason: 'turn-interrupted', graceMs: 250 });
        }, 1_000);
        forceTimer.unref?.();
      } else {
        void providerProcess.cleanup({ reason: 'turn-interrupted', graceMs: 250 });
      }
    });

    // An oversized line is almost always the thread/resume answer for a long
    // session. Fail the requests waiting on it now instead of after their
    // timeout; the handshake below then replays the transcript into a fresh
    // thread, and the run continues instead of the service dying.
    reader.overflow = (bytes) => {
      overflowed = true;
      console.error(`[provider:codex] dropped a ${Math.round(bytes / 1048576)}MB line from the app server`);
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.reject(new Error('Codex sent a reply too large to read'));
      }
    };

    void (async () => {
      try {
        await request('initialize', {
          clientInfo: { name: 'supreme', title: 'Supreme', version: '0.1.14' },
          capabilities: null,
        }, 10_000);
        notify('initialized', {});
        const shared = {
          model: model.cli,
          cwd,
          approvalPolicy: 'never',
          sandbox: codexSandbox(thread.tools),
        };
        let turnPrompt = finalPrompt;
        let opened;
        try {
          opened = canResume
            ? await request('thread/resume', { threadId: session.id, ...shared }, 20_000)
            : await request('thread/start', shared, 20_000);
        } catch (error) {
          // The rollout can still vanish between the availability check and
          // the resume (pruned, or an id that arrived from another Mac before
          // the guard existed). Start fresh with the transcript replayed
          // instead of surfacing a raw thread/resume error as the answer.
          const reason = String(error?.message || error);
          if (!canResume || !(overflowed || /no rollout found/i.test(reason))) throw error;
          if (overflowed) {
            overflowed = false;
            console.error(`[provider:codex] resume of ${session.id} was too large to read; replaying the transcript into a fresh thread`);
            emit({ type: 'status', text: 'This tab’s ChatGPT session got too long to pick up in place. Replaying the transcript instead.' });
          }
          threadId = null;
          turnPrompt = buildHandoffPrompt(thread, filePrompt, priorCount);
          opened = await request('thread/start', shared, 20_000);
        }
        threadId = opened?.thread?.id || threadId;
        if (!threadId) throw new Error('Codex did not return a thread id');
        emit({ type: 'session', id: threadId });
        const started = await request('turn/start', {
          threadId,
          input: codexAppUserInput(turnPrompt, images),
          model: model.cli,
          effort: codexEffort(effort),
          approvalPolicy: 'never',
          sandboxPolicy: codexAppSandboxPolicy(thread.tools),
        }, 30_000);
        turnStarted = true;
        turnId = started?.turn?.id || turnId;
        if (!turnId) throw new Error('Codex did not return a turn id');
        turnReadyResolve(turnId);
      } catch (error) {
        if (finished) return;
        failureMessage = String(error?.message || error || 'Codex app server could not start');
        if (turnStarted) emit({ type: 'error', message: failureMessage });
        finish({ ok: false, text: '', workNotes, sessionId: threadId, usage, error: failureMessage, appServerUnavailable: !turnStarted });
      }
    })();
  });
}

const CODEX_AUTH_TRANSPORT_ERROR = /(?:401\s+unauthorized|responses_websocket[^\n]*401|failed to connect to websocket[^\n]*401)/i;

function codexAuthTransportFailure(result, errors) {
  return !result?.ok && CODEX_AUTH_TRANSPORT_ERROR.test([
    result?.error || '',
    ...(errors || []),
  ].join('\n'));
}

function dedupeNotes(...groups) {
  return [...new Set(groups.flat().map((value) => String(value || '').trim()).filter(Boolean))];
}

// A ChatGPT websocket can occasionally reject an otherwise valid CLI session
// with a transient 401. Starting a fresh CLI process is sufficient to refresh
// the transport. Resume the SAME Codex thread when one was created so a browser
// or connector action is never blindly replayed from the beginning.
async function runCodexExecWithRecovery(ctx, emit) {
  const firstErrors = [];
  let retrySessionId = null;
  let touchedExternalState = false;
  const first = await runCodexAttempt(ctx, (event) => {
    if (event.type === 'session' && event.id) retrySessionId = event.id;
    if (event.type === 'error') {
      if (event.message) firstErrors.push(event.message);
      return;
    }
    if (['tool', 'computer', 'connector'].includes(event.type)) touchedExternalState = true;
    emit(event);
  });

  if (!codexAuthTransportFailure(first, firstErrors) || ctx.signal?.aborted) {
    for (const message of firstErrors) emit({ type: 'error', message });
    return first;
  }

  if (touchedExternalState && !retrySessionId) {
    const message = 'ChatGPT briefly lost authorization after using a connected app. Supreme did not replay the action because it may already have completed. Check the platform, then continue this tab.';
    console.error('[provider:codex] transient auth failure after tool activity; no resumable session was available');
    emit({ type: 'error', message });
    return { ...first, error: message };
  }

  console.warn(`[provider:codex] transient websocket authorization failure; retrying context=${retrySessionId ? 'resume' : 'fresh'} tools=${touchedExternalState ? 'used' : 'unused'}`);
  emit({ type: 'candidate-reset' });
  emit({
    type: 'status',
    text: touchedExternalState
      ? 'ChatGPT reconnected. Checking the current platform state before continuing…'
      : 'ChatGPT reconnected. Resuming…',
  });

  const recoveryPrompt = touchedExternalState
    ? [
        'Supreme recovered this session after a temporary connection failure.',
        'Before taking any further external action, inspect the current browser or connected-platform state and compare it with the user\'s requested outcome.',
        'Do not repeat any action that already completed. Continue only with work that is still outstanding, then report the final state clearly.',
      ].join(' ')
    : 'Supreme recovered this session after a temporary connection failure. Continue the user\'s pending request from where it stopped.';
  const retryThread = retrySessionId
    ? {
        ...ctx.thread,
        sessions: {
          ...(ctx.thread.sessions || {}),
          codex: { id: retrySessionId, model: ctx.model.cli, msgCount: ctx.priorCount },
        },
      }
    : {
        ...ctx.thread,
        sessions: { ...(ctx.thread.sessions || {}), codex: null },
      };
  const retryErrors = [];
  const retry = await runCodexAttempt({
    ...ctx,
    thread: retryThread,
    prompt: retrySessionId ? recoveryPrompt : ctx.prompt,
  }, (event) => {
    if (event.type === 'error') {
      if (event.message) retryErrors.push(event.message);
      return;
    }
    emit(event);
  });

  if (retry.ok) {
    return {
      ...retry,
      workNotes: dedupeNotes(first.workNotes || [], retry.workNotes || []),
      sessionId: retry.sessionId || retrySessionId || first.sessionId || null,
      recovered: true,
    };
  }

  const repeatedAuthFailure = codexAuthTransportFailure(retry, retryErrors);
  const message = repeatedAuthFailure
    ? 'ChatGPT could not reauthorize after two attempts. Reconnect ChatGPT in Models, then continue this tab. Supreme did not blindly replay completed platform actions.'
    : retryErrors.at(-1) || retry.error || 'ChatGPT could not resume this response.';
  console.error(`[provider:codex] recovery failed auth=${repeatedAuthFailure ? 'yes' : 'no'}`);
  emit({ type: 'error', message });
  return { ...retry, error: message, workNotes: dedupeNotes(first.workNotes || [], retry.workNotes || []) };
}

export async function runCodex(ctx, emit) {
  // Duels and other non-interactive one-shot jobs keep the lean exec adapter.
  // Ordinary tabs provide a control object and get provider-native steering.
  if (!ctx.control) return runCodexExecWithRecovery(ctx, emit);
  const result = await runCodexAppServer(ctx, emit);
  if (!result?.appServerUnavailable || ctx.signal?.aborted) return result;
  emit({ type: 'status', text: 'ChatGPT is reconnecting with compatibility mode…' });
  return runCodexExecWithRecovery(ctx, emit);
}

// ---------------------------------------------------------------------------
// OpenRouter (open models)

function openRouterKey() {
  const s = getSettings();
  if (s.openrouterKey) return s.openrouterKey;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const keyFile = path.join(os.homedir(), '.claude', 'streams_or.key');
  try {
    return fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    return null;
  }
}

export async function runOpenRouter({ thread, model, prompt, images = [], files = [], priorCount, signal }, emit) {
  const key = openRouterKey();
  if (!key) {
    emit({ type: 'error', message: 'No OpenRouter key. Add one in Settings.' });
    return { ok: false, text: '' };
  }
  const imageParts = images.flatMap((filePath) => {
    try {
      const extension = path.extname(filePath).toLowerCase();
      const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
      const data = fs.readFileSync(filePath).toString('base64');
      return [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }];
    } catch {
      return [];
    }
  });
  const promptText = promptWithLocalFiles(prompt, files);
  const currentContent = imageParts.length
    ? [{ type: 'text', text: promptText }, ...imageParts]
    : promptText;
  const messages = [
    {
      role: 'system',
      content:
        'You are a capable assistant inside a working thread. Earlier turns may have been answered by other models; continue naturally.',
    },
    ...thread.messages.slice(0, priorCount).filter((m) => !m?.note).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    })),
    { role: 'user', content: currentContent },
  ];
  let text = '';
  let usage = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Workbench',
      },
      body: JSON.stringify({ model: model.cli, messages, stream: true, usage: { include: true } }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      emit({ type: 'error', message: `OpenRouter ${res.status}: ${body.slice(0, 300)}` });
      return { ok: false, text: '' };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const ev = safeJson(data);
        if (!ev) continue;
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          emit({ type: 'delta', text: delta });
        }
        if (ev.usage) usage = ev.usage;
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: 'stopped', text });
      return { ok: true, stopped: true, text, usage };
    } else {
      emit({ type: 'error', message: `OpenRouter failed: ${err.message}` });
    }
    return { ok: false, text };
  }
  const costUsd = usage?.cost ?? null;
  emit({ type: 'done', text, usage, costUsd });
  return { ok: true, text, usage, costUsd };
}

let orModelCache = { at: 0, list: [] };
export async function listOpenRouterModels() {
  if (Date.now() - orModelCache.at < 10 * 60 * 1000) return orModelCache.list;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return orModelCache.list;
    const j = await res.json();
    const list = (j.data || [])
      .map((m) => ({ id: m.id, name: m.name, context: m.context_length }))
      .sort((a, b) => a.id.localeCompare(b.id));
    orModelCache = { at: Date.now(), list };
    return list;
  } catch {
    return orModelCache.list;
  }
}

export function runModel(ctx, emit) {
  const p = ctx.model.provider;
  if (p === 'claude') return runClaude(ctx, emit);
  if (p === 'codex') return runCodex(ctx, emit);
  if (p === 'openrouter') return runOpenRouter(ctx, emit);
  emit({ type: 'error', message: `Unknown provider ${p}` });
  return Promise.resolve({ ok: false, text: '' });
}
