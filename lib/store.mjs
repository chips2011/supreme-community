// Persistence for Conductor: base repos the user added, and tasks (each an
// agent working in its own git worktree). Plain JSON under ~/.workbench so the
// data survives restarts and is easy to inspect or back up.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { taskConfirmationCount, tabConfirmation } from './confirmation.mjs';
import { ensureMessageIds } from './fold.mjs';
import { normalizeMap, laneStates } from './tabmap.mjs';
import { slackInboxMetadata } from './slack-inbox.mjs';

// Fires on every persisted write so the cloud-sync engine (lib/sync.mjs) can
// mirror changes up to Supabase. No-op when nothing is subscribed, so the
// local-only path is unaffected. Payload: { kind, data }.
export const changes = new EventEmitter();
changes.setMaxListeners(0);

export const DATA_DIR = process.env.WORKBENCH_HOME || path.join(os.homedir(), '.supreme-community');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const EVALS_FILE = path.join(DATA_DIR, 'evals.jsonl');

fs.mkdirSync(TASKS_DIR, { recursive: true });
// Transcripts, settings and connector tokens live here: this person's eyes
// only, whatever the umask said when the folder was first made.
try { fs.chmodSync(DATA_DIR, 0o700); } catch {}

export function newId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// repos

// Projects created by the current product already carry a random UUID. Older
// Conductor-era records were identified only by an absolute repo path, which
// makes the same logical project unusable after it syncs to another Mac. Give
// those records a deterministic UUID derived from their existing cloud key so
// every device independently reaches the same identity during the one-time
// migration. The path remains untouched as a compatibility fallback, while
// the UUID groups workstreams and lets each Mac create its own hidden backing
// repo.
export function stableProjectId(project) {
  const existing = String(project?.id || '').trim();
  if (existing) return existing;
  const seed = String(project?.path || project?.name || 'supreme-project');
  const bytes = crypto.createHash('sha256').update(`supreme-project\0${seed}`).digest().subarray(0, 16);
  // RFC 4122 variant + version-5-shaped identifier (the digest is SHA-256,
  // but the UUID semantics here are simply deterministic local identity).
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeProjectIdentities(values) {
  let changed = false;
  const repos = (Array.isArray(values) ? values : []).map((project) => {
    if (!project || typeof project !== 'object' || String(project.id || '').trim()) return project;
    changed = true;
    return { ...project, id: stableProjectId(project) };
  });
  return { repos, changed };
}

export function migrateProjectIdentities() {
  const normalized = normalizeProjectIdentities(listRepos());
  if (normalized.changed) saveRepos(normalized.repos);
  return normalized;
}

// Every whole-file write lands through a temp file and a rename, so a crash
// or a full disk mid-write leaves the last good file, never a half one.
// (saveTask always did this; repos.json and settings.json were written in
// place, and a half-written one read back as "no projects" / "signed out".)
function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// A file that no longer parses is set aside under a dated name rather than
// read as empty and then overwritten by the next save, so what it held can
// still be recovered by hand.
function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try {
    return JSON.parse(text);
  } catch (err) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.renameSync(file, aside); } catch {}
    console.error(`[store] ${path.basename(file)} did not parse (${err.message}); set aside as ${path.basename(aside)}`);
    return fallback;
  }
}

export function listRepos() {
  const repos = readJsonFile(REPOS_FILE, []);
  return Array.isArray(repos) ? repos : [];
}

export function saveRepos(repos) {
  writeAtomic(REPOS_FILE, JSON.stringify(repos, null, 2));
  changes.emit('change', { kind: 'repos', data: repos });
  return repos;
}

export function addRepo({ id, path: repoPath, name, base, hasRemote, managed }) {
  const repos = listRepos();
  const existing = repos.find((r) => r.path === repoPath);
  if (existing) {
    if (id && !existing.id) existing.id = id;
    existing.hasRemote = !!hasRemote;
    if (base) existing.base = base;
    if (managed != null) existing.managed = !!managed;
    saveRepos(repos);
    return existing;
  }
  const rec = {
    ...(id ? { id } : {}),
    path: repoPath,
    name: name || path.basename(repoPath),
    base: base || 'main',
    hasRemote: !!hasRemote,
    managed: !!managed,
  };
  repos.push(rec);
  saveRepos(repos);
  return rec;
}

export function removeRepo(repoPath) {
  saveRepos(listRepos().filter((r) => r.path !== repoPath));
}

export function setRepoArchived(repoPath, archived) {
  const repos = listRepos();
  const r = repos.find((x) => x.path === repoPath);
  if (!r) return null;
  r.archived = !!archived;
  saveRepos(repos);
  return r;
}

export function renameRepo(repoPath, name) {
  const repos = listRepos();
  const r = repos.find((x) => x.path === repoPath);
  if (!r) return null;
  r.name = name;
  saveRepos(repos);
  return r;
}

// ---------------------------------------------------------------------------
// project context blocks — reusable @[Name] blocks stored on the repo record
// so every workstream in the project shares them. Tasks created before repo
// scoping may still carry task-level blocks; migrateTaskContextBlocks() lifts
// those here once, and reads keep honoring any leftovers.

export function normalizeContextBlocks(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((block) => {
    const name = String(block?.name || 'Context block').slice(0, 120);
    const content = String(block?.content || '').slice(0, 20000);
    const key = name.trim().toLowerCase();
    if (!content.trim() || seen.has(key)) return [];
    seen.add(key);
    return [{ id: String(block?.id || newId()), name, content }];
  }).slice(0, 100);
}

export function repoContextBlocks(repoPath) {
  const r = listRepos().find((x) => x.path === repoPath);
  return Array.isArray(r?.contextBlocks) ? r.contextBlocks : [];
}

export function setRepoContextBlocks(repoPath, blocks) {
  const repos = listRepos();
  const r = repos.find((x) => x.path === repoPath);
  if (!r) return null;
  r.contextBlocks = normalizeContextBlocks(blocks);
  saveRepos(repos);
  return r;
}

// On a name collision the project's existing block wins and the task copy is
// dropped — the name is the @[mention] key, so two same-named blocks can't
// both be addressable anyway. Tasks whose repo is no longer registered keep
// their blocks task-level, which reads still honor.
export function migrateTaskContextBlocks() {
  const repos = listRepos();
  const byPath = new Map(repos.map((r) => [r.path, r]));
  const migrated = [];
  for (const f of fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith('.json'))) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(t.contextBlocks) || !t.contextBlocks.length) continue;
    const repo = byPath.get(t.repo);
    if (!repo) continue;
    repo.contextBlocks = normalizeContextBlocks([...(repo.contextBlocks || []), ...t.contextBlocks]);
    migrated.push(t);
  }
  if (!migrated.length) return;
  // Land the lifted blocks on the repos before clearing the task copies, so an
  // interrupted migration duplicates (harmless — reads dedupe) instead of loses.
  saveRepos(repos);
  for (const t of migrated) {
    delete t.contextBlocks;
    saveTask(t);
  }
}

// ---------------------------------------------------------------------------
// tasks

function taskPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad task id');
  return path.join(TASKS_DIR, `${id}.json`);
}

// Section 28, the rail: when a tab's last turn came back clean (the same
// reading as the window's "awake": an answer, not failed, not stopped, not
// waiting on a reply or an unsent draft), the time it landed. The rail sets
// it against when this Mac last looked, so a closed workstream can still say
// one of its tabs answered. On a shared workstream the row also says whose
// turn it was: an answer a teammate's Mac ran is theirs to read, the way a
// confirmation it raised is theirs to give.
function tabLanding(tab) {
  if (!tab || tab.done || tab.type === 'duel' || tab.activeRun) return null;
  const visible = (tab.messages || []).filter((message) => !message.hiddenInTranscript);
  const last = visible[visible.length - 1];
  if (!last || last.role !== 'assistant' || last.ok === false || last.stopped || !last.ts) return null;
  if (tabConfirmation(tab)) return null;
  const touched = [...(last.connectors || []), ...(last.outsideTouches || [])];
  if (touched.some((item) => item.action === 'draft') && !touched.some((item) => item.action === 'send')) return null;
  if (answeredAnotherTab(tab.messages || [], last)) return null;
  return { landedAt: last.ts, ...(last.ranBy?.id ? { landedBy: last.ranBy.id } : {}) };
}

function tabReturn(tab) {
  if (!tab || tab.done || tab.type === 'duel' || tab.activeRun) return null;
  const visible = (tab.messages || []).filter((message) => !message.hiddenInTranscript);
  const last = visible[visible.length - 1];
  if (!last || last.role !== 'assistant' || !last.ts) return null;
  if (answeredAnotherTab(tab.messages || [], last)) return null;
  return { returnedAt: last.ts, ...(last.ranBy?.id ? { returnedBy: last.ranBy.id } : {}) };
}

export function answeredAnotherTab(messages, answer) {
  const end = messages.indexOf(answer);
  if (end < 0) return false;
  let at = end - 1;
  while (at >= 0 && (messages[at].role !== 'user' || messages[at].note)) at -= 1;
  if (at < 0) return false;
  const prompt = messages[at];
  if (!prompt.hiddenInTranscript || !prompt.tabMessages) return false;
  return messages.slice(at + 1, end).some((message) => message.role === 'tab' && message.direction === 'out' && !!message.replyTo);
}

// The orchestrator's card counts what is still out and what came back, so
// the list carries each lane it has asked (lib/tabmap.mjs laneStates).
function orchestratorLanes(tab) {
  return Object.entries(laneStates(tab))
    .filter(([, lane]) => lane.askedAt)
    .map(([key, lane]) => ({ key, askedAt: lane.askedAt, answeredAt: lane.answeredAt || null }));
}

// A compact view for lists (no full transcripts). A task is a "thread": one
// worktree of retained context holding one or more tabs (parallel agents on
// that same context, each possibly a different model). Exported so the sync
// engine can store the same light projection alongside the full document.
export function taskSummary(t) {
  const tabs = t.tabs || [];
  const archivedTabs = t.archivedTabs || [];
  // Connected tabs: the Map index says how many hand-overs each workstream
  // has; the map is read without other workstreams (a foreign card whose
  // tab has gone is still counted here, and dropped on the real read).
  const map = normalizeMap(t);
  return {
    mapOff: !!t.mapOff,
    mapCards: Object.keys(map.cards).length,
    mapDone: Object.values(map.cards).filter((card) => card.threadId === t.id && tabs.find((tb) => tb.id === card.tabId)?.done).length,
    mapHandovers: map.edges.length,
    id: t.id,
    title: t.title,
    ...(t.origin ? { origin: t.origin } : {}),
    ...(t.origin === 'slack' ? { slackInbox: slackInboxMetadata(t) } : {}),
    ...(t.projectId ? { projectId: t.projectId } : {}),
    repo: t.repo,
    repoName: t.repoName,
    branch: t.branch,
    base: t.base,
    model: t.model,
    status: t.status,
    archived: !!t.archived,
    archivedAt: t.archivedAt || null,
    pinned: !!t.pinned,
    // The thread reads done only when every live tab is; the tray lists each
    // done tab (archived ones included, so Archive all keeps the day's tally).
    done: tabs.length > 0 && tabs.every((tb) => tb.done),
    doneTabs: [...tabs, ...archivedTabs]
      .filter((tb) => tb.done)
      .map((tb) => ({ id: tb.id, name: tb.name || 'Untitled', doneAt: tb.doneAt || null, doneLine: tb.doneLine || null })),
    tabCount: tabs.length,
    // The @ menu hands to a tab in any workstream, so the list carries each
    // live tab's name and state; the full document is read only when you go.
    tabs: tabs.map((tb) => {
      const landing = tabLanding(tb);
      const returned = tabReturn(tb);
      return {
        id: tb.id,
        name: tb.name || 'Untitled',
        status: tb.status || 'idle',
        done: !!tb.done,
        ...(tb.type ? { type: tb.type } : {}),
        ...(landing || {}),
        ...(returned || {}),
        ...(tb.type === 'orchestrator' ? { lanes: orchestratorLanes(tb) } : {}),
      };
    }),
    archivedTabCount: archivedTabs.length,
    archivedTabs: archivedTabs.map((tb) => ({
      id: tb.id,
      name: tb.name || 'Untitled',
      archivedAt: tb.archivedAt || null,
    })),
    messageCount: tabs.reduce((n, tb) => n + (tb.messages || []).length, 0),
    needsConfirmationCount: taskConfirmationCount(t),
    lastActivity: t.lastActivity || t.updatedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    diffStat: t.diffStat || null,
    prUrl: t.prUrl || null,
  };
}

// Projects now have a stable cross-device id, while older threads only retain
// the absolute path of the Mac where they were created. Attach the stable id
// whenever that legacy path still matches. The path remains for provider cwd
// compatibility, but navigation can use projectId and no longer make a whole
// project's workstreams disappear during cross-device path localization.
export function normalizeTaskProjectIdentity(task, projects = listRepos()) {
  if (!task || typeof task !== 'object' || String(task.projectId || '').trim()) {
    return { task, changed: false };
  }
  const project = (Array.isArray(projects) ? projects : []).find((candidate) => candidate?.path === task.repo);
  if (!project) return { task, changed: false };
  return { task: { ...task, projectId: stableProjectId(project) }, changed: true };
}

export function migrateTaskProjectIdentities() {
  const projects = listRepos();
  let changed = 0;
  for (const file of fs.readdirSync(TASKS_DIR).filter((name) => name.endsWith('.json'))) {
    let task;
    try { task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf8')); } catch { continue; }
    const normalized = normalizeTaskProjectIdentity(task, projects);
    if (!normalized.changed) continue;
    saveTask(normalized.task);
    changed += 1;
  }
  return changed;
}

// A fresh tab: its own conversation + provider sessions, sharing the thread's
// worktree (cwd) with every other tab in the same thread.
export function makeTab({ id, name, model }) {
  return {
    id: id || newId(),
    name: name || 'Untitled',
    model: model || 'recommended',
    status: 'idle', // idle | running | done | error
    messages: [],
    handoffs: [],
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}

export function listTasks() {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      // Only a teammate's orchestrators were in it (team.mjs absorbThread).
      if (task.privateGone) continue;
      out.push(taskSummary(task));
    } catch {
      // skip unreadable files rather than taking the whole list down
    }
  }
  out.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return out;
}

export function getTask(id) {
  const p = taskPath(id);
  if (!fs.existsSync(p)) return null;
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  if ('done' in t) { delete t.done; delete t.doneAt; delete t.doneLine; }
  // Facts in a fold cite the message they came from, so every message
  // carries an id; older ones get a deterministic one here (lib/fold.mjs).
  ensureMessageIds(t);
  return t;
}

export function saveTask(t) {
  t.updatedAt = new Date().toISOString();
  writeAtomic(taskPath(t.id), JSON.stringify(t, null, 2));
  changes.emit('change', { kind: 'thread', data: t });
  return t;
}

export function createTask({ id, title, projectId, repo, repoName, base, branch, worktreePath, model, tools, tabName, connectors, origin = null }) {
  const now = new Date().toISOString();
  const tid = id || newId();
  const firstTab = makeTab({ name: tabName || 'Main', model: model || 'recommended' });
  const t = {
    id: tid,
    title: title || 'Untitled thread',
    ...(projectId ? { projectId } : {}),
    repo,
    repoName: repoName || path.basename(repo || ''),
    base: base || 'main',
    branch,
    worktreePath,
    cwd: worktreePath, // every tab in this thread runs here (shared context)
    model: model || 'recommended', // default model for new tabs
    tools: tools || 'full',
    // Non-coding work needs the user's connectors (Gmail/Notion/Calendar/...);
    // on by default. Turn off per-thread for pure code tasks to save ~100k
    // tokens/call of connector tool schemas. Only Claude-provider models carry
    // these; codex models get their own (browser-use) toolset.
    connectors: connectors !== false,
    // 'signup' marks the workstream Supreme started from what it read at sign up.
    origin: origin || null,
    mapOff: true,
    archived: false,
    pinned: false,
    status: 'idle', // thread rollup: idle | running | done | error | merged
    tabs: [firstTab],
    activeTab: firstTab.id,
    diffStat: null,
    prUrl: null,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
  };
  return saveTask(t);
}

// Find a tab within a task; falls back to the first tab.
export function getTab(task, tabId) {
  const tabs = task.tabs || [];
  return tabs.find((tb) => tb.id === tabId) || tabs[0] || null;
}

export function deleteTask(id) {
  const p = taskPath(id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  changes.emit('change', { kind: 'thread-delete', data: { id } });
}

// ---------------------------------------------------------------------------
// settings

export function getSettings() {
  const settings = readJsonFile(SETTINGS_FILE, {});
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
}

export function saveSettings(s) {
  // Slack and connector tokens are in here: owner-only, like the backups.
  writeAtomic(SETTINGS_FILE, JSON.stringify(s, null, 2), 0o600);
  changes.emit('change', { kind: 'settings', data: s });
  return s;
}

// ---------------------------------------------------------------------------
// evals — an append-only log of duels (same brief on two models) and the user's
// A/B picks. This is the preference-pair data the product's eval moat is built
// on: every pick is a labeled comparison in a real workflow.

export function appendEval(record) {
  const row = { ...record, at: new Date().toISOString() };
  fs.appendFileSync(EVALS_FILE, JSON.stringify(row) + '\n');
  changes.emit('change', { kind: 'eval', data: row });
}

export function listEvals() {
  if (!fs.existsSync(EVALS_FILE)) return [];
  return fs
    .readFileSync(EVALS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
