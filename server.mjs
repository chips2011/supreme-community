// Conductor: a GUI that replaces the terminal for agent coding work. Point it
// at a repo, give a task a prompt, and an agent works in its own git worktree.
// Run many in parallel, review the diff, then merge or discard.
// Zero dependencies. `node server.mjs` then open http://localhost:4747

import './lib/env.mjs'; // load .env before anything reads process.env
import { slackInboxPage } from './lib/slack-inbox.mjs';
import { workspaceSearch } from './lib/workspace-search.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  listRepos,
  addRepo,
  saveRepos,
  removeRepo,
  setRepoArchived,
  renameRepo,
  repoContextBlocks,
  setRepoContextBlocks,
  stableProjectId,
  migrateProjectIdentities,
  migrateTaskProjectIdentities,
  migrateTaskContextBlocks,
  listTasks,
  taskSummary,
  getTask,
  saveTask,
  createTask,
  deleteTask,
  getSettings,
  saveSettings,
  makeTab,
  getTab,
  appendEval,
  listEvals,
  newId,
} from './lib/store.mjs';
import {
  loadPlays, getPlay, createPlay, updatePlay, deletePlay, playPublic, rulesListToHtml, sanitizeRulesHtml, rulesHtmlToText,
  condenseTranscript, userTurns, findPlayPrompt, revisePlayPrompt, composeStepPrompt, parsePlayJson, parseStepJson,
  fixturePlayFromTranscript, fixtureStep,
} from './lib/plays.mjs';
import {
  createModelHandoff,
  finalizeModelHandoff,
  lastAssistantModel,
} from './lib/handoffs.mjs';
import { confirmationRequest } from './lib/confirmation.mjs';
import { takeFollowups } from './lib/followups.mjs';
import { slackThreadInvited, slackThreadAcknowledgment, authorizeSlackThreadSteer } from './lib/slack-thread-follow.mjs';
import { slackAuthorizeUrl, slackBotUserId, slackCall, slackChannelHistory, slackChannelName, slackConversationInfo, slackMemberPage, slackUserProfile, slackHistoryPage, slackThreadPage, slackDmByEmail, slackExchangeCode, slackFileAttachment, slackHealth, slackMessageText, slackMrkdwn, slackOAuthConfig, slackPlainText, slackPostInThread, slackPrefs, slackReact, slackThreadMessages, slackThreadParent, slackUpdateMessage, slackUserEmail, slackUserName } from './lib/slack.mjs';
import { createSlackContextReader, slackBackgroundAllowed, slackContextError, SLACK_CONTEXT_MAX_CHARS, SLACK_CONTEXT_MESSAGE_CHARS } from './lib/slack-context.mjs';
import { createSlackPeopleReader } from './lib/slack-people.mjs';
import { guessTabs } from './lib/slack-guess.mjs';
import { slackSocketStatus, startSlackSocket } from './lib/slack-socket.mjs';
import { readSlackRequest, claimSlackRequest } from './lib/slack-request-guard.mjs';
import { createSlackActivity } from './lib/slack-activity.mjs';
// Add to Slack: one-time states, ten minutes each, so a stale or replayed
// callback cannot land a token.
const slackOAuthStates = new Map();
import {
  briefingPrompt,
  deterministicTabSummary,
  parseTabSummary,
  tabSummaryPrompt,
  workstreamBriefing,
} from './lib/briefing.mjs';
import {
  MODELS,
  OPENROUTER_STARTERS,
  RECOMMENDED_MODEL_ID,
  isSelectableModel,
  normalizePerformancePolicy,
  recommendModel,
  resolveModel, noteResolvedModel, aliasProbeDue, probeClaudeAliases, currentModelId,
  atCapacity, capacityFallback,
  modelContextWindow,
  runModel,
  listOpenRouterModels,
  shutdownProviderProcesses, sessionResume, REPLAY_MAX_CHARS,
} from './lib/providers.mjs';
import { codexVersion, codexVersionKnown, versionAtLeast } from './lib/codex-version.mjs';
import {
  repoRoot,
  createManagedProject,
  currentBranch,
  listBranches,
  hasRemote,
  createWorktree,
  worktreeDiff,
  commitAll,
  isDirty,
  mergeToBase,
  openPr,
  removeWorktree,
} from './lib/git.mjs';
import * as supabase from './lib/supabase.mjs';
import * as sync from './lib/sync.mjs';
import * as keepawake from './lib/keepawake.mjs';
import * as scheduled from './lib/scheduled.mjs';
import * as email from './lib/email.mjs';
import * as emailPickup from './lib/email-pickup.mjs';
import * as relay from './lib/relay.mjs';
import * as team from './lib/team.mjs';
import * as slackRelay from './lib/slack-relay.mjs';
import * as cliUpdates from './lib/cli-updates.mjs';
import * as backup from './lib/backup.mjs';
import * as flymachines from './lib/flymachines.mjs';
import * as credhandoff from './lib/credhandoff.mjs';
import * as workspaceHandoff from './lib/workspace-handoff.mjs';
import { activeFold, deterministicFold, foldPrompt, foldSummaryText, messagesById, parseFold, planFoldCut, recallBlock, recallFromFold, verifyFacts } from './lib/fold.mjs';
import { TABMAIL_HOP_LIMIT, TABMAIL_MAX_CHARS, addressName, addressOf, lastAnswerIndex, parseTabName, tabMessagesEnvelope, waitingTabMessages } from './lib/tabmail.mjs';
import { MAP_WORDS_MAX, cardKey, cleanCard, deterministicRule, hiddenOwnTabs, mapPublic, mapsForTab, mergeHidden, normalizeMap, orchestratorBrief, parseCardKey, parseRule, refKey, rulePrompt, tabBrief } from './lib/tabmap.mjs';
import { pushPublicKey, pushSubscribe, pushUnsubscribe, pushCount, pushNotify } from './lib/push.mjs';
import { phoneMessage, pushToPhone } from './lib/phone-push.mjs';
import { markSeen as markSeenShared, readSeen } from './lib/seen.mjs';
import { getModelUsage, invalidateModelUsage } from './lib/model-usage.mjs';
import { cleanupContextShares, terminalContextPrompt, writeTerminalTranscript } from './lib/context-shares.mjs';
import {
  appendPlatformContextMessage,
  lockPlatformContextDraft,
  normalizePlatformContexts,
  parsePlatformContextResult,
  platformAccess,
  platformContextAssistantCopy,
  platformContextDefinition,
  platformContextRecord,
  platformContextRunPrompt,
  platformContextSnapshot,
  platformsTouchedByMessage,
  platformSuggestionPrompt,
  platformTurnActivity,
  mergePlatformSuggestions,
  stagePlatformContextSuggestions,
  clearPlatformContextSuggestions,
  publicPlatformContextRecord,
  replacePlatformContextDraft,
  savedPlatformContextPrompt,
  platformContextDefinitions,
} from './lib/platform-context.mjs';
import {
  connectorOverview, connectorOrder, connectorKey, keysUsedByTab, loadConnectorUsage, mcpTrimFor, noteConnectorScan,
  recordConnectorUses, rebuildConnectorUsage, seedConnectorUsageFromHistory,
} from './lib/connectors.mjs';
import {
  collectInheritedEvidence, onboardingReadPrompt, parseOnboardingRead, deterministicOnboardingRead,
  firstTaskPrompt, onboardingContextBlock,
} from './lib/onboarding-read.mjs';
import { resolveCliBinary } from './lib/cli-binaries.mjs';
import { codexLoginAuthenticated, ProviderAccountCache } from './lib/provider-auth.mjs';
import {
  copyTabImageAttachments,
  imageAttachmentPath,
  imageAttachmentRecord,
  materializeFilesIntoWorktree,
  publicImageAttachments,
  removeTabImageAttachments,
  removeTaskImageAttachments,
  saveIncomingImageAttachments,
} from './lib/image-attachments.mjs';
import { publicOutputImages, readOutputImage } from './lib/output-images.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4757);

// Supervision: the desktop app passes its own pid. If that parent ever goes
// away — a crash, a force-quit, an update that could not wait for the 3s
// force-kill timer — this service must not outlive it and squat on the port
// as a half-dead orphan (which is exactly how a launch turned into "Port 4747
// is occupied" on 2026-08-30).
// A seized event loop is the worst failure Supreme has: the app looks alive
// and answers nothing (2026-08-31, the realtime storm). A worker thread
// watches for main-loop heartbeats and SIGKILLs the process when they stop
// for WB_LOOP_WATCHDOG_MS — nothing legitimate blocks the loop that long —
// and the desktop app respawns a fresh service in seconds. The boot grace
// covers one-time synchronous work like the connector history seed.
// Four seizures between 2026-09-03 and 2026-09-07 (64s to 493s, each after
// network trouble) left no trace of what the loop was doing, so the watchdog
// now samples the main thread through the inspector once it is late by
// WB_LOOP_SAMPLE_MS and logs the hottest frames before the kill. The profiler
// runs on its own thread, so a blocked loop cannot stop it.
const LOOP_WATCHDOG_MS = Number(process.env.WB_LOOP_WATCHDOG_MS ?? 30_000);
const LOOP_WATCHDOG_GRACE_MS = Number(process.env.WB_LOOP_WATCHDOG_GRACE_MS ?? 45_000);
const LOOP_SAMPLE_MS = Number(process.env.WB_LOOP_SAMPLE_MS ?? 5_000);
// The Mac asleep is not a seizure. Every lid-closed nap over the limit used
// to read as one (175 kills in this Mac's log by 2026-10-11, each one lined
// up with a pmset sleep entry: the 1021s "seizure" at 14:08 was the 1021s
// nap that began at 13:51), and every kill dropped the runs in flight and
// pulled the cloud copy again on the respawn. A seizure stops only the main
// thread; sleep stops the watchdog's own timer too. So the watchdog reads
// the gap between its own ticks, and a gap that could only be sleep resets
// the heartbeat clock instead of killing.
let loopWatchdog = null;
if (LOOP_WATCHDOG_MS > 0) {
  const watchdog = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
const inspector = require('node:inspector');
// Worker console output travels through the main thread, which is blocked
// when these diagnostics matter. Write straight to the service's stderr.
const log = (message) => { try { require('node:fs').writeSync(2, message + '\\n'); } catch {} };
const bootAt = Date.now();
let last = Date.now();
let sampling = false;
const period = Math.max(500, Math.floor(Math.min(workerData.limit, workerData.sampleAfter) / 4));
const sleepGap = Math.max(5000, period * 4);
let lastTick = Date.now();
parentPort.on('message', (message) => {
  // Test only (the main thread sends it from the guarded nap route): hold
  // this thread the way sleep does, so the smoke can prove a nap is not a kill.
  if (message && typeof message === 'object' && message.nap > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, message.nap);
    return;
  }
  last = Date.now();
});
async function sample(late) {
  sampling = true;
  const session = new inspector.Session();
  try {
    session.connectToMainThread();
    const post = (method, params) => new Promise((resolve, reject) => session.post(method, params || {}, (err, result) => (err ? reject(err) : resolve(result))));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 10000 });
    await post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { profile } = await post('Profiler.stop');
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const parent = new Map();
    for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
    const counts = new Map();
    for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
    const frame = (node) => (node.callFrame.functionName || '(anon)') + (node.callFrame.url ? ' ' + node.callFrame.url.split('/').pop() + ':' + (node.callFrame.lineNumber + 1) : '');
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, count]) => {
      const stack = [];
      let cursor = id;
      while (cursor && stack.length < 8) { stack.push(frame(byId.get(cursor))); cursor = parent.get(cursor); }
      return Math.round((100 * count) / profile.samples.length) + '% ' + stack.join(' < ');
    });
    log('[watchdog] event loop late by ' + late + 'ms; what it is doing: ' + top.join(' | '));
  } catch (err) {
    log('[watchdog] event loop late by ' + late + 'ms; could not sample it: ' + (err && err.message));
  } finally {
    try { session.disconnect(); } catch {}
  }
}
setInterval(() => {
  const now = Date.now();
  const sinceTick = now - lastTick;
  lastTick = now;
  if (sinceTick > sleepGap) {
    // This thread stalled too: the Mac slept (or the whole process was
    // starved). Give the main loop a fresh window instead of a kill.
    log('[watchdog] the Mac was asleep for ' + sinceTick + 'ms; the loop gets a fresh window');
    last = now;
    return;
  }
  if (now - bootAt < workerData.grace) return;
  const late = now - last;
  if (late > workerData.limit) {
    log('[watchdog] event loop seized for ' + late + 'ms, killing the service so the app can respawn it');
    try { process.kill(workerData.pid, 'SIGKILL'); } catch {}
  } else if (late > workerData.sampleAfter && !sampling) {
    sample(late).finally(() => { setTimeout(() => { sampling = false; }, 20000); });
  }
}, period);`,
    { eval: true, workerData: { pid: process.pid, limit: LOOP_WATCHDOG_MS, grace: LOOP_WATCHDOG_GRACE_MS, sampleAfter: LOOP_SAMPLE_MS } },
  );
  watchdog.unref();
  loopWatchdog = watchdog;
  const heartbeat = setInterval(() => { try { watchdog.postMessage(0); } catch {} }, Math.max(250, Math.floor(LOOP_WATCHDOG_MS / 8)));
  heartbeat.unref();
}

const DESKTOP_PARENT_PID = Number(process.env.CONDUCTOR_DESKTOP_PPID || 0);
if (DESKTOP_PARENT_PID) {
  const parentWatchdog = setInterval(() => {
    // The app is gone (force-quit, a crash): leave through the same path a
    // SIGTERM takes, so every model CLI and helper is stopped. A bare exit
    // left a `claude -p` running on in the person's Chrome until its turn
    // ended on its own.
    if (process.ppid !== DESKTOP_PARENT_PID) void shutdownLocalService('PARENT_GONE');
  }, 5_000);
  parentWatchdog.unref();
}
const RUNNER_KIND = process.env.WB_RUNNER_KIND === 'cloud' ? 'cloud' : 'desktop';
const CLOUD_TASK_ID = RUNNER_KIND === 'cloud' ? (process.env.WB_TASK || null) : null;

// Active runs, so they can be cancelled and so status is accurate.
const runs = new Map(); // runId -> {controller, taskId, tabId, model, startedAt, seq, events}
// The update pass, then the Claude aliases asked which model they are now
// when the CLI moved (or one was never asked), so the picker says Opus 5.5
// without anybody running Opus first.
const cliUpdateOptions = {
  resolveBinary: (binary) => resolveCliBinary(binary),
  busy: () => runs.size > 0,
  afterPass: async (results) => {
    const claude = results?.claude;
    const file = resolveCliBinary('claude');
    const version = claude?.updated || claude?.current || null;
    if (!file || !claude?.ok || runs.size > 0 || !aliasProbeDue(version)) return;
    const found = await probeClaudeAliases(file, version);
    if (Object.keys(found).length) console.info(`[models] aliases now ${Object.entries(found).map(([id, api]) => `${id}=${api}`).join(', ')}`);
  },
};

// A tab, task or default left on a retired model reads and runs as its
// replacement, once the Codex here is new enough for it (providers.mjs
// currentModelId). A run reads Codex's version first; a read goes on the
// version last read, and never waits on a login shell to find Codex.
function runsHere(model, version) {
  return !model.minCodex || versionAtLeast(version, model.minCodex);
}
function currentModelNow(id) {
  if (!id || currentModelId(id) === id) return id;
  return currentModelId(id, (model) => runsHere(model, codexVersionKnown(resolveCliBinary('codex', { shellLookup: false }))));
}
async function currentModelFresh(id) {
  if (!id || currentModelId(id) === id) return id;
  const version = await codexVersion(resolveCliBinary('codex'));
  return currentModelId(id, (model) => runsHere(model, version));
}

// What the stand-in reads when it picks up a turn its model was turned away
// from. The request rides along, so a thread that has to be replayed rather
// than resumed still knows what was asked.
function capacityCarryOnPrompt(from, to, asked) {
  const request = String(asked || '').trim().slice(0, 4_000);
  const provider = from.provider === 'claude' ? 'Anthropic' : 'OpenAI';
  return [
    `[${from.label} stopped part way through this turn because ${provider} said it was at capacity. You are ${to.label}, carrying on in the same conversation. Before doing anything, look at what was already done above. Never repeat something that already went out or was already written (a sent email or message, a posted reply, a saved record or row). Then finish the request from where it stopped.]`,
    request ? `The request was:\n${request}` : '',
  ].filter(Boolean).join('\n\n');
}

function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = typeof value === 'number' && typeof out[key] === 'number' ? out[key] + value : value;
  return out;
}
const duelRuns = new Map(); // 'taskId::tabId' -> one controller shared by both contenders
const platformContextRuns = new Map(); // stable platform key -> run id
const recentRuns = new Map(); // completed run metadata retained briefly for reconnects
const RUN_EVENT_LIMIT = 600;
const RECENT_RUN_TTL_MS = 30 * 60 * 1000;
const configuredRunIdleTimeout = Number(process.env.WB_RUN_IDLE_TIMEOUT_MS);
const RUN_IDLE_TIMEOUT_MS = Number.isFinite(configuredRunIdleTimeout) && configuredRunIdleTimeout >= 100
  ? configuredRunIdleTimeout
  : 15 * 60 * 1000;
const configuredWatchdogInterval = Number(process.env.WB_RUN_WATCHDOG_INTERVAL_MS);
const RUN_WATCHDOG_INTERVAL_MS = Number.isFinite(configuredWatchdogInterval) && configuredWatchdogInterval >= 25
  ? configuredWatchdogInterval
  : Math.min(60 * 1000, Math.max(1000, Math.floor(RUN_IDLE_TIMEOUT_MS / 4)));
const ORPHANED_RUN_MESSAGE = 'This run is no longer connected to a model process. Any partial work was preserved; review it before retrying.';
const IDLE_RUN_MESSAGE = 'The model stopped responding, so Supreme safely ended the run. Any partial work was preserved; review it before retrying.';
// A run missing from THIS machine's live map may still be executing on another of
// the user's devices (or the cloud) and syncing its progress here. Only treat it
// as orphaned once its synced activity has been quiet this long, so viewing a live
// cross-device run never clobbers it with a false "interrupted" / computer-control-
// stopped state.
const RUN_LIVENESS_GRACE_MS = 90_000;

function taskIsHandedToCloud(task) {
  return !!(task?.cloudHandoff && (
    task.cloudHandoff.machineId
    || ['starting', 'running', 'stopping'].includes(task.cloudHandoff.state)
  ));
}

function runnerAcceptsCommand(cmd) {
  if (cmd?.type === 'snapshot' && RUNNER_KIND === 'desktop') {
    return !listTasks().some((summary) => {
      const task = getTask(summary.id);
      return task?.cloudHandoff?.state === 'running' && !!task.cloudHandoff.machineId;
    });
  }
  if (cmd?.type !== 'run') return true;
  if (RUNNER_KIND === 'cloud') return !!CLOUD_TASK_ID && cmd.taskId === CLOUD_TASK_ID;
  let task = null;
  try { task = getTask(cmd.taskId); } catch { return false; }
  return !!task && !taskIsHandedToCloud(task);
}

function executionBlock(task) {
  if (RUNNER_KIND === 'cloud') {
    return task?.id === CLOUD_TASK_ID ? null : 'this cloud worker only runs its handed-off thread';
  }
  return taskIsHandedToCloud(task) ? 'this thread is running in Supreme Cloud' : null;
}

function taskWorkingDirectory(task) {
  return workspaceHandoff.runtimeWorkspacePath(task);
}

// ---------------------------------------------------------------------------
// helpers

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

async function localProjectRoot(project, { portableFallback = false } = {}) {
  if (!project) return null;
  const syncedPath = await repoRoot(project.path);
  if (syncedPath) return syncedPath;
  if (!project.managed && !portableFallback) return null;

  // A legacy project may have arrived from another computer as an unmanaged
  // absolute path. Promote that logical record in place, preserving its path
  // (a legacy grouping fallback) while giving this Mac a hidden local backing
  // repo. New and migrated workstreams bind through the stable project id.
  const repos = listRepos();
  const stored = repos.find((candidate) => project.id && candidate.id === project.id)
    || repos.find((candidate) => candidate.path === project.path);
  const id = stableProjectId(stored || project);
  let changed = false;
  if (stored && stored.id !== id) { stored.id = id; changed = true; }
  if (stored && portableFallback && !stored.managed) { stored.managed = true; changed = true; }
  if (!project.id) project.id = id;
  if (portableFallback) project.managed = true;
  if (changed) saveRepos(repos);
  return createManagedProject({ name: project.name, id: project.id });
}

async function localizeProjects() {
  // Materialize active projects eagerly when the rail loads. This is small
  // local metadata (one empty git repo per project), not a copy of another
  // Mac's filesystem. Failures stay isolated to the affected project and the
  // task-creation path will surface a useful error if the user opens it.
  for (const project of listRepos()) {
    if (project?.archived) continue;
    try { await localProjectRoot(project, { portableFallback: true }); } catch (err) {
      console.error(`[projects] could not localize ${project?.name || project?.path || 'project'}:`, err.message);
    }
  }
  return listRepos();
}

// Once a winner is chosen, the source tab gets a compact receipt + the winning
// answer, while the Duel itself becomes an ordinary tab. Keeping that tab is
// important: it gives the chosen output the normal composer, model picker,
// rename, split, and archive controls instead of turning the comparison into a
// dead-end review screen.
function settlePickedDuelTab(task, duelTab) {
  const duel = duelTab?.duel;
  const tabs = task?.tabs || [];
  if (!duel?.duelId || !['a', 'b'].includes(duel.choice)) return false;
  const source = tabs.find((candidate) => candidate.id === duel.sourceTabId && candidate.id !== duelTab.id);
  if (!source) return false;

  source.messages = source.messages || [];
  source.duels = source.duels || [];
  const existing = source.duels.find((candidate) => candidate.duelId === duel.duelId);
  const pickedAt = duel.pickedAt || new Date().toISOString();
  const selected = duel.choice === 'a' ? duel.a : duel.b;

  if (!existing) {
    source.duels.push({
      ...duel,
      phase: 'picked',
      winnerSide: duel.winnerSide || duel.choice,
      pickedAt,
      sourceTabId: source.id,
      duelTabId: duelTab.id,
      atMessageCount: source.messages.length,
    });
    source.messages.push({
      role: 'user',
      content: String(duel.prompt || ''),
      ts: duel.completedAt || pickedAt,
      hiddenInTranscript: true,
      fromDuel: duel.duelId,
    });
    source.messages.push({
      role: 'assistant',
      content: String(selected?.text || ''),
      model: selected?.model,
      ok: selected?.ok !== false,
      ts: pickedAt,
      fromDuel: duel.duelId,
    });
  }

  duelTab.messages = duelTab.messages || [];
  if (!duelTab.messages.some((message) => message.fromDuel === duel.duelId)) {
    duelTab.messages.push({
      role: 'user',
      content: String(duel.prompt || ''),
      ts: duel.completedAt || pickedAt,
      fromDuel: duel.duelId,
    });
    duelTab.messages.push({
      role: 'assistant',
      content: String(selected?.text || ''),
      model: selected?.model,
      ok: selected?.ok !== false,
      ts: pickedAt,
      fromDuel: duel.duelId,
    });
  }

  duelTab.duel.phase = 'picked';
  duelTab.duel.winnerSide = duel.winnerSide || duel.choice;
  duelTab.duel.pickedAt = pickedAt;
  duelTab.duel.duelTabId = duelTab.id;
  delete duelTab.type;
  if (selected?.model) duelTab.model = selected.model;
  duelTab.status = selected?.ok === false ? 'error' : 'done';
  if (source.status !== 'running') source.status = selected?.ok === false ? 'error' : 'done';
  task.activeTab = duelTab.id;
  return true;
}

function settleLegacyPickedDuelTabs(task) {
  if (!task) return false;
  let changed = false;
  for (const tab of [...(task.tabs || [])]) {
    if (tab.type === 'duel' && tab.duel?.choice && settlePickedDuelTab(task, tab)) changed = true;
  }
  return changed;
}

function andList(names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function taskForClient(task) {
  return team.decorateTask(taskForClientBase(task));
}

// A tab with nothing in it: no turn, no run, nothing queued, no Duel, and not
// marked Done (Done is a deliberate bookend, it keeps its row). Closing one
// deletes it instead of archiving it, and any such row already parked from
// before is dropped at boot. The tombstone is the same one a permanent delete
// leaves, so a shared thread's merge cannot bring the tab back.
function emptyTab(tab) {
  if (!tab || typeof tab !== 'object') return false;
  if ((tab.messages || []).length || tab.activeRun || (tab.queue || []).length) return false;
  if (tab.type === 'duel' || tab.duel || (tab.duels || []).length || tab.done) return false;
  return true;
}

function tombstoneTab(task, tabId) {
  task.deletedTabs = [
    ...(task.deletedTabs || []).filter((row) => row.id !== tabId),
    { id: tabId, at: new Date().toISOString() },
  ].slice(-200);
}

function pruneEmptyArchivedTabs() {
  let dropped = 0;
  for (const summary of listTasks()) {
    if (!(summary.archivedTabCount > 0)) continue;
    const task = getTask(summary.id);
    if (!task) continue;
    const keep = [];
    for (const tab of task.archivedTabs || []) {
      if (!emptyTab(tab)) { keep.push(tab); continue; }
      tombstoneTab(task, tab.id);
      removeTabImageAttachments(task.id, tab.id);
      dropped += 1;
    }
    if (keep.length === (task.archivedTabs || []).length) continue;
    task.archivedTabs = keep;
    saveTask(task);
  }
  if (dropped) console.info(`[tabs] dropped ${dropped} empty archived tab${dropped === 1 ? '' : 's'}`);
}

function taskForClientBase(task) {
  if (!task) return task;
  // A cloud hydrate can restore an older activeRun after the one-time boot
  // reconciliation has already happened. Repair that impossible state when
  // the thread is next read so cross-device sync cannot leave a phantom
  // working indicator behind indefinitely.
  reconcileTaskRuntimeState(task, ORPHANED_RUN_MESSAGE);
  const out = JSON.parse(JSON.stringify(task));
  // Compatibility for an older task read before the durable boot migration.
  settleLegacyPickedDuelTabs(out);
  // A retired model shows as the one its next turn runs on.
  if (out.model) out.model = currentModelNow(out.model);
  for (const tab of out.tabs || []) if (tab.model) tab.model = currentModelNow(tab.model);
  // Rehydrate a live run from the server's event buffer. The persisted
  // snapshot is intentionally throttled, while this view is always current.
  for (const run of runs.values()) {
    if (run.taskId !== out.id) continue;
    const tab = (out.tabs || []).find((candidate) => candidate.id === run.tabId);
    if (!tab || tab.status !== 'running') continue;
    tab.activeRun = { ...runPublic(run), prompt: run.prompt, prompts: run.prompts || [run.prompt], active: true };
  }
  for (const tab of out.tabs || []) tab.contextMeter = contextMeterFor(out, tab);
  // Connected tabs: the map read whole, every live tab a card, names current.
  // Read the hidden own tabs before the stored map gives way to the public one.
  out.mapHiddenTabs = hiddenOwnTabs(out).map((tab) => ({ id: tab.id, name: tab.name || 'Untitled' }));
  out.map = mapPublic(out, getTask);
  for (const tab of [...(out.tabs || []), ...(out.archivedTabs || [])]) {
    if (tab.activeRun?.attachments?.length) {
      tab.activeRun.attachments = publicImageAttachments(tab.activeRun.attachments, out.id, tab.id);
    }
    if (tab.type === 'duel' && tab.duel) {
      // Older persisted picks may still carry type:"duel". Present them as
      // ordinary tabs immediately so every normal tab control is available.
      if (tab.duel.choice) {
        delete tab.type;
      } else {
        tab.model = 'contenders';
        delete tab.duel.models;
        if (tab.duel.a) delete tab.duel.a.model;
        if (tab.duel.b) delete tab.duel.b.model;
      }
    }
    // Older runs predate structured cross-platform receipts. Derive a safe,
    // conservative receipt at read time so existing completed work gets the
    // same UI without rewriting the user's saved transcript.
    for (const message of tab.messages || []) {
      if (message.attachments?.length) {
        message.attachments = publicImageAttachments(message.attachments, out.id, tab.id);
      }
      if (message.role === 'assistant') {
        const outputImages = publicOutputImages(message.content, out.id, tab.id);
        if (outputImages.length) message.outputImages = outputImages;
        // An answer saved before Supreme lifted Codex's suggested next asks
        // reads without them; the saved transcript is left as it was.
        if (String(message.content || '').includes(':codex-followup[')) {
          const taken = takeFollowups(message.content);
          message.content = taken.content;
          if (taken.followups.length && !message.followups) message.followups = taken.followups;
        }
        const outsideTouches = outsideTouchesForMessage(message, out, tab);
        if (outsideTouches.length) message.outsideTouches = outsideTouches;
        if (!message.confirmation) {
          const confirmation = confirmationRequest(message.content);
          if (confirmation) message.confirmation = confirmation;
        } else if (!message.confirmation.emailHandoff && !confirmationRequest(message.content)) {
          // The detector learned better (a question inside a quoted draft is
          // not an ask): stale stamps clear on read.
          delete message.confirmation;
        }
      }
    }
  }
  return out;
}

// Estimated fullness of a tab's context window, computed on the way out of
// every task read. Estimates only (chars/4, flat per-image cost, the ~100k
// connector-schema figure documented at createTask) — the UI labels them so.
// Bands (Paper section 12): the chip stays hidden under METER_SHOW_PCT, fills
// in ink blue, and turns clay red with "Almost full" written out from
// METER_FULL_PCT. Both thresholds are open for redline; change them only here.
const CONNECTOR_SCHEMA_TOKENS = 100_000;
const IMAGE_TOKENS = 1_600;
const METER_SHOW_PCT = 50;
const METER_FULL_PCT = 85;
// Auto-contextualize (Paper 12.2 to 12.4): a tab folds its older turns on
// its own, never mid run. Settle folds after a landing once the window is
// this full; admission folds before a run starts when the projection says
// the run would not fit; a fold aims to leave the window at the target.
const FOLD_SETTLE_PCT = Number(process.env.WB_FOLD_SETTLE_PCT) || 60;
const FOLD_ADMIT_PCT = Number(process.env.WB_FOLD_ADMIT_PCT) || 80;
const FOLD_TARGET_PCT = Number(process.env.WB_FOLD_TARGET_PCT) || 40;
const FOLD_FACTS_KEEP = 120;

// What the provider itself said the last turn cost. This includes the tool
// schemas and every tool result (the Gmail threads read, the pages pulled),
// which the text estimate cannot see and which are most of a real context.
// Claude reports cache reads and creation apart from input; Codex folds
// cached tokens into input.
function measuredTurnTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const prompt = n(usage.input_tokens ?? usage.inputTokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
  const output = n(usage.output_tokens ?? usage.outputTokens);
  if (prompt <= 0) return null;
  return { prompt, output, total: prompt + output };
}

// What stands in for the folded turns in the model's window: the active
// fold's narrative and facts, else the briefing's rolling summary (the
// pre-fold behaviour for a long replay).
function projectionSummary(tab) {
  const fold = activeFold(tab);
  return fold ? foldSummaryText(fold) : (tab.summary?.text || null);
}

function contextMeterFor(task, tab) {
  const pinned = tab.model === 'recommended' || tab.model === 'contenders' ? task.model : tab.model;
  const model = resolveModel(pinned) || resolveModel(task.model);
  const windowTokens = modelContextWindow(model);
  const messages = tab.messages || [];
  // After "Sum up older messages" the model holds the rolling summary plus
  // every turn from the kept tail onward; the folded turns are out of the
  // window even though they stay in the saved transcript (replayPlan).
  const projection = projectionSummary(tab);
  const keptFrom = tab.compaction && projection
    ? Math.min(Math.max(0, Number(tab.compaction.keptFrom) || 0), messages.length)
    : 0;
  let conversationChars = keptFrom ? projection.length : 0;
  let images = 0;
  for (const message of messages.slice(keptFrom)) {
    conversationChars += String(message.content || '').length;
    images += (message.attachments || []).length;
  }
  const parts = {
    // Codex models don't carry claude.ai connector schemas (browser toolset
    // instead); an unresolved model is treated as claude, the common default.
    connectors: task.connectors !== false && (model?.provider ?? 'claude') === 'claude'
      && !(tab.connectorScope && (tab.connectorScope.keys || []).length === 0) ? CONNECTOR_SCHEMA_TOKENS : 0,
    conversation: Math.ceil(conversationChars / 4),
    attachments: images * IMAGE_TOKENS,
    briefing: (task.tabs || []).length > 1 ? Math.ceil((workstreamBriefing(task, tab.id)?.body.length || 0) / 4) : 0,
  };
  let usedTokens = parts.connectors + parts.conversation + parts.attachments + parts.briefing;
  let source = 'estimated';
  // Prefer the last landed turn's own accounting (after any sum-up), plus a
  // text estimate for whatever was said since. A measured prompt smaller than
  // the text it must contain is not a real measurement (fixtures, a provider
  // that reports nothing useful) and the estimate stands.
  // A measurement taken before the last Sum up is stale: it still counts the
  // folded turns and the schemas that were just set aside, which made the
  // button look like it did nothing. The estimate stands until a turn runs
  // under the trimmed context and measures the real, smaller prompt.
  const trimmedAt = Math.max(
    Date.parse(tab.compaction?.at || '') || 0,
    Date.parse(tab.connectorScope?.at || '') || 0,
  );
  for (let index = messages.length - 1; index >= keptFrom; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (trimmedAt && (Date.parse(message.ts || '') || 0) < trimmedAt) break;
    const measured = measuredTurnTokens(message.usage);
    if (!measured) continue;
    const textSoFar = Math.ceil(messages.slice(keptFrom, index + 1).reduce((total, item) => total + String(item.content || '').length, 0) / 4);
    if (measured.prompt < textSoFar) break;
    const since = Math.ceil(messages.slice(index + 1).reduce((total, item) => total + String(item.content || '').length, 0) / 4);
    usedTokens = measured.total + since;
    source = 'measured';
    // The stack in the popover: the app schemas are a real, fixed part of a
    // measured prompt; everything else is the conversation and its tools.
    parts.conversation = Math.max(0, usedTokens - parts.connectors);
    parts.attachments = 0;
    parts.briefing = 0;
    break;
  }
  const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
  const band = pct >= METER_FULL_PCT ? 'full' : pct >= METER_SHOW_PCT ? 'filling' : 'hidden';
  return {
    usedTokens,
    windowTokens,
    pct,
    band,
    source,
    parts,
    summedUp: tab.compaction ? { messages: Number(tab.compaction.elided) || 0, at: tab.compaction.at } : null,
  };
}

// Keep context mentions readable in the saved transcript while giving the
// selected blocks to the model for that turn. The bracketed token is stable
// for names with spaces and is generated by both context pickers in the UI.
function promptWithContextBlocks(task, prompt, pickedNames = []) {
  const withSavedPlatformContext = (value) => savedPlatformContextPrompt(value, getSettings().platformContexts, currentPlatformDefinitions());
  // Project-scoped blocks first so they win name collisions in byName below;
  // task-level blocks are legacy (pre repo scoping) but stay addressable.
  const blocks = [
    ...repoContextBlocks(task && task.repo),
    ...(Array.isArray(task && task.contextBlocks) ? task.contextBlocks : []),
  ];
  // Paper 21.2b: a context picked from the @ menu arrives as a chip name in
  // body.contextMentions, not as a token in the text; both address a block.
  const picked = (Array.isArray(pickedNames) ? pickedNames : [])
    .map((name) => String(name || '').trim()).filter(Boolean).slice(0, 12);
  if (!blocks.length || (!picked.length && !String(prompt || '').includes('@['))) return withSavedPlatformContext(String(prompt || ''));
  const byName = new Map();
  for (const block of blocks) {
    const key = String(block.name || '').trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, block);
  }
  const selected = [];
  const seen = new Set();
  const takeName = (name) => {
    const block = byName.get(String(name).toLowerCase());
    if (block && !seen.has(block.id || String(name).toLowerCase())) {
      seen.add(block.id || String(name).toLowerCase());
      selected.push(block);
    }
  };
  for (const name of picked) {
    if (selected.length >= 12) break;
    takeName(name);
  }
  for (const match of String(prompt).matchAll(/@\[((?:\\.|[^\]]){1,240})\]/g)) {
    if (selected.length >= 12) break;
    takeName(match[1].replace(/\\(.)/g, '$1').trim());
  }
  if (!selected.length) return withSavedPlatformContext(String(prompt || ''));
  let remaining = 60000;
  const sections = [];
  for (const block of selected) {
    if (remaining <= 0) break;
    const content = String(block.content || '').slice(0, remaining);
    remaining -= content.length;
    sections.push(`## ${String(block.name || 'Context block')}\n${content}`);
  }
  return withSavedPlatformContext([
    'The user explicitly referenced these Workbench context blocks. Use them as relevant context for this turn.',
    '<workbench_context_blocks>',
    sections.join('\n\n'),
    '</workbench_context_blocks>',
    '',
    'User message:',
    String(prompt || ''),
  ].join('\n'));
}

function orderedPromptBatch(task, values, pickedContextNames = []) {
  const prompts = (Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!prompts.length) return { prompts: [], prompt: '', modelPrompt: '' };
  if (prompts.length === 1) {
    return { prompts, prompt: prompts[0], modelPrompt: promptWithContextBlocks(task, prompts[0], pickedContextNames) };
  }
  const prompt = prompts.map((value, index) => `Message ${index + 1}:\n${value}`).join('\n\n');
  return {
    prompts,
    prompt,
    modelPrompt: [
      'The user sent these messages while you were working. Read them as one ordered follow-up batch.',
      'Address the full batch in this turn. Later messages may refine or add to earlier messages.',
      '',
      promptWithContextBlocks(task, prompt, pickedContextNames),
    ].join('\n'),
  };
}

function publicTerminalContexts(contexts) {
  return (Array.isArray(contexts) ? contexts : []).map((context) => ({
    id: context.id,
    sourceTaskId: context.sourceTaskId,
    sourceTabId: context.sourceTabId,
    sourceProject: context.sourceProject,
    sourceThread: context.sourceThread,
    sourceTab: context.sourceTab,
    guidance: context.guidance,
    messageCount: context.messageCount,
    charCount: context.charCount,
    tokenEstimate: context.tokenEstimate,
    capturedAt: context.capturedAt,
    fileName: context.fileName,
  }));
}

// Resolve browser drag payloads on the backend: the renderer only supplies
// source task/tab IDs, never transcript text or a filesystem path. This keeps
// large transcripts out of DataTransfer and lets a cloud runner materialize
// the same source from the synced thread document in its own private data dir.
function prepareTerminalContexts(values, targetTaskId, targetTabId, fallbackGuidance) {
  const requested = Array.isArray(values) ? values.slice(0, 8) : [];
  const contexts = [];
  const seen = new Set();
  for (const value of requested) {
    const sourceTaskId = String(value?.sourceTaskId || value?.threadId || '').trim();
    const sourceTabId = String(value?.sourceTabId || value?.tabId || '').trim();
    if (!sourceTaskId || !sourceTabId) throw new Error('shared terminal context is missing its source');
    const key = `${sourceTaskId}:${sourceTabId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sourceTaskId === targetTaskId && sourceTabId === targetTabId) {
      throw new Error('a tab already has its own transcript');
    }

    let sourceTask = null;
    try { sourceTask = getTask(sourceTaskId); } catch { sourceTask = null; }
    if (!sourceTask) throw new Error('the shared source thread no longer exists');
    const sourceTab = [...(sourceTask.tabs || []), ...(sourceTask.archivedTabs || [])]
      .find((candidate) => candidate.id === sourceTabId);
    if (!sourceTab) throw new Error('the shared source tab no longer exists');

    const liveRun = [...runs.values()].find((run) => run.taskId === sourceTaskId && run.tabId === sourceTabId);
    const activeRun = liveRun
      ? { ...runPublic(liveRun), prompt: liveRun.prompt }
      : sourceTab.activeRun || null;
    const written = writeTerminalTranscript({ dataDir: DATA_DIR, task: sourceTask, tab: sourceTab, activeRun });
    const guidance = String(value?.guidance || fallbackGuidance || '').trim().slice(0, 12_000);
    contexts.push({
      ...written,
      sourceTaskId,
      sourceTabId,
      sourceProject: String(sourceTask.repoName || sourceTask.repo || 'Project').slice(0, 160),
      sourceThread: String(sourceTask.title || 'Thread').slice(0, 160),
      sourceTab: String(sourceTab.name || 'Tab').slice(0, 160),
      guidance,
    });
  }
  return contexts;
}

// Some runs fail because the account cannot use a model at all — the plan does
// not include it, or the provider wants updated terms accepted first. Those
// failures are remembered so Duels stop proposing the model and the next run
// fails fast with the fix instead of replaying a whole transcript into a wall.
const NOTICE_BLOCK_MS = 30 * 60 * 1000; // fail runs fast this long after the failure
const NOTICE_AVOID_MS = 24 * 60 * 60 * 1000; // keep the model out of Duel defaults this long

function classifyAccountFailure(text) {
  const value = String(text || '');
  if (!value) return null;
  if (/updated .{0,20}terms|accept .{0,30}terms|terms (?:of service|acceptance)/i.test(value)) {
    return {
      kind: 'terms',
      message: 'The provider needs you to accept its updated terms. Open Terminal, start the model\'s app once (for Claude, type `claude`), accept the terms, then try again.',
    };
  }
  if (/not supported|not available (?:on|for) (?:your|this)|model_not_(?:found|supported)|unsupported model|does not have access to (?:the|this) model/i.test(value)) {
    return { kind: 'model-unsupported', message: 'This account\'s plan cannot run that model. Pick a different model.' };
  }
  // A plan that lacks credits for a model is an account failure, not a
  // transient one: Duel kept proposing Fable to a Claude Pro account because
  // "requires usage credits" matched nothing here (E2E 2026-09-01), so the
  // 24-hour contender exclusion never triggered. Transient rate limits and
  // overload stay out of this — they resolve on their own.
  if (/requires? (?:usage )?credits|out of credits|insufficient credits|credit balance is too low|usage limit reached|quota exceeded for (?:your|this) (?:plan|account)/i.test(value)) {
    return { kind: 'plan-limit', message: 'This account cannot run that model without usage credits. Pick a different model, or add credits with the provider.' };
  }
  if (/401\s+unauthorized|missing bearer|invalid[ _]api[ _]key|token (?:has been )?(?:revoked|expired)|not logged in|no credentials found|please (?:log|sign) ?in|run `?codex login|oauth token (?:revoked|expired)/i.test(value)) {
    return { kind: 'signed-out', message: 'The model\'s account signed you out. Open Models, reconnect it, then hit Send again.' };
  }
  return null;
}

function accountNoticeStore(settings = getSettings()) {
  return settings.accountNotices && typeof settings.accountNotices === 'object' ? settings.accountNotices : {};
}

function recordAccountNotice(model, failureText) {
  const found = classifyAccountFailure(failureText);
  if (!found || !model) return null;
  const settings = getSettings();
  const notices = accountNoticeStore(settings);
  const key = found.kind === 'terms' ? `provider:${model.provider}` : `model:${model.id}`;
  notices[key] = { kind: found.kind, message: found.message, model: model.id, provider: model.provider, at: new Date().toISOString() };
  settings.accountNotices = notices;
  saveSettings(settings);
  return notices[key];
}

function clearAccountNotices(scope) {
  const settings = getSettings();
  const notices = accountNoticeStore(settings);
  const keys = typeof scope === 'string'
    ? [`provider:${scope}`]
    : [`provider:${scope.provider}`, `model:${scope.id}`];
  let changed = false;
  for (const key of keys) {
    if (notices[key]) { delete notices[key]; changed = true; }
  }
  if (changed) {
    settings.accountNotices = notices;
    saveSettings(settings);
  }
}

function activeAccountNotice(modelId, maxAgeMs) {
  const model = resolveModel(modelId);
  if (!model) return null;
  const notices = accountNoticeStore();
  const notice = notices[`model:${model.id}`] || notices[`provider:${model.provider}`] || null;
  if (!notice) return null;
  const age = Date.now() - Date.parse(notice.at || 0);
  return Number.isFinite(age) && age <= maxAgeMs ? notice : null;
}

// Each recorded failure buys exactly one fast-fail warning: the first send
// after it returns the fix instantly (no transcript replay burned), and the
// next send genuinely retries. A repeat failure re-arms the warning.
function consumeAccountNoticeWarning(modelId) {
  const model = resolveModel(modelId);
  if (!model) return null;
  const settings = getSettings();
  const notices = accountNoticeStore(settings);
  const key = notices[`model:${model.id}`] ? `model:${model.id}` : notices[`provider:${model.provider}`] ? `provider:${model.provider}` : null;
  if (!key) return null;
  const notice = notices[key];
  const age = Date.now() - Date.parse(notice.at || 0);
  if (!Number.isFinite(age) || age > NOTICE_BLOCK_MS || notice.warnedAt) return null;
  notice.warnedAt = new Date().toISOString();
  settings.accountNotices = notices;
  saveSettings(settings);
  return notice;
}

// The prototype's out-of-the-box faceoff is the strongest cross-family pair.
// Keep the choice on the server so inspecting browser state cannot reveal it.
// Contenders must be models this account can actually run: provider connected,
// and no recent account-capability failure on record.
function defaultDuelModels(sourceModelId) {
  const status = probeStatus();
  const usable = (model) => !!model && !!status.providers?.[model.provider]?.ready && !activeAccountNotice(model.id, NOTICE_AVOID_MS);
  const pool = MODELS.filter((model) => !model.retired && usable(model));
  const preferred = ['fable', 'gpt-6.1-sol'].map(resolveModel).filter(usable);
  if (preferred.length === 2) return preferred;

  const source = resolveModel(sourceModelId);
  const first = usable(source) ? source : preferred[0] || pool[0];
  if (!first) return [];
  const other = pool.find((m) => m.id !== first.id && m.family !== first.family)
    || pool.find((m) => m.id !== first.id);
  return other ? [first, other] : [];
}

function operationId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(id) ? id : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let rejected = false;
    req.on('data', (d) => {
      if (rejected) return;
      buf += d;
      // Clipboard screenshots are base64-encoded in the JSON request. The
      // attachment layer applies tighter per-image and aggregate binary limits.
      if (buf.length > 36_000_000) {
        rejected = true;
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (rejected) return;
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  return (ev) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
}

function recordRunEvent(runId, ev) {
  const run = runs.get(runId) || recentRuns.get(runId);
  if (!run) return null;
  run.lastEventAt = Date.now();
  run.seq = (run.seq || 0) + 1;
  const clean = { ...ev };
  if (clean.type === 'computer' && ['unavailable', 'recovering', 'connected'].includes(clean.connection)) {
    // Retain the verdict even if later tool chatter evicts this event from
    // the bounded event ring. A shell diagnostic cannot clear a disconnect.
    run.browserConnection = { connection: clean.connection, step: clean.step, at: new Date().toISOString() };
  }
  if (clean.type === 'computer' && typeof clean.previewDataUrl === 'string') {
    const value = clean.previewDataUrl;
    if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(value) && value.length <= 12_000_000) {
      run.computerPreview = { dataUrl: value, seq: run.seq, at: new Date().toISOString() };
      clean.hasPreview = true;
    }
    delete clean.previewDataUrl;
  }
  const event = { ...clean, seq: run.seq, at: new Date().toISOString() };
  run.events = run.events || [];
  run.events.push(event);
  if (run.events.length > RUN_EVENT_LIMIT) run.events.splice(0, run.events.length - RUN_EVENT_LIMIT);
  const now = Date.now();
  // A 'status' event is Codex's reasoning stream, one per token chunk and
  // never shown as text; writing the whole workstream for each one meant a
  // 4MB file rewritten dozens of times a second. It and candidate-reset
  // ride the half-second snapshot below like the deltas do.
  const important = ['start', 'steer', 'pings', 'interim', 'tool', 'computer', 'connector', 'progress', 'stopped', 'error'].includes(event.type);
  const firstText = ['delta', 'candidate-delta'].includes(event.type) && !(run.persistedTextLength > 0);
  if (runs.has(runId) && (important || firstText || now - (run.lastPersistedAt || 0) >= 500)) {
    run.lastPersistedAt = now;
    const textLength = persistRunSnapshot(run);
    if (Number.isFinite(textLength)) run.persistedTextLength = textLength;
  }
  return event;
}

function finishRun(runId) {
  const run = runs.get(runId);
  if (!run) return;
  run.finishedAt = Date.now();
  delete run.controller;
  recentRuns.set(runId, run);
  runs.delete(runId);
  for (const [id, old] of recentRuns) {
    if (Date.now() - (old.finishedAt || old.startedAt) > RECENT_RUN_TTL_MS) recentRuns.delete(id);
  }
  refreshKeepAwake();
}

// A CLI process can remain alive after its transport or tool bridge has gone
// silent. Do not let that look like productive work forever. Fifteen minutes
// is deliberately well above normal browser pacing/tool gaps; tests can lower
// it through the private environment override above.
let idleCheckedAt = Date.now();
function stopUnresponsiveRuns() {
  const now = Date.now();
  // The Mac asleep is not a model gone quiet. The service now lives
  // through a nap (the loop watchdog above), so a nap longer than the idle
  // limit would otherwise end every run within a minute of waking. A gap
  // between checks that the interval cannot explain is sleep: every run's
  // clock moves forward by it.
  const gap = now - idleCheckedAt;
  idleCheckedAt = now;
  if (gap > RUN_WATCHDOG_INTERVAL_MS * 3 + 5_000) {
    for (const run of runs.values()) if (run.lastEventAt) run.lastEventAt += gap;
    console.info(`[runs] the Mac was asleep for ${Math.round(gap / 1000)}s; ${runs.size} run(s) get the time back`);
    return;
  }
  for (const run of runs.values()) {
    if (run.cancelled || run.idleTimedOut || run.paused) continue;
    if (now - (run.lastEventAt || run.startedAt || now) < RUN_IDLE_TIMEOUT_MS) continue;
    run.idleTimedOut = true;
    run.idleError = IDLE_RUN_MESSAGE;
    recordRunEvent(run.id, { type: 'error', message: IDLE_RUN_MESSAGE });
    run.controller?.abort();
  }
}

const runWatchdog = setInterval(stopUnresponsiveRuns, RUN_WATCHDOG_INTERVAL_MS);
runWatchdog.unref?.();

// Engage/release the macOS sleep-preventer based on the keepAwake setting and
// whether any run is in flight. Called on run start, run finish, boot, and when
// the setting changes.
function refreshKeepAwake() {
  const mode = getSettings().keepAwake || 'off'; // off | running | always
  if (mode === 'always' || (mode === 'running' && runs.size > 0)) keepawake.engage();
  else keepawake.release();
}

function publicToolActivity(event) {
  const name = String(event?.name || '').toLowerCase();
  // Classify the way the work happened before the destination it happened in.
  // A browser tool whose title mentions Notion/LinkedIn is still computer
  // control; checking the platform first made those calls look like connectors.
  if (/browser|chrome|computer|playwright/.test(name)) return { name: 'Computer control', kind: 'computer' };
  if (/linkedin/.test(name)) return { name: 'LinkedIn via Chrome', kind: 'computer' };
  if (/gmail|email/.test(name)) return { name: 'Email connector', kind: 'connector' };
  if (/notion/.test(name)) return { name: 'Notion connector', kind: 'connector' };
  if (/calendar/.test(name)) return { name: 'Calendar connector', kind: 'connector' };
  if (/websearch|webfetch|search/.test(name)) return { name: 'Web research', kind: 'research' };
  if (/read|glob|grep|shell|bash|exec|terminal|command/.test(name)) return { name: 'Local context', kind: 'context' };
  if (/write|edit|patch/.test(name)) return { name: 'File changes', kind: 'work' };
  return { name: 'Connected tool', kind: 'tool' };
}

function publicConnectorText(value, max) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:sed|grep|rg|cat|bash|zsh|powershell)\b|(?:^|\s)(?:\/Users\/|\/home\/|[A-Z]:\\)/i.test(text)) return '';
  return text.slice(0, max);
}

const PLATFORM_HOME = {
  Gmail: 'https://mail.google.com/mail/u/0/#inbox',
  LinkedIn: 'https://www.linkedin.com/messaging/',
  Notion: 'https://www.notion.so/',
  'Google Calendar': 'https://calendar.google.com/',
  'Google Drive': 'https://drive.google.com/',
  'Google Docs': 'https://docs.google.com/document/',
  'Google Sheets': 'https://docs.google.com/spreadsheets/',
  Smartlead: 'https://app.smartlead.ai/',
  Slack: 'https://app.slack.com/',
};

const PLATFORM_HOSTS = {
  Gmail: ['mail.google.com'],
  LinkedIn: ['linkedin.com'],
  Notion: ['notion.so', 'notion.com'],
  'Google Calendar': ['calendar.google.com'],
  'Google Drive': ['drive.google.com'],
  'Google Docs': ['docs.google.com'],
  'Google Sheets': ['docs.google.com'],
  Smartlead: ['smartlead.ai'],
  Slack: ['slack.com'],
};

function safePlatformUrl(platform, value, fallback = false) {
  const home = PLATFORM_HOME[platform] || '';
  if (!value) return fallback ? home : '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' || url.username || url.password) return fallback ? home : '';
    const allowed = PLATFORM_HOSTS[platform] || [];
    const hostname = url.hostname.toLowerCase();
    if (!allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return fallback ? home : '';
    return url.toString().slice(0, 2_000);
  } catch {
    return fallback ? home : '';
  }
}

// Raw events remain in the in-memory diagnostic buffer. Browser-facing SSE and
// task snapshots receive only safe activity labels—not commands, local paths,
// skill contents, provider session IDs, or reasoning summaries.
function publicRunEvent(event) {
  if (!event) return event;
  if (event.type === 'tool') {
    const { detail: _detail, ...rest } = event;
    return { ...rest, ...publicToolActivity(event) };
  }
  if (event.type === 'status') {
    // Supreme's own lines (`own`) are written here and say what happened; a
    // provider's are not shown as they came.
    if (event.own) return { type: 'status', own: true, text: String(event.text || '').slice(0, 200) };
    const text = /^stopping/i.test(String(event.text || '')) ? 'Interrupting…' : 'Working through the task…';
    return { ...event, text };
  }
  if (event.type === 'session') {
    const { id: _id, ...rest } = event;
    return rest;
  }
  if (event.type === 'computer') {
    const app = String(event.app || 'Chrome').slice(0, 48);
    return {
      type: 'computer',
      phase: ['step', 'paused', 'resumed', 'released', 'blocked', 'recovering', 'connected'].includes(event.phase) ? event.phase : 'step',
      ...(['unavailable', 'recovering', 'connected'].includes(event.connection) ? { connection: event.connection } : {}),
      surface: event.surface === 'Chrome' ? 'Chrome' : 'browser',
      app,
      step: String(event.step || 'Working in the browser').slice(0, 120),
      url: safePlatformUrl(app, event.url),
      hasPreview: !!event.hasPreview,
      seq: event.seq,
      at: event.at,
    };
  }
  if (event.type === 'connector') {
    const phase = ['start', 'complete', 'error', 'stopped'].includes(event.phase) ? event.phase : 'start';
    const action = ['listen', 'read', 'search', 'create', 'update', 'draft', 'send', 'schedule', 'connect', 'publish', 'upload', 'delete', 'use'].includes(event.action) ? event.action : 'use';
    const count = Number.isFinite(Number(event.count)) && Number(event.count) >= 0 ? Math.min(Number(event.count), 1_000_000) : null;
    const connector = publicConnectorText(event.connector || 'Connected tool', 40);
    return {
      type: 'connector',
      id: publicConnectorText(event.id || `connector-${event.seq || 0}`, 96),
      phase,
      connector,
      action,
      detail: publicConnectorText(event.detail, 72),
      account: publicConnectorText(event.account, 64),
      outcome: publicConnectorText(event.outcome, 64),
      count,
      unit: publicConnectorText(event.unit, 20),
      url: safePlatformUrl(connector, event.url),
      seq: event.seq,
      at: event.at,
    };
  }
  return event;
}

function computerPublic(run, finalState = null) {
  if (!run) return null;
  const source = (run.events || []).filter((event) => event.type === 'computer');
  if (!source.length) return null;
  const steps = [];
  for (const event of source) {
    const safe = publicRunEvent(event);
    const last = steps[steps.length - 1];
    if (last && last.step === safe.step && last.phase === safe.phase) continue;
    steps.push({ at: safe.at, step: safe.step, phase: safe.phase });
  }
  const latest = publicRunEvent(source[source.length - 1]);
  const specificApp = [...source].reverse().map((event) => publicRunEvent(event).app).find((app) => app && app !== 'Chrome');
  const health = run.browserConnection || [...source].reverse().find(event => event.connection);
  const connection = health?.connection === 'recovering' && (finalState || run.finishedAt) ? 'unavailable' : health?.connection;
  let state = finalState || (run.paused ? 'paused' : latest.phase === 'released' ? 'released' : run.finishedAt ? 'done' : 'active');
  if (connection === 'unavailable' && state !== 'stopped') state = 'error';
  if (!['active', 'paused', 'released', 'done', 'stopped', 'error'].includes(state)) state = 'active';
  return {
    runId: run.id,
    state,
    ...(connection ? { connection } : {}),
    surface: latest.surface,
    app: specificApp || latest.app || 'Chrome',
    startedAt: publicRunEvent(source[0]).at || new Date(run.startedAt).toISOString(),
    updatedAt: latest.at,
    currentStep: connection === 'unavailable' || connection === 'recovering' ? String(health?.step || latest.step).slice(0, 120) : state === 'paused' ? 'Waiting for you' : latest.step,
    steps: steps.slice(-12),
    hasPreview: !!run.computerPreview && (!connection || connection === 'connected'),
    previewSeq: run.computerPreview?.seq || null,
  };
}

function connectorsPublic(run, finalState = null) {
  if (!run) return [];
  const source = (run.events || []).filter((event) => event.type === 'connector');
  if (!source.length) return [];
  const activities = new Map();
  for (const event of source) {
    const safe = publicRunEvent(event);
    const prior = activities.get(safe.id);
    let state = safe.phase === 'complete' ? 'done' : safe.phase === 'error' ? 'error' : safe.phase === 'stopped' ? 'stopped' : 'active';
    if (state === 'active' && finalState) state = finalState === 'error' ? 'error' : finalState === 'stopped' ? 'stopped' : 'done';
    activities.set(safe.id, {
      id: safe.id,
      connector: safe.connector,
      action: safe.action,
      state,
      detail: safe.detail || prior?.detail || '',
      account: safe.account || prior?.account || '',
      outcome: safe.outcome || prior?.outcome || '',
      count: safe.count ?? prior?.count ?? null,
      unit: safe.unit || prior?.unit || '',
      url: safe.url || prior?.url || '',
      startedAt: prior?.startedAt || safe.at,
      updatedAt: safe.at,
    });
  }
  if (run.finishedAt && !finalState) {
    for (const activity of activities.values()) {
      if (activity.state === 'active') activity.state = 'done';
    }
  }
  return [...activities.values()].slice(-12);
}

const MUTATING_CONNECTOR_ACTIONS = new Set(['create', 'update', 'draft', 'send', 'schedule', 'connect', 'publish', 'upload', 'delete']);
const COUNT_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);
const COUNT_TOKEN = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

function touchCount(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) return Math.min(number, 1_000_000);
  return COUNT_WORDS.get(String(value).toLowerCase()) ?? null;
}

function touchAccount(task, tab, platform, text = '') {
  if (platform !== 'LinkedIn') return '';
  const named = String(text).match(/\bsent from\s+([A-Z][A-Za-z.'’ -]{1,48}?)(?=\s+with\b|\s*:|\s*\n|\s*\.|$)/i)?.[1]?.trim();
  if (named) return `${named}${/s$/i.test(named) ? '’' : '’s'} account`;
  const tabName = String(tab?.name || '').trim();
  if (tabName && !/^(?:main|same context|new tab|duel|linkedin test)$/i.test(tabName)) {
    return `${tabName}${/s$/i.test(tabName) ? '’' : '’s'} account`;
  }
  return '';
}

function defaultTouchUnit(action, platform) {
  if (action === 'draft') return platform === 'Gmail' ? 'reply' : 'draft';
  if (action === 'send') return platform === 'Gmail' ? 'email' : platform === 'LinkedIn' ? 'message' : 'item';
  if (action === 'connect') return 'connection request';
  if (action === 'update') return platform === 'Notion' ? 'row' : 'item';
  if (action === 'schedule') return 'event';
  if (action === 'publish') return 'post';
  if (action === 'upload') return 'file';
  return 'item';
}

function connectorTouches(activities, task, tab) {
  const touches = [];
  for (const activity of activities || []) {
    if (!MUTATING_CONNECTOR_ACTIONS.has(activity.action) || activity.state !== 'done') continue;
    touches.push({
      id: `connector:${activity.id}`,
      source: 'connector',
      platform: activity.connector,
      action: activity.action,
      state: 'done',
      count: activity.count ?? null,
      unit: activity.unit || defaultTouchUnit(activity.action, activity.connector),
      account: activity.account || touchAccount(task, tab, activity.connector),
      detail: activity.detail || '',
      outcome: activity.outcome || (activity.action === 'draft' ? 'nothing sent' : ''),
      url: safePlatformUrl(activity.connector, activity.url, true),
    });
  }
  return touches;
}

function computerTouch(event, task, tab) {
  const safe = publicRunEvent(event);
  const platform = safe.app;
  const step = String(safe.step || '').toLowerCase();
  let action = null;
  if (platform === 'LinkedIn') {
    if (/(?:send|sent|sending|submit|submitted).{0,28}(?:connection request|invite)|(?:connection request|invite).{0,28}(?:send|sent|sending|submit|submitted)/.test(step)) action = 'connect';
    else if (/\b(?:send|sent|sending|replied|replying|submitted)\b/.test(step)) action = 'send';
    else if (/(?:publish|post|comment|follow|like)/.test(step)) action = 'publish';
  } else if (platform === 'Gmail') {
    if (/draft|compose/.test(step)) action = 'draft';
    else if (/\b(?:send|sent|sending|replied|replying|forwarded|forwarding)\b/.test(step)) action = 'send';
  } else if (platform === 'Notion') {
    if (/update|updated|edit|edited|write|wrote|save|saved|create|created|add|added/.test(step)) action = /create|created|add|added/.test(step) ? 'create' : 'update';
  } else if (platform === 'Google Calendar') {
    if (/schedule|scheduled|create|created|book|booked|invite|invited/.test(step)) action = 'schedule';
  } else if (/Google Drive|Google Docs|Google Sheets/.test(platform)) {
    if (/upload|uploaded|import|imported/.test(step)) action = 'upload';
    else if (/update|updated|edit|edited|write|wrote|save|saved|create|created/.test(step)) action = /create|created/.test(step) ? 'create' : 'update';
  } else if (platform === 'Smartlead') {
    if (/queue|queued|send|sent|launch|launched/.test(step)) action = 'send';
  }
  if (!action) return null;
  return {
    id: `computer:${platform}:${action}:${event.seq || 0}`,
    source: 'computer',
    platform,
    action,
    state: 'done',
    count: 1,
    unit: defaultTouchUnit(action, platform),
    account: touchAccount(task, tab, platform),
    detail: '',
    outcome: /confirm|sent|saved|updated|created|scheduled|published|queued/.test(step) ? 'confirmed' : '',
    url: safePlatformUrl(platform, safe.url, true),
  };
}

function computerTouches(events, task, tab) {
  return (events || []).filter((event) => event.type === 'computer').map((event) => computerTouch(event, task, tab)).filter(Boolean);
}

function countMatch(text, expressions) {
  for (const expression of expressions) {
    const match = String(text).match(expression);
    const count = touchCount(match?.[1]);
    if (count != null) return count;
  }
  return null;
}

function inferredTouches(text, task, tab) {
  const value = String(text || '');
  if (!value) return [];
  const touches = [];

  if (/\bLinkedIn\b/i.test(value)) {
    let count = countMatch(value, [
      /(\d+)\s*\/\s*\d+\s+(?:provider-)?confirmed\s+(?:sends|messages|connection requests?)/i,
      new RegExp(`\\b${COUNT_TOKEN}\\s+(?:approved\\s+)?messages?\\s+(?:are\\s+|were\\s+)?(?:now\\s+)?(?:visible|sent|delivered)`, 'i'),
    ]);
    if (count == null && /LinkedIn[^.]{0,100}\bconfirmed\b[^.]{0,80}\bsent\b|\bsent\b[^.]{0,100}\bLinkedIn\b[^.]{0,80}\bconfirmed/i.test(value)) count = 1;
    if (count != null && count > 0) {
      const action = /connection requests?|(?:sent|sending)\s+\d+\s+connections?/i.test(value) ? 'connect' : 'send';
      touches.push({
        id: `text:LinkedIn:${action}`,
        source: 'text', platform: 'LinkedIn', action, state: 'done', count,
        unit: defaultTouchUnit(action, 'LinkedIn'),
        account: touchAccount(task, tab, 'LinkedIn', value), detail: '',
        outcome: /\bconfirmed\b/i.test(value) ? 'confirmed' : '',
      });
    }
  }

  const crmCount = countMatch(value, [
    /\bCRM\s*:\s*(\d+)\s*\/\s*\d+\s+updated/i,
    new RegExp(`\\bCRM\\s+(?:updated|reconciled)(?:\\s+and\\s+verified)?\\s*:\\s*all\\s+${COUNT_TOKEN}`, 'i'),
    new RegExp(`\\ball\\s+${COUNT_TOKEN}\\s+(?:CRM\\s+)?records?[^.]{0,120}\\b(?:updated|reconciled)\\b`, 'i'),
    new RegExp(`\\b(?:updated|reconciled)\\s+${COUNT_TOKEN}\\s+(?:CRM\\s+)?(?:rows?|records?)`, 'i'),
  ]);
  if (crmCount != null && crmCount > 0) {
    const outcome = value.match(/\bCRM\s*:[\s\S]{0,260}?\bas\s+`([^`]{1,48})`/i)?.[1] || value.match(/\bCRM\b[\s\S]{0,220}?\b(?:to|as)\s+`([^`]{1,48})`/i)?.[1] || '';
    touches.push({
      id: 'text:Notion:update:CRM', source: 'text', platform: 'Notion', action: 'update', state: 'done',
      count: crmCount, unit: 'row', account: '', detail: 'CRM', outcome,
    });
  }

  const draftMatch = value.match(new RegExp(`\\b${COUNT_TOKEN}\\s+(replies|emails|drafts)\\s+(?:were\\s+)?drafted`, 'i'))
    || value.match(new RegExp(`\\bdrafted\\s+${COUNT_TOKEN}\\s+(replies|emails|drafts)`, 'i'));
  const savedDraft = /\b(?:reply|email|message|draft)\s+(?:is|was)\s+(?:now\s+)?saved\s+(?:as\s+)?(?:an?\s+)?(?:unsent\s+)?(?:Vime\s+)?draft\b|\bsaved\s+as\s+(?:an?\s+)?unsent\s+(?:Vime\s+)?draft\b|\b(?:Vime\s+)?draft\s+is\s+saved\s+and\s+unsent\b/i.test(value);
  if (draftMatch || savedDraft) {
    const count = draftMatch ? touchCount(draftMatch[1]) : 1;
    if (count != null && count > 0) {
      touches.push({
        id: 'text:Gmail:draft', source: 'text', platform: 'Gmail', action: 'draft', state: 'done', count,
        unit: String(draftMatch?.[2] || 'reply').replace(/ies$/i, 'y').replace(/s$/i, '').toLowerCase(),
        account: value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || (/\bVime\s+draft\b/i.test(value) ? 'Vime account' : ''), detail: '', outcome: 'nothing sent',
      });
    }
  }

  const smartleadCount = countMatch(value, [new RegExp(`\\bqueued\\s+${COUNT_TOKEN}\\s+emails?`, 'i')]);
  if (smartleadCount != null && /\bSmartlead\b/i.test(value)) {
    touches.push({
      id: 'text:Smartlead:send', source: 'text', platform: 'Smartlead', action: 'send', state: 'done',
      count: smartleadCount, unit: 'email', account: '', detail: value.match(/\bCampaign\s+[^\n,.]{1,48}/i)?.[0] || '', outcome: 'queued',
    });
  }

  return touches;
}

function mergeTouches(...groups) {
  const merged = [];
  for (const group of groups) {
    for (const raw of group || []) {
      const touch = { ...raw };
      const genericDetail = !touch.detail || /^(?:CRM|Inbox|campaign)$/i.test(touch.detail);
      let existing = merged.find((candidate) => candidate.platform === touch.platform && candidate.action === touch.action && candidate.detail === touch.detail);
      if (!existing && touch.source === 'text') existing = merged.find((candidate) => candidate.platform === touch.platform && candidate.action === touch.action);
      if (!existing && genericDetail) existing = merged.find((candidate) => candidate.platform === touch.platform && candidate.action === touch.action && !candidate.detail);
      if (!existing) {
        merged.push(touch);
        continue;
      }
      if (touch.source === 'text') {
        if (touch.count != null) existing.count = Math.max(existing.count || 0, touch.count);
      } else if (touch.count != null) {
        existing.count = (existing.count || 0) + touch.count;
      }
      existing.account = existing.account || touch.account;
      existing.detail = existing.detail && !/^(?:CRM|Inbox)$/i.test(existing.detail) ? existing.detail : touch.detail || existing.detail;
      existing.outcome = touch.outcome || existing.outcome;
      existing.url = existing.url || touch.url;
      existing.state = existing.state === 'done' || touch.state === 'done' ? 'done' : touch.state;
    }
  }
  return merged.slice(-12).map(({ source: _source, ...touch }, index) => ({
    ...touch,
    id: publicConnectorText(touch.id || `${touch.platform}:${touch.action}:${index}`, 96),
    platform: publicConnectorText(touch.platform, 40),
    action: publicConnectorText(touch.action, 20),
    state: ['done', 'error', 'stopped'].includes(touch.state) ? touch.state : 'done',
    count: touch.count == null ? null : touchCount(touch.count),
    unit: publicConnectorText(touch.unit, 28),
    account: publicConnectorText(touch.account, 64),
    detail: publicConnectorText(touch.detail, 72),
    outcome: publicConnectorText(touch.outcome, 64),
    url: safePlatformUrl(touch.platform, touch.url, true),
  }));
}

function outsideTouchesForRun(run, task, tab, text) {
  const connectors = connectorsPublic(run, run?.cancelled ? 'stopped' : 'done');
  return mergeTouches(connectorTouches(connectors, task, tab), computerTouches(run?.events, task, tab), inferredTouches(text, task, tab));
}

function outsideTouchesForMessage(message, task, tab) {
  if (Array.isArray(message?.outsideTouches) && message.outsideTouches.length) return mergeTouches(message.outsideTouches);
  const computerEvents = (message?.computer?.steps || []).map((step, index) => ({
    type: 'computer', seq: index + 1, app: message.computer.app, surface: message.computer.surface, step: step.step, phase: step.phase, at: step.at,
  }));
  return mergeTouches(connectorTouches(message?.connectors, task, tab), computerTouches(computerEvents, task, tab), inferredTouches(message?.content, task, tab));
}

function runPublic(run) {
  if (!run) return null;
  const events = run.events || [];
  let text = '';
  let draftText = '';
  const workNotes = [];
  const interims = [];
  let pings = null;
  for (const event of events) {
    if (event.type === 'pings') { if (!event.steerId) pings = Array.isArray(event.pings) ? event.pings : null; }
    else if (event.type === 'interim') { interims.push({ id: event.steerId || null, text: String(event.text || ''), at: event.at }); draftText = ''; }
    else if (event.type === 'candidate-reset') draftText = '';
    else if (event.type === 'candidate-delta') draftText += event.text || '';
    else if (event.type === 'progress') {
      const note = String(event.text || '').trim();
      if (note) workNotes.push(note);
      draftText = '';
    } else if (event.type === 'delta') {
      text += event.text || '';
      draftText = '';
    }
  }
  const toolsByType = new Map();
  for (const event of events.filter((ev) => ev.type === 'tool')) {
    const activity = publicToolActivity(event);
    toolsByType.delete(`${activity.kind}:${activity.name}`);
    toolsByType.set(`${activity.kind}:${activity.name}`, activity);
  }
  const tools = [...toolsByType.values()].slice(-3);
  const statusEvent = [...events].reverse().find((ev) => ev.type === 'status' || ev.type === 'stopped' || ev.type === 'error');
  return {
    id: run.id,
    taskId: run.taskId,
    tabId: run.tabId,
    model: run.model,
    requestedModel: run.requestedModel || run.model,
    recommendation: run.recommendation || null,
    handoff: run.handoff || null,
    handedFrom: run.handedFrom || null,
    scheduled: run.scheduled || null,
    terminalContexts: publicTerminalContexts(run.terminalContexts),
    attachments: publicImageAttachments(run.attachments, run.taskId, run.tabId),
    steers: publicRunSteers(run),
    prompts: run.prompts || (run.prompt ? [run.prompt] : []),
    hiddenPrompt: !!run.hiddenPrompt,
    mentions: Array.isArray(run.mentions) ? run.mentions : [],
    contextRefs: Array.isArray(run.contextRefs) ? run.contextRefs : [],
    pings,
    play: run.play || null,
    ...(run.ranBy ? { ranBy: run.ranBy } : {}),
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    seq: run.seq || 0,
    text,
    draftText,
    workNotes: workNotes.slice(-50),
    interims,
    tools,
    effort: run.effort || null,
    statusText: statusEvent ? (statusEvent.type === 'stopped' ? 'Interrupted' : statusEvent.type === 'status' ? (statusEvent.own ? String(statusEvent.text || '').slice(0, 200) : /^stopping/i.test(String(statusEvent.text || '')) ? 'Interrupting…' : 'Working through the task…') : statusEvent.message || '') : '',
    error: statusEvent && statusEvent.type === 'error' ? statusEvent.message || 'run failed' : null,
    stopping: !!run.cancelled,
    paused: !!run.paused,
    computer: computerPublic(run),
    connectors: connectorsPublic(run),
  };
}

function publicRunSteers(run) {
  return (Array.isArray(run?.steers) ? run.steers : []).map((steer) => ({
    id: steer.id,
    prompt: steer.prompt,
    prompts: steer.prompts || (steer.prompt ? [steer.prompt] : []),
    sentAt: steer.sentAt,
    terminalContexts: publicTerminalContexts(steer.terminalContexts),
    attachments: publicImageAttachments(steer.attachments, run.taskId, run.tabId),
    ...(steer.mentions?.length ? { mentions: steer.mentions } : {}),
    ...(steer.contextRefs?.length ? { contextRefs: steer.contextRefs } : {}),
    ...(steer.pings?.length ? { pings: steer.pings } : {}),
    ...(steer.slackFrom ? { slackFrom: steer.slackFrom } : {}),
  }));
}

function steerFraming(prompt) {
  return [
    'Sent while you were still working on my previous message. It adds to that message, it does not replace it: finish what I asked before, do this too, and make sure your reply answers each message on its own.',
    '',
    prompt,
  ].join('\n');
}

// Steered messages land in the transcript in send order. Whatever the model
// had answered before a steer arrived stands in front of it as its own reply
// (an interim), so no message goes unanswered.
function appendRunSteerMessages(tab, steers, fallbackTs, { interims = [], model = null, requestedModel = null } = {}) {
  tab.messages = tab.messages || [];
  const remaining = (Array.isArray(interims) ? interims : []).filter((item) => item && String(item.text || '').trim());
  for (const steer of Array.isArray(steers) ? steers : []) {
    const prompts = Array.isArray(steer.prompts) && steer.prompts.length
      ? steer.prompts.map((value) => String(value || '')).filter(Boolean)
      : steer.prompt ? [String(steer.prompt)] : [];
    if (!prompts.length) continue;
    const index = remaining.findIndex((item) => item.id === steer.id);
    const interim = index >= 0 ? remaining.splice(index, 1)[0] : (remaining.length && !remaining[0].id ? remaining.shift() : null);
    if (interim) {
      tab.messages.push({
        role: 'assistant',
        content: String(interim.text).trim(),
        workNotes: [],
        model: model || tab.model,
        requestedModel: requestedModel || model || tab.model,
        ts: interim.at || steer.sentAt || fallbackTs,
        ok: true,
        interim: true,
        tools: [],
        computer: null,
        connectors: [],
      });
    }
    tab.messages.push({
      role: 'user',
      content: String(steer.prompt || prompts[0]),
      ...(prompts.length > 1 ? { batch: prompts } : {}),
      ...(steer.terminalContexts?.length ? { terminalContexts: publicTerminalContexts(steer.terminalContexts) } : {}),
      ...(steer.attachments?.length ? { attachments: steer.attachments.map(imageAttachmentRecord).filter(Boolean) } : {}),
      ...(steer.mentions?.length ? { mentions: steer.mentions } : {}),
      ...(steer.contextRefs?.length ? { contextRefs: steer.contextRefs } : {}),
      ...(steer.pings?.length ? { pings: steer.pings } : {}),
      ...(steer.slackFrom ? { author: { id: `slack:${steer.slackFrom.user.id}`, name: steer.slackFrom.user.name }, fromSlack: { channel: steer.slackFrom.channel, channelName: steer.slackFrom.channelName, ts: steer.slackFrom.ts, threadTs: steer.slackFrom.threadTs } } : {}),
      ts: steer.sentAt || fallbackTs,
      steered: true,
    });
  }
}

function persistRunSnapshot(run) {
  const task = getTask(run.taskId);
  if (!task) return null;
  const tab = (task.tabs || []).find((candidate) => candidate.id === run.tabId);
  if (!tab || (tab.status !== 'running' && !tab.activeRun)) return null;
  const snapshot = runPublic(run);
  tab.activeRun = {
    ...snapshot,
    prompt: run.prompt,
    prompts: run.prompts || [run.prompt],
    active: true,
    // Liveness heartbeat: other devices use this to tell a live run (fresh) from
    // an orphaned one (stale) instead of just "absent from my live map".
    updatedAt: new Date().toISOString(),
  };
  saveTask(task);
  return snapshot.text.length + snapshot.draftText.length;
}

function finishPendingRunAsError(task, tab, message) {
  const pending = tab && tab.activeRun;
  if (!pending) return;
  const ts = new Date().toISOString();
  const prompt = String(pending.prompt || '');
  const prompts = Array.isArray(pending.prompts) && pending.prompts.length
    ? pending.prompts.map((value) => String(value || '')).filter(Boolean)
    : prompt ? [prompt] : [];
  const ranBy = pending.ranBy || (team.isSharedTask(task) && team.me() ? { id: team.me().id, name: team.me().name, machine: team.status().machine } : null);
  tab.messages = tab.messages || [];
  const last = tab.messages[tab.messages.length - 1];
  if (prompt && !(last && last.role === 'user' && last.content === prompt)) {
    tab.messages.push({
      role: 'user',
      content: prompt,
      ...(ranBy ? { author: { id: ranBy.id, name: ranBy.name } } : {}),
      ...(prompts.length > 1 ? { batch: prompts } : {}),
      ...(pending.terminalContexts?.length ? { terminalContexts: publicTerminalContexts(pending.terminalContexts) } : {}),
      ...(pending.attachments?.length ? { attachments: pending.attachments.map(imageAttachmentRecord).filter(Boolean) } : {}),
      ...(pending.hiddenPrompt ? { hiddenInTranscript: true } : {}),
      ts: pending.startedAt || ts,
    });
  }
  appendRunSteerMessages(tab, pending.steers, ts, { interims: pending.interims || [], model: pending.model, requestedModel: pending.requestedModel });
  const content = String(pending.text || '').trim() || message;
  const workNotes = Array.isArray(pending.workNotes)
    ? pending.workNotes.map((value) => String(value || '').trim()).filter(Boolean).slice(-50)
    : [];
  const computer = pending.computer ? { ...pending.computer, state: 'error', hasPreview: false, previewSeq: null } : null;
  const connectors = (pending.connectors || []).map((activity) => activity.state === 'active' ? { ...activity, state: 'error' } : activity);
  const outsideTouches = outsideTouchesForMessage({ content, computer, connectors }, task, tab);
  tab.messages.push({
    role: 'assistant',
    content,
    workNotes,
    model: pending.model || tab.model || task.model,
    requestedModel: pending.requestedModel || tab.model || task.model,
    routePolicy: pending.recommendation?.policy || null,
    routeCategory: pending.recommendation?.category || null,
    routeUsedFor: pending.recommendation?.usedFor || null,
    ts,
    ok: false,
    error: message,
    tools: pending.tools || [],
    effort: pending.effort || null,
    computer,
    connectors,
    ...(outsideTouches.length ? { outsideTouches } : {}),
    ...(ranBy ? { ranBy } : {}),
  });
  // Section 26: the turn is being closed by hand; what it sent goes where
  // it happened in the partial answer, what arrived meanwhile goes after.
  if (tab.tabmailOut?.length) tab.messages.push(...answerWithSends(tab.messages.pop(), tab.tabmailOut));
  delete tab.tabmailOut;
  tab.messages.push(...heldNotYetIn(tab));
  delete tab.tabmailHold;
  finalizeModelHandoff(tab, pending.handoff?.id, { ok: false, error: message, completedAt: ts });
  delete tab.activeRun;
  tab.status = 'error';
  task.status = 'error';
  task.lastActivity = ts;
}

function activeRunIsStale(activeRun) {
  const at = Date.parse(activeRun?.updatedAt || activeRun?.startedAt || '');
  return !Number.isFinite(at) || Date.now() - at > RUN_LIVENESS_GRACE_MS;
}

function reconcileTaskRuntimeState(task, orphanMessage = ORPHANED_RUN_MESSAGE) {
  if (!task) return false;
  let changed = settleLegacyPickedDuelTabs(task);
  for (const tab of task.tabs || []) {
    const liveRun = tab.activeRun?.id ? runs.get(tab.activeRun.id) : null;
    const liveRunMatches = !!liveRun && liveRun.taskId === task.id && liveRun.tabId === tab.id;
    // Not in our live map but still syncing fresh progress -> it's running on
    // another of the user's devices (or the cloud). Leave it alone; only a stale
    // activeRun is a genuine orphan we should settle.
    if (tab.activeRun && !liveRunMatches && !activeRunIsStale(tab.activeRun)) continue;
    if (tab.activeRun && !liveRunMatches) {
      finishPendingRunAsError(task, tab, orphanMessage);
      changed = true;
      continue;
    }
    if (tab.type === 'duel' && tab.duel?.phase === 'running' && !duelRuns.has(`${task.id}::${tab.id}`)) {
      tab.duel.phase = 'ready';
      tab.duel.prompt = null;
      tab.duel.a = null;
      tab.duel.b = null;
      tab.status = 'idle';
      changed = true;
      continue;
    }
    if (tab.status === 'running' && !liveRunMatches) {
      tab.status = 'error';
      changed = true;
    }
  }
  if (task.status === 'running' || changed) {
    const tabs = task.tabs || [];
    const nextStatus = tabs.some((tab) => tab.status === 'running')
      ? 'running'
      : tabs.some((tab) => tab.status === 'error') ? 'error'
        : tabs.some((tab) => tab.status === 'done') ? 'done' : 'idle';
    if (task.status !== nextStatus) {
      task.status = nextStatus;
      changed = true;
    }
  }
  if (changed) saveTask(task);
  return changed;
}

async function mobileAppStatus() {
  const session = relay.sessionInfo();
  if (!session?.token || !supabase.isConfigured()) {
    return { installed: false, live: false, deviceName: null, appVersion: null, lastSeen: null };
  }
  try {
    let device = null;
    try {
      const rows = await supabase.rest('mobile_devices?select=device_name,app_version,last_seen&order=last_seen.desc&limit=1', { token: session.token });
      device = Array.isArray(rows) ? rows[0] : null;
    } catch {}
    if (!device) {
      // Compatibility bridge for accounts created before migration 0005.
      // user_docs already exists and is protected by the same own-user RLS.
      const docs = await supabase.rest('user_docs?select=data&key=eq.mobile_device&limit=1', { token: session.token });
      device = Array.isArray(docs) ? docs[0]?.data : null;
    }
    if (!device) return { installed: false, live: false, deviceName: null, appVersion: null, lastSeen: null };
    const seenAt = Date.parse(device.last_seen || '');
    const live = Number.isFinite(seenAt) && Date.now() - seenAt <= 90_000;
    return {
      installed: true,
      live,
      deviceName: String(device.device_name || 'iPhone').slice(0, 64),
      appVersion: device.app_version ? String(device.app_version).slice(0, 32) : null,
      lastSeen: Number.isFinite(seenAt) ? new Date(seenAt).toISOString() : null,
    };
  } catch {
    return { installed: false, live: false, deviceName: null, appVersion: null, lastSeen: null };
  }
}

function configuredTestFlightUrl() {
  try {
    const value = new URL(String(process.env.TESTFLIGHT_URL || '').trim());
    if (value.protocol !== 'https:' || value.hostname !== 'testflight.apple.com' || !value.pathname.startsWith('/join/')) return null;
    return value.toString();
  } catch {
    return null;
  }
}

function configuredTestFlightInviteUrl() {
  try {
    const value = new URL(String(process.env.TESTFLIGHT_INVITE_URL || '').trim());
    if (!['https:', 'http:'].includes(value.protocol)) return null;
    return value.toString();
  } catch {
    return null;
  }
}

async function sendTestFlightInvitation(email) {
  const session = relay.sessionInfo();
  const endpoint = configuredTestFlightInviteUrl();
  // A configured public TestFlight link does not need a signed-in relay
  // session. Only the private invitation broker needs Supreme auth.
  if (!endpoint) return null;
  if (!session?.token || !session.userId) {
    const error = new Error('Sign in to Supreme and try again.');
    error.status = 401;
    throw error;
  }
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    const error = new Error('The invitation service is unavailable. Try again shortly.');
    error.status = 503;
    throw error;
  }
  let payload = {};
  try { payload = await response.json(); } catch { /* use the calm fallback below */ }
  if (!response.ok) {
    const error = new Error(payload?.error || 'Apple could not send the invitation. Try again shortly.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function recordTestFlightRequest(email) {
  const session = relay.sessionInfo();
  if (!session?.token || !session.userId || !supabase.isConfigured()) return false;
  const requestedAt = new Date().toISOString();
  try {
    await supabase.rest('testflight_requests?on_conflict=user_id,email', {
      method: 'POST',
      token: session.token,
      body: { user_id: session.userId, email, requested_at: requestedAt },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    return true;
  } catch {
    try {
      await supabase.rest('user_docs?on_conflict=user_id,key', {
        method: 'POST',
        token: session.token,
        body: { user_id: session.userId, key: 'testflight_request', data: { email, requested_at: requestedAt } },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function remoteSnapshot() {
  const activeByTab = new Map([...runs.values()].map((run) => [`${run.taskId}:${run.tabId}`, run]));
  const archivedRepos = new Set(listRepos().filter((r) => r.archived).map((r) => r.path));
  const sessions = [];
  for (const summary of listTasks()) {
    if (summary.archived) continue;
    // Threads of an archived project are out of sight on the desktop; keep
    // them out of the phone's snapshot too.
    if (archivedRepos.has(summary.repo)) continue;
    const task = getTask(summary.id);
    if (!task) continue;
    for (const tab of task.tabs || []) {
      if (tab.type === 'duel' && !tab.duel?.choice) continue;
      const messages = tab.messages || [];
      const last = messages[messages.length - 1] || null;
      const run = activeByTab.get(`${task.id}:${tab.id}`);
      sessions.push({
        taskId: task.id,
        taskTitle: task.title,
        repoName: task.repoName,
        tabId: tab.id,
        tabName: tab.name,
        model: currentModelNow(tab.model || task.model),
        status: run ? 'running' : tab.status || 'idle',
        lastActivity: run ? new Date(run.startedAt).toISOString() : last?.ts || task.lastActivity || task.updatedAt,
        messageCount: messages.length,
        preview: run ? (runPublic(run).text || run.prompt || '').slice(-240) : last?.content?.slice(0, 240) || '',
        lastRole: run ? 'assistant' : last?.role || null,
        run: runPublic(run),
      });
    }
  }
  const rank = { running: 0, error: 1, done: 2, idle: 3 };
  sessions.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return {
    machine: { name: os.hostname(), online: true },
    mobileApp: await mobileAppStatus(),
    sessions,
    activeCount: runs.size + duelRuns.size,
    at: new Date().toISOString(),
  };
}

function duelHistorySnapshot() {
  const evals = listEvals();
  const duelEvals = new Map(evals.filter((entry) => entry.kind === 'duel' && entry.duelId).map((entry) => [entry.duelId, entry]));
  const picks = new Map(evals.filter((entry) => entry.kind === 'pick' && entry.duelId).map((entry) => [entry.duelId, entry]));
  const projectNames = new Map(listRepos().map((project) => [project.path, project.name]));
  const history = new Map();

  for (const summary of listTasks()) {
    const task = getTask(summary.id);
    if (!task) continue;
    // Archived tabs are user-deleted tabs. Their data remains recoverable, but
    // their Duels intentionally do not appear in this active comparison page.
    const activeTabs = task.tabs || [];
    const archivedTabIds = new Set((task.archivedTabs || []).map((tab) => tab.id));
    for (const tab of activeTabs) {
      const records = [tab.duel, ...(tab.duels || [])].filter((duel) => duel?.duelId && duel.prompt);
      for (const duel of records) {
        const recorded = duelEvals.get(duel.duelId) || {};
        const pick = picks.get(duel.duelId) || {};
        const choice = duel.choice || pick.choice || null;
        const picked = choice === 'a' || choice === 'b' || choice === 'neither';
        const sourceTab = activeTabs.find((candidate) => candidate.id === duel.sourceTabId)
          || (tab.id === duel.sourceTabId ? tab : null);
        if (!sourceTab || (duel.duelTabId && archivedTabIds.has(duel.duelTabId))) continue;
        const project = projectNames.get(task.repo) || task.repoName || 'Project';
        const source = [project, task.title, sourceTab?.name].filter(Boolean).join(' › ');
        const aModel = duel.a?.model || recorded.aModel || '';
        const bModel = duel.b?.model || recorded.bModel || '';
        const winner = choice === 'a' ? aModel : choice === 'b' ? bModel : choice === 'neither' ? 'neither' : '';
        history.set(duel.duelId, {
          id: duel.duelId,
          prompt: String(duel.prompt),
          threadId: task.id,
          tabId: sourceTab?.id || tab.id,
          project,
          thread: task.title,
          sourceTab: sourceTab?.name || '',
          source,
          effort: duel.effort || '—',
          at: duel.pickedAt || duel.completedAt || recorded.at || task.lastActivity || task.updatedAt,
          picked,
          choice,
          winner,
          a: picked && aModel ? {
            model: aModel,
            text: String(duel.a?.text || ''),
            ok: duel.a?.ok !== false,
            durationMs: Number.isFinite(Number(duel.a?.durationMs)) ? Number(duel.a.durationMs) : null,
          } : null,
          b: picked && bModel ? {
            model: bModel,
            text: String(duel.b?.text || ''),
            ok: duel.b?.ok !== false,
            durationMs: Number.isFinite(Number(duel.b?.durationMs)) ? Number(duel.b.durationMs) : null,
          } : null,
        });
      }
    }
  }

  const duels = [...history.values()]
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, 200);
  return { duels, count: duels.length };
}

function titleFrom(prompt) {
  const line = (prompt || '').trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? line.slice(0, 57) + '...' : line || 'Untitled task';
}

const MODEL_USAGE_COPY = {
  'gpt-6-luna': 'drafts people read',
  sonnet: 'research and judgment calls',
  'gpt-6.1-sol': 'browser runs',
  haiku: 'formatting, extraction, and glue',
  opus: 'strategy and high-stakes judgment',
  fable: 'skeptic review and risk checks',
};

function performanceSnapshot() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const byModel = new Map();
  let steps = 0;
  let routedSteps = 0;
  let meteredSpendUsd = 0;
  let unmeteredSteps = 0;

  for (const summary of listTasks()) {
    const task = getTask(summary.id);
    if (!task) continue;
    for (const tab of [...(task.tabs || []), ...(task.archivedTabs || [])]) {
      for (const message of tab.messages || []) {
        if (message.role !== 'assistant') continue;
        if (message.ok === false) continue;
        const at = new Date(message.ts || 0);
        if (!Number.isFinite(at.getTime()) || at < from || at > now) continue;
        const modelId = message.model || 'unknown';
        const row = byModel.get(modelId) || {
          model: modelId,
          steps: 0,
          spendUsd: 0,
          meteredSteps: 0,
          unmeteredSteps: 0,
          uses: new Map(),
        };
        steps++;
        row.steps++;
        const cost = Number(message.costUsd);
        if (message.costUsd != null && Number.isFinite(cost) && cost >= 0) {
          row.spendUsd += cost;
          row.meteredSteps++;
          meteredSpendUsd += cost;
        } else {
          row.unmeteredSteps++;
          unmeteredSteps++;
        }
        if (message.requestedModel === RECOMMENDED_MODEL_ID) routedSteps++;
        const usedFor = message.routeUsedFor || MODEL_USAGE_COPY[modelId] || 'other work';
        row.uses.set(usedFor, (row.uses.get(usedFor) || 0) + 1);
        byModel.set(modelId, row);
      }
    }
  }

  const rows = [...byModel.values()]
    .map((row) => ({
      model: row.model,
      usedFor: [...row.uses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || MODEL_USAGE_COPY[row.model] || 'other work',
      steps: row.steps,
      spendUsd: Number(row.spendUsd.toFixed(6)),
      meteredSteps: row.meteredSteps,
      unmeteredSteps: row.unmeteredSteps,
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd || b.steps - a.steps);

  return {
    period: { from: from.toISOString(), to: now.toISOString() },
    steps,
    routedSteps,
    meteredSpendUsd: Number(meteredSpendUsd.toFixed(6)),
    unmeteredSteps,
    rows,
  };
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found');
  const ext = path.extname(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
  };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Run one agent turn against a task inside its worktree, stream to the client,
// and persist onto the task. The run finishes server-side even if the client
// disconnects, so tasks keep working in the background while you look at others.

// Paper 20.3: the line under a done workstream's name in the tray — the
// result, not a recap. The last assistant reply's first sentence is the
// closest honest one-liner without re-reading the run.
function doneLineFor(tab) {
  const replies = (tab.messages || [])
    .filter((message) => message.role === 'assistant' && !message.hiddenInTranscript && message.ok !== false && message.content);
  const last = replies.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).at(-1);
  const text = String(last?.content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const sentence = text.split(/(?<=[.!?])\s/)[0] || text;
  return sentence.length > 90 ? `${sentence.slice(0, 88)}…` : sentence;
}

// The one-button trim, applied at run time. Naming a set-aside connector in
// the message brings it back for good — never a prompt, never a block.
function mcpTrimForTab(tab, prompt, task) {
  const scope = tab?.connectorScope;
  if (!scope || task.connectors === false) return null;
  const list = cachedConnectorList();
  const keys = new Set(scope.keys || []);
  let grew = false;
  const text = String(prompt || '').toLowerCase();
  for (const row of list) {
    if (!row.name) continue;
    const key = connectorKey(row.name);
    if (keys.has(key)) continue;
    if (text.includes(String(row.name).toLowerCase())) { keys.add(key); grew = true; }
  }
  if (grew) {
    tab.connectorScope = { keys: [...keys], at: scope.at || new Date().toISOString() };
    saveTask(task);
  }
  return mcpTrimFor([...keys], { connectors: list });
}

// Slack rail: an @mention of a project member DMs them the moment the
// message is sent (a claimed queue replay skips via body.queueId). Plain
// @First or @Full Name works today; the composer can later stamp structured
// body.mentions [{email}] and both paths deliver.
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function notifySlackMentions({ task, tab, prompt, body, note = false }) {
  const prefs = slackPrefs();
  const chips = (Array.isArray(body?.mentions) ? body.mentions : [])
    .filter((row) => row?.email)
    .map((row) => ({ email: String(row.email).toLowerCase(), name: String(row.name || '') }));
  const refuse = (error) => (chips.length ? chips.map((row) => ({ ...row, ok: false, error })) : undefined);
  if (!prefs.botToken) return refuse('Slack isn’t connected. Connect it in Connectors to ping people.');
  if (!prefs.notifyMentions) return refuse('Slack pings are turned off in Connectors.');
  if (!team.isSharedTask(task)) return refuse('Only people in a shared workstream can be pinged.');
  const mine = team.me();
  const info = team.sharedInfo(task.projectId);
  const targets = new Set();
  for (const row of Array.isArray(body?.mentions) ? body.mentions : []) {
    if (row?.email) targets.add(String(row.email).toLowerCase());
  }
  for (const member of info?.members || []) {
    if (!member.email || (mine && member.email === mine.email)) continue;
    const name = String(member.name || '').trim();
    const first = name.split(/\s+/)[0] || '';
    const hit = [name, first].filter(Boolean)
      .some((candidate) => new RegExp(`@${escapeRegExp(candidate)}(?![\\w-])`, 'i').test(prompt));
    if (hit) targets.add(String(member.email).toLowerCase());
  }
  if (mine?.email) targets.delete(String(mine.email).toLowerCase());
  const limit = note ? 2_000 : 280;
  const excerpt = String(prompt).length > limit ? `${String(prompt).slice(0, limit - 2)}…` : String(prompt);
  // A note reads as the message itself, signed with where it came from; a
  // mention on a model turn stays a heads-up with the excerpt quoted.
  const dm = note
    ? `${excerpt}\n— ${mine?.name || 'A teammate'}, in ${task.title} · ${tab.name || 'Main'} on Supreme`
    : `${mine?.name || 'A teammate'} mentioned you in ${task.title} · ${tab.name || 'Main'}:\n> ${excerpt}`;
  const pings = [];
  for (const email of targets) {
    const name = (body?.mentions || []).find((row) => String(row?.email || '').toLowerCase() === email)?.name
      || (info?.members || []).find((member) => String(member.email || '').toLowerCase() === email)?.name || '';
    try {
      await slackDmByEmail(email, dm);
      pings.push({ email, name, ok: true });
    } catch (err) {
      console.warn('[slack] mention:', err.message);
      pings.push({ email, name, ok: false, error: friendlySlackError(err.message) });
    }
  }
  return pings;
}

function friendlySlackError(message) {
  const text = String(message || '');
  if (/invalid_auth|not_authed|token_revoked|token_expired|account_inactive/i.test(text)) return 'Slack rejected the bot token. Replace it under Connectors.';
  if (/users_not_found/i.test(text)) return 'No Slack account with that email in the workspace.';
  if (/missing_scope/i.test(text)) return 'The Slack app is missing a permission (users:read.email or chat:write).';
  if (/invalid_code|code_already_used|expired_code/i.test(text)) return 'Slack did not accept that sign-in code. Try Add to Slack again.';
  if (/bad_redirect_uri|invalid_client|bad_client_secret/i.test(text)) return 'The Supreme Slack app is misconfigured: check its client id, client secret and callback URL.';
  return text.replace(/^Slack [\w.]+: /, '') || 'Slack did not accept the message.';
}

// Slack rail: a landed run DMs its owner — a turn that ends asking waits, a
// stopped one was the user's own hand, and quick turns stay quiet. A failed
// run may always DM. All of it is tunable on the Connectors page.
function notifySlackCompletion({ task, tab, ok, stopped, waiting, error, turnMs }) {
  const prefs = slackPrefs();
  if (!prefs.botToken || stopped) return;
  if (ok && (waiting || !prefs.notifyCompleted || turnMs < prefs.minRunSeconds * 1000)) return;
  if (!ok && !prefs.notifyFailures) return;
  const email = prefs.selfEmail || team.me()?.email || getSettings().onboarding?.email || '';
  if (!email) return;
  const where = `${task.title} · ${tab?.name || 'Main'}`;
  const took = turnMs >= 60_000
    ? `${Math.floor(turnMs / 60_000)}m ${Math.round((turnMs % 60_000) / 1000)}s`
    : `${Math.max(1, Math.round(turnMs / 1000))}s`;
  const text = ok
    ? `Done: ${where} — ${doneLineFor(tab) || 'landed'} (${took})`
    : `Stopped: ${where} — ${String(error || 'the run failed').split('\n')[0].slice(0, 200)}`;
  void slackDmByEmail(email, text).catch((err) => console.warn('[slack] completion:', err.message));
}

function workstreamTitle(task) { return task.title || task.repoName || 'Untitled'; }
function resolveHandoffSource(task, tab, ref) {
  const sourceThreadId = String(ref.threadId || task.id);
  const sourceTask = sourceThreadId === task.id ? task : getTask(sourceThreadId);
  const sourceTab = (sourceTask?.tabs || []).find((candidate) => candidate.id === String(ref.tabId));
  if (!sourceTab) return null;
  const cross = sourceTask.id !== task.id;
  if (!cross && sourceTab.id === tab.id) return null;
  return {
    tabId: sourceTab.id,
    name: sourceTab.name || 'Untitled',
    at: new Date().toISOString(),
    ...(cross ? { threadId: sourceTask.id, threadTitle: workstreamTitle(sourceTask) } : {}),
  };
}
// The edge (from -> to -> at) on the receiving task and the hairline row on
// the sender. A sender in another workstream is read fresh and saved on its
// own; a run there re-reads its task before it writes, so the row survives.
function writeTabHandoffEdge(task, tab, handoffFrom) {
  const cross = !!handoffFrom.threadId;
  const sourceTask = cross ? getTask(handoffFrom.threadId) : task;
  const sourceTab = (sourceTask?.tabs || []).find((candidate) => candidate.id === handoffFrom.tabId);
  if (!sourceTab) return;
  const at = handoffFrom.at;
  task.tabHandoffs = [
    ...(task.tabHandoffs || []),
    { from: sourceTab.id, to: tab.id, at, ...(cross ? { fromThreadId: sourceTask.id } : {}) },
  ].slice(-200);
  sourceTab.handedTo = [
    ...(sourceTab.handedTo || []),
    { toTabId: tab.id, toName: tab.name || 'Untitled', at, atMessageCount: (sourceTab.messages || []).length, ...(cross ? { toThreadId: task.id, toThreadTitle: workstreamTitle(task) } : {}) },
  ].slice(-100);
  if (cross) saveTask(sourceTask);
  saveTask(task);
}

async function runTaskTurn({ task, tab, model, requestedModelId = model.id, recommendation = null, prompt, prompts = [prompt], modelPrompt = prompt, terminalContexts = [], attachments = [], hiddenPrompt = false, play = null, handoffFrom = null, mentions = [], contextRefs = [], recalled = [], slackFrom = null, scheduledFire = null, emailFrom = null, emit, signal, effort, runState = null }) {
  const priorCount = (tab.messages || []).length;
  // Sibling-tab briefing. Inject only when it changed since this tab last saw
  // it, so a resumed session doesn't re-pay for an unchanged briefing each turn.
  const briefing = (task.tabs || []).length > 1 ? workstreamBriefing(task, tab.id) : null;
  const injectBriefing = !!briefing && briefing.hash !== tab.briefingHash;
  // Section 26: messages from other tabs this tab has not read yet enter
  // the turn as data, once; the replay leaves them out for the same reason.
  const waitingMail = waitingTabMessages(tab);
  const mailedModelPrompt = waitingMail.length ? `${tabMessagesEnvelope(waitingMail)}\n\n${modelPrompt}` : modelPrompt;
  // Connected tabs: the card's guidance and its hand-over rules sit at the
  // top of every turn. Short, and a rule only fires when its condition did.
  const cardBrief = tabBrief({ task, tab, maps: mapsForTab(task, getTask), lookupTask: getTask, lookupPlay: (id) => playPublic(getPlay(id)) });
  // Section 27: an orchestrator reads its roster and its lanes first.
  const orchBrief = tab.type === 'orchestrator' ? orchestratorBrief({ task, tab, lookupTask: getTask }) : '';
  const briefs = [orchBrief, cardBrief].filter(Boolean).join('\n\n');
  const cardedModelPrompt = briefs ? `${briefs}\n\n${mailedModelPrompt}` : mailedModelPrompt;
  const briefedModelPrompt = injectBriefing ? briefingPrompt(cardedModelPrompt, briefing) : cardedModelPrompt;
  let sessionId = null;
  let lastError = null;
  const wrapped = (ev) => {
    if (ev.type === 'session') sessionId = ev.id;
    if (ev.type === 'error' && ev.message) lastError = ev.message;
    // The concrete model behind an alias row: the label follows it.
    if (ev.type === 'model') { noteResolvedModel(model.id, ev.id); return; }
    emit(ev);
  };

  // Mark this tab (and the thread) running while the agent works.
  {
    const live = getTask(task.id) || task;
    const lt = getTab(live, tab.id);
    if (lt) lt.status = 'running';
    live.status = 'running';
    live.lastActivity = new Date().toISOString();
    saveTask(live);
  }

  // Images stay served from DATA_DIR (Claude reaches them via --add-dir, Codex via
  // -i). Non-image files must be copied into the cwd because Codex is sandboxed to
  // it and ignores extraDirs; the model then reads them from disk by path.
  const imageAttachments = attachments.filter((attachment) => attachment && attachment.kind !== 'file');
  const fileAttachments = attachments.filter((attachment) => attachment && attachment.kind === 'file');
  const cwd = taskWorkingDirectory(task);
  let attachedFilePaths = [];
  try {
    attachedFilePaths = materializeFilesIntoWorktree({ attachments: fileAttachments, cwd });
  } catch (error) {
    console.error(`[attachments] could not stage files for run: ${error.message}`);
  }

  // Compose the per-run "thread" runModel expects: this tab's own transcript and
  // sessions, but the thread's shared worktree, tools, and connectors.
  const runThread = {
    cwd,
    extraDirs: [...new Set([
      ...terminalContexts.map((context) => path.dirname(context.filePath)),
      ...imageAttachments.map((attachment) => path.dirname(attachment.filePath)),
    ].filter(Boolean))],
    tools: task.tools,
    connectors: task.connectors,
    // A tool named on the tab's card opens that connector for the turn.
    mcpTrim: mcpTrimForTab(tab, cardBrief ? `${cardBrief}\n${modelPrompt}` : modelPrompt, task),
    messages: tab.messages || [],
    sessions: tab.sessions || {},
    // Lets a resume-miss replay compact its oldest turns (lib/providers.mjs);
    // the anchor is set by "Sum up older messages" and pins which turns fold.
    summary: projectionSummary(tab),
    compaction: tab.compaction || null,
    model: model.id,
    // Section 26: which tab is calling, for Supreme's own MCP server.
    tabmail: { port: PORT, taskId: task.id, tabId: tab.id, type: tab.type === 'orchestrator' ? 'orchestrator' : '' },
  };

  let providerResult = await runModel({
    thread: runThread,
    model,
    prompt: briefedModelPrompt,
    images: imageAttachments.map((attachment) => attachment.filePath),
    files: attachedFilePaths,
    priorCount,
    signal,
    effort,
    control: runState?.control,
  }, wrapped);
  const asked = model;
  let fellBack = null;
  if (!signal?.aborted && !providerResult.ok && atCapacity(lastError || providerResult.error)) {
    const version = model.provider === 'codex' ? await codexVersion(resolveCliBinary('codex')) : null;
    const standIn = capacityFallback(model, (candidate) => runsHere(candidate, version) && !activeAccountNotice(candidate.id, NOTICE_AVOID_MS));
    if (standIn && !signal?.aborted) {
      fellBack = { from: model.id, to: standIn.id };
      console.info(`[provider:${model.provider}] ${model.cli} at capacity; ${standIn.cli} carries on`);
      emit({ type: 'status', own: true, text: `${model.label} is at capacity. ${standIn.label} is carrying on.` });
      if (runState) runState.model = standIn.id;
      const carried = sessionId ? { ...runThread.sessions, [model.provider]: { id: sessionId, model: standIn.cli, msgCount: priorCount } } : runThread.sessions;
      const carryThread = { ...runThread, model: standIn.id, sessions: carried };
      const resumes = !!sessionResume(carryThread, standIn, priorCount);
      lastError = null;
      const first = providerResult;
      const second = await runModel({
        thread: carryThread,
        model: standIn,
        prompt: resumes ? capacityCarryOnPrompt(model, standIn, modelPrompt) : briefedModelPrompt,
        images: resumes ? [] : imageAttachments.map((attachment) => attachment.filePath),
        files: resumes ? [] : attachedFilePaths,
        priorCount,
        signal,
        effort,
        control: runState?.control,
      }, wrapped);
      providerResult = {
        ...second,
        text: (String(second.text || '').trim() || second.ok) ? second.text : first.text,
        workNotes: [...(Array.isArray(first.workNotes) ? first.workNotes : []), ...(Array.isArray(second.workNotes) ? second.workNotes : [])],
        usage: addUsage(first.usage, second.usage),
      };
      model = standIn;
    }
  }
  // A provider can finish immediately after acknowledging a steer. Let the
  // in-flight receipt persist before taking the final transcript snapshot.
  if (runState) {
    runState.acceptingSteers = false;
    await Promise.allSettled([...(runState.pendingSteers || [])]);
  }
  // A user stop is a clean, intentional end to the turn. Preserve any partial
  // answer, but do not paint the tab red or turn it into a provider failure.
  const result = signal?.aborted
    ? runState?.idleTimedOut
      ? { ...providerResult, ok: false, stopped: false }
      : { ...providerResult, ok: true, stopped: true }
    : providerResult;
  const responseText = String(result.text || '');
  const emptyResponse = !!result.ok && !result.stopped && !responseText.trim();
  const browserBlocked = !result.stopped && ['unavailable', 'recovering'].includes(runState?.browserConnection?.connection);
  const completedOk = !!result.ok && !emptyResponse && !browserBlocked;
  const failureMessage = (browserBlocked ? runState.browserConnection.step : '')
    || runState?.idleError
    || lastError
    || (emptyResponse ? 'The model finished without returning a response. Try sending the message again.' : 'The run failed with no output. Try again.');

  // Re-read so a parallel run in another tab doesn't get clobbered, then append
  // onto the specific tab.
  const fresh = getTask(task.id) || task;
  const ftab = getTab(fresh, tab.id);
  const ts = new Date().toISOString();
  if (ftab) {
    ftab.sessions = { ...(ftab.sessions || {}) };
    const steers = Array.isArray(runState?.steers) ? runState.steers : [];
    const runSnapshot = runState ? runPublic(runState) : null;
    const interimCount = (runSnapshot?.interims || []).filter((item) => String(item.text || '').trim()).length;
    // Notes sent to people while this ran sit in the transcript after
    // priorCount; the session never saw them, but the count must include them
    // or the next turn replays instead of resuming.
    const notesSince = (ftab.messages || []).slice(priorCount).filter((message) => message?.note).length;
    // Section 26: what this turn sent to other tabs (in its session as tool
    // calls) sits after its prompt and before its answer.
    const sentDuring = ftab.tabmailOut || [];
    delete ftab.tabmailOut;
    // After a capacity switch the thread stays the asked model's, so its
    // next turn picks the same thread back up.
    if (sessionId) ftab.sessions[model.provider] = { id: sessionId, model: asked.cli, msgCount: priorCount + 2 + steers.length + interimCount + notesSince + sentDuring.length };
    ftab.messages = ftab.messages || [];
    ftab.messages.push({
      id: newId(),
      role: 'user',
      content: prompt,
      ...(handoffFrom ? { handedFrom: handoffFrom } : {}),
      // Auto-contextualize: the folded messages this turn brought back.
      ...(recalled.length ? { recalled } : {}),
      // Paper 21.2b: the chips that rode this send, kept on the message so
      // the transcript can show what went with it.
      ...(mentions.length ? { mentions } : {}),
      ...(contextRefs.length ? { contextRefs } : {}),
      ...(prompts.length > 1 ? { batch: prompts } : {}),
      ...(terminalContexts.length ? { terminalContexts: publicTerminalContexts(terminalContexts) } : {}),
      ...(attachments.length ? { attachments: attachments.map(imageAttachmentRecord).filter(Boolean) } : {}),
      ...(hiddenPrompt ? { hiddenInTranscript: true } : {}),
      ...(injectBriefing ? { briefing: { count: briefing.count } } : {}),
      ...(waitingMail.length ? { tabMessages: waitingMail.length } : {}),
      // A play's message is marked in the data, not just styled, so a later
      // Find a Play never reads the play's own instructions as the user's.
      ...(play ? { play } : {}),
      // Same team: who typed it, so a shared thread can attribute the turn.
      ...(team.isSharedTask(fresh) && team.me() ? { author: { id: team.me().id, name: team.me().name } } : {}),
      // @Supreme in Slack: the person who asked, and the thread it came from.
      ...(slackFrom ? { author: { id: `slack:${slackFrom.user.id || 'unknown'}`, name: slackFrom.user.name }, fromSlack: { channel: slackFrom.channel, channelName: slackFrom.channelName, ts: slackFrom.ts, threadTs: slackFrom.threadTs } } : {}),
      // Section 29: a schedule sent this one, and its line says when it was
      // due and when it ran.
      ...(scheduledFire ? { scheduled: scheduledFire } : {}),
      // Section 32: an email forwarded to Supreme, shown as the email it was.
      ...(emailFrom ? { fromEmail: { from: emailFrom.from, subject: emailFrom.subject, ...(emailFrom.vime ? { vime: true } : {}) } } : {}),
      ts,
    });
    if (injectBriefing) ftab.briefingHash = briefing.hash;
    // The Slack ping rides the message it belongs to: the result lands on
    // the record (for the transcript) and on the stream (for the live card).
    if (!hiddenPrompt) {
      const userMsg = ftab.messages[ftab.messages.length - 1];
      void notifySlackMentions({ task: fresh, tab: ftab, prompt, body: { mentions } })
        .then((pings) => {
          if (!pings || !pings.length) return;
          userMsg.pings = pings;
          saveTask(fresh);
          if (typeof emit === 'function') emit({ type: 'pings', pings });
        })
        .catch((err) => console.warn('[slack] mention:', err.message));
    }
    appendRunSteerMessages(ftab, steers, ts, { interims: runSnapshot?.interims || [], model: model.id, requestedModel: requestedModelId });
    const computer = runState ? computerPublic(runState, result.stopped ? 'stopped' : completedOk ? 'done' : 'error') : null;
    const connectors = runState ? connectorsPublic(runState, result.stopped ? 'stopped' : completedOk ? 'done' : 'error') : [];
    const written = responseText.trim() ? responseText : result.stopped ? 'Interrupted.' : failureMessage;
    // Section 29, board 29.7: a scheduled run that stops to ask names what it
    // needs on its last line; the line comes off the reply and rides the
    // message, so the confirm row can offer to allow it for next time.
    // The line is lifted here so it never prints; whether it may become an
    // offer is decided below, once what the turn touched is known.
    // Codex's suggested next asks come off too, kept on the message.
    const { content: answered, followups } = takeFollowups(written);
    const lifted = scheduledFire && completedOk && !result.stopped ? scheduled.takeNeeds(answered) : null;
    const content = lifted && lifted.content.trim() ? lifted.content : answered;
    const workNotes = Array.isArray(result.workNotes)
      ? result.workNotes.map((value) => String(value || '').trim()).filter(Boolean).slice(-50)
      : runSnapshot?.workNotes || [];
    // Section 32, board 32.3a: an orchestrator answering a forwarded email
    // names its pick on a last line, which becomes the hand-over card.
    const emailPick = completedOk && !result.stopped && ftab.type === 'orchestrator' ? emailSuggestionFor(fresh, ftab, content) : null;
    const confirmation = emailPick ? emailPick.confirmation : completedOk && !result.stopped ? confirmationRequest(content) : null;
    const outsideTouches = runState
      ? outsideTouchesForRun(runState, fresh, ftab, content)
      : outsideTouchesForMessage({ content, computer, connectors }, fresh, ftab);
    // Board 29.8: the offer is only ever an app this Mac has, or one this
    // turn touched, with one of the connector rows' own actions.
    const askedFor = lifted
      ? scheduled.takeNeeds(written, [...cachedConnectorList().map((row) => row?.name), ...connectors.map((row) => row.connector), ...outsideTouches.map((touch) => touch.platform)]).needs
      : null;
    if (computer) {
      // Screenshots are ephemeral and served from the live/recent run buffer;
      // retain the readable action ledger in history without persisting pixels
      // from the user's logged-in browser session.
      computer.hasPreview = false;
      computer.previewSeq = null;
    }
    ftab.messages.push({
      id: newId(),
      role: 'assistant',
      content: emailPick ? emailPick.content : content,
      workNotes,
      model: model.id,
      requestedModel: requestedModelId,
      ...(fellBack ? { fellBackFrom: fellBack.from } : {}),
      routePolicy: recommendation?.policy || null,
      routeCategory: recommendation?.category || null,
      routeUsedFor: recommendation?.usedFor || null,
      ts: new Date().toISOString(),
      ok: completedOk,
      stopped: !!result.stopped,
      error: completedOk ? null : failureMessage,
      usage: result.usage || null,
      costUsd: result.costUsd ?? null,
      tools: runSnapshot?.tools || [],
      effort: effort || runSnapshot?.effort || null,
      // Full wall-clock for the turn, thinking included — the activity card's
      // own timestamps only cover the browser/connector window.
      ...(runState?.startedAt ? { turnMs: Math.max(0, (runState.finishedAt || Date.now()) - runState.startedAt) } : {}),
      ...(confirmation ? { confirmation } : {}),
      ...(confirmation && askedFor ? { needs: { ...askedFor, scheduleId: scheduledFire.id } } : {}),
      ...(followups.length ? { followups } : {}),
      computer,
      connectors,
      ...(outsideTouches.length ? { outsideTouches } : {}),
      // Same team: whose Mac ran it (the attribution line on the other side).
      ...(team.isSharedTask(fresh) && team.me() ? { ranBy: { id: team.me().id, name: team.me().name, machine: team.status().machine } } : {}),
    });
    // One use per connector per turn it took part in (Connectors page order).
    // Section 26: sends this turn made go before its answer; messages that
    // arrived while it ran go after, where the next turn reads them.
    if (sentDuring.length) {
      const placed = answerWithSends(ftab.messages.pop(), sentDuring);
      ftab.messages.push(...placed);
      bumpSessionCounts(ftab, placed.filter((message) => message.role === 'assistant').length - 1);
    }
    const arrivedDuring = heldNotYetIn(ftab);
    delete ftab.tabmailHold;
    if (arrivedDuring.length) {
      ftab.messages.push(...arrivedDuring);
      bumpSessionCounts(ftab, arrivedDuring.length);
    }
    recordConnectorUses({ connectors, computer, ts }, { provider: model.provider });
    const completedHandoff = finalizeModelHandoff(ftab, runState?.handoff?.id, {
      ok: completedOk,
      stopped: !!result.stopped,
      error: completedOk ? null : failureMessage,
    });
    if (completedHandoff && runState) runState.handoff = { ...completedHandoff };
    delete ftab.activeRun;
    // Keep Recommended pinned after the turn; the assistant message records
    // the concrete model that actually ran.
    ftab.model = requestedModelId;
    ftab.status = completedOk ? 'done' : 'error';
    // When this tab last landed a turn: the merge rule for shared threads.
    ftab.turnAt = ts;
  }
  notifySlackCompletion({
    task: fresh,
    tab: ftab,
    ok: completedOk,
    stopped: !!result.stopped,
    waiting: !!(ftab?.messages || []).at(-1)?.confirmation,
    error: failureMessage,
    turnMs: runState?.startedAt ? Math.max(0, Date.now() - runState.startedAt) : 0,
  });
  if (completedOk) clearAccountNotices(model);
  else if (!result.stopped) {
    const notice = recordAccountNotice(model, [failureMessage, responseText].filter(Boolean).join('\n'));
    // A signed-out failure reads as the fix, not a stack trace: the error the
    // user sees becomes the plain instruction, raw detail stays in the log.
    if (notice?.kind === 'signed-out' && ftab) {
      const last = (ftab.messages || []).at(-1);
      if (last && last.role === 'assistant' && last.ok === false) {
        last.error = notice.message;
        if (!String(last.content || '').trim() || /401|unauthorized|bearer|request id|credentials|not logged in|please (?:log|sign) ?in|\/login/i.test(String(last.content))) last.content = notice.message;
      }
    }
  }
  fresh.model = requestedModelId;
  // Thread rollup: running if any tab is still running, else this turn's result.
  const anyRunning = (fresh.tabs || []).some((tb) => tb.status === 'running');
  fresh.status = anyRunning ? 'running' : completedOk ? 'done' : 'error';
  fresh.lastActivity = ts;
  // Refresh the shared diff summary so the sidebar shows what changed.
  try {
    const d = await worktreeDiff(taskWorkingDirectory(fresh), fresh.base);
    fresh.diffStat = summarizeStat(d.stat);
  } catch {}
  saveTask(fresh);
  // Section 32: the email's next step, once this turn is on disk.
  if (ftab) void emailAfterLanding(fresh.id, ftab.id).catch((err) => console.error('[email] after landing:', err.message));
  // Summaries feed sibling briefings (multi-tab) and replay compaction (any
  // tab whose transcript is big enough that a resume-miss replay would hurt).
  const transcriptChars = ((ftab || tab).messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
  if ((fresh.tabs || []).length > 1 || transcriptChars > 30_000) scheduleTabSummary(fresh.id, tab.id);
  if (completedOk && ftab) {
    const lastAssistant = ftab.messages[ftab.messages.length - 1];
    const touched = platformsTouchedByMessage(lastAssistant, currentPlatformDefinitions());
    if (touched.length) {
      schedulePlatformSuggestions(touched, {
        userPrompt: prompt,
        assistantText: String(lastAssistant?.content || ''),
        activity: platformTurnActivity(lastAssistant),
      });
    }
  }
  const tabName = (ftab || tab).name || fresh.title || 'Agent';
  pushNotify({
    title: result.stopped ? `Interrupted — ${tabName}` : completedOk ? `Done — ${tabName}` : `Failed — ${tabName}`,
    body: (result.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      || (completedOk ? 'The run finished.' : failureMessage),
    tag: `run:${fresh.id}:${tab.id}`,
  });
  // Paper 16.6: green means finished and nothing waiting on the user. A turn
  // that ends by asking for confirmation stays neutral, so the client needs
  // the server's verdict, not its own guess from the text.
  const lastSaved = ftab ? ftab.messages[ftab.messages.length - 1] : null;
  // Section 33: a scheduled task's landing reaches the phone, whoever is at
  // the Mac. A stop is someone's hand on it, so it stays quiet.
  if (scheduledFire && !result.stopped) {
    const outcome = !completedOk ? 'failed' : lastSaved?.confirmation ? 'waiting' : 'done';
    const name = scheduled.getSchedule(scheduledFire.id)?.name || tabName;
    const message = phoneMessage({ name, outcome, line: doneLineFor(ftab || tab) || '', error: failureMessage });
    void pushToPhone(relay.sessionInfo(), { ...message, threadId: fresh.id, tabId: tab.id, kind: outcome });
  }
  return { ok: completedOk, stopped: !!result.stopped, waiting: !!lastSaved?.confirmation, task: fresh, tabId: tab.id };
}

// ---------------------------------------------------------------------------
// tab summaries — the rolling per-tab digest that powers workstream briefings.
// Generated off the run path (fire-and-forget) with a cheap model when one is
// connected; the deterministic fallback guarantees a summary either way.

const tabSummaryRuns = new Set(); // `${taskId}:${tabId}` in flight

// ---------------------------------------------------------------------------
// Plays (Paper 17). Find a Play reads a tab and writes it up in the user's
// words; a play run is an agent that types, one message per rule, through
// the same run route the composer uses, so the thread shows ordinary turns
// carrying the play's marker. Nothing sends without the user: a turn that
// ends asking for confirmation makes the run wait for their reply.
const PLAYS_FIXTURE = process.env.WB_PLAYS_FIXTURE === '1';
const PLAY_JOB_TTL_MS = 30 * 60_000;
const playFindJobs = new Map();
const playRuns = new Map();

function playMarkerFrom(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.runId) return null;
  return {
    id: String(raw.id),
    runId: String(raw.runId),
    name: String(raw.name || 'Play').slice(0, 80),
    step: Math.max(1, Number(raw.step) || 1),
    steps: Math.max(1, Number(raw.steps) || 1),
    ...(raw.kickoff ? { kickoff: String(raw.kickoff).slice(0, 2_000) } : {}),
  };
}

function playProjectFor(task) {
  const repo = listRepos().find((candidate) => (task?.projectId && candidate.id === task.projectId) || candidate.path === task?.repo) || null;
  return { projectId: repo?.id || task?.projectId || null, repo: task?.repo || null, repoName: repo?.name || task?.repoName || '' };
}

async function connectedConnectorNames() {
  const list = await listConnectors().catch(() => []);
  return [...new Set(list
    .filter((item) => item && item.connected !== false)
    .map((item) => String(item.name || '').replace(/^claude\.ai\s+/i, '').trim())
    .filter(Boolean))];
}

async function playModelText({ modelId, prompt, signal, effort = 'Medium' }) {
  const model = resolveModel(modelId) || tabSummaryModel();
  if (!model) throw new Error('No connected model can read this thread yet.');
  let lastError = '';
  const result = await runModel({
    thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: false, messages: [], sessions: {}, model: model.id },
    model,
    prompt,
    images: [],
    priorCount: 0,
    signal,
    effort,
    control: {},
  }, (event) => { if (event.type === 'error') lastError = String(event.message || ''); });
  if (!result?.text && lastError) throw new Error(lastError);
  return String(result?.text || '');
}

function prunePlayJobs() {
  const now = Date.now();
  for (const [id, job] of playFindJobs) {
    if (job.finishedAt && now - Date.parse(job.finishedAt) > PLAY_JOB_TTL_MS) playFindJobs.delete(id);
  }
  for (const [id, run] of playRuns) {
    if (run.finishedAt && now - Date.parse(run.finishedAt) > PLAY_JOB_TTL_MS) playRuns.delete(id);
  }
}

function publicPlayJob(job) {
  if (!job) return null;
  return {
    id: job.id, taskId: job.taskId, tabId: job.tabId, status: job.status, steps: job.steps,
    result: job.result, error: job.error || null, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
  };
}

async function runPlayFind(job) {
  try {
    const task = getTask(job.taskId);
    const tab = task ? getTab(task, job.tabId) : null;
    if (!tab) throw new Error('That tab is gone.');
    const messages = (tab.messages || []).filter((message) => message && !message.hiddenInTranscript);
    const turns = userTurns(messages);
    const cutIns = turns.slice(1).map((turn) => String(turn.content || '').replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean);
    job.steps = [
      { label: `Read ${messages.length} ${messages.length === 1 ? 'turn' : 'turns'}`, state: 'done' },
      { label: `Pulled the ${cutIns.length} ${cutIns.length === 1 ? 'turn' : 'turns'} where you cut in`, state: 'done' },
      { label: 'Working out what stayed the same', state: 'now' },
      { label: 'Writing it up in your words', state: 'next' },
    ];
    if (!turns.length) throw new Error('Nothing to read yet: send something in this tab first.');
    const project = playProjectFor(task);
    let found;
    if (PLAYS_FIXTURE) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      found = fixturePlayFromTranscript(messages, { projectName: project.repoName });
    } else {
      const connectors = await connectedConnectorNames();
      const text = await playModelText({
        modelId: job.model,
        prompt: findPlayPrompt({ transcript: condenseTranscript(messages), cutIns, connectors, projectName: project.repoName }),
        signal: job.controller.signal,
      });
      found = parsePlayJson(text);
    }
    job.steps[2].state = 'done';
    job.steps[3].state = 'now';
    if (!found) throw new Error('Could not write this thread up as a play. Try again, or say what it should be.');
    job.steps[3].state = 'done';
    job.result = {
      name: found.name,
      useWhen: found.useWhen,
      rules: rulesListToHtml(found.rules),
      ...project,
      sourceTaskId: job.taskId,
      sourceTabId: job.tabId,
    };
    job.status = 'ready';
  } catch (error) {
    job.status = job.controller.signal.aborted ? 'stopped' : 'failed';
    job.error = error?.message || String(error);
    for (const step of job.steps || []) if (step.state === 'now') step.state = 'failed';
  }
  job.finishedAt = new Date().toISOString();
}

function startPlayFind({ taskId, tabId, modelId }) {
  prunePlayJobs();
  for (const job of playFindJobs.values()) {
    if (job.taskId === taskId && job.tabId === tabId && job.status === 'reading') return job;
  }
  const job = {
    id: newId(), taskId, tabId, model: modelId || null, status: 'reading', steps: [], result: null, error: null,
    startedAt: new Date().toISOString(), finishedAt: null, controller: new AbortController(),
  };
  playFindJobs.set(job.id, job);
  void runPlayFind(job);
  return job;
}

function publicPlayRun(run) {
  if (!run) return null;
  return {
    id: run.id, playId: run.playId, name: run.name, taskId: run.taskId, tabId: run.tabId, status: run.status,
    step: run.step, steps: run.steps, kickoff: run.kickoff, error: run.error || null,
    startedAt: run.startedAt, finishedAt: run.finishedAt || null,
  };
}

function liveTabRun(taskId, tabId) {
  return [...runs.values()].find((run) => run.taskId === taskId && run.tabId === tabId) || null;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTabIdle(run) {
  while (!run.stopped && liveTabRun(run.taskId, run.tabId)) await sleepMs(800);
}

// Nothing sends without the user. A turn that ended asking for confirmation
// makes the run wait: for the person's reply, and for the turn that reply
// starts, before the next rule goes in.
async function waitWhileWaitingOnUser(run) {
  for (;;) {
    if (run.stopped) return;
    const task = getTask(run.taskId);
    const tab = task ? getTab(task, run.tabId) : null;
    const messages = tab?.messages || [];
    const last = messages[messages.length - 1];
    const live = !!liveTabRun(run.taskId, run.tabId);
    const pending = !!(last && last.role === 'assistant' && last.confirmation && last.ok !== false && !last.stopped);
    if (!live && !pending) { if (run.status === 'waiting') run.status = 'running'; return; }
    if (pending && !live && run.status !== 'waiting') run.status = 'waiting';
    await sleepMs(1_500);
  }
}

async function sendPlayTurn(run, message, stepIndex, stepCount) {
  const play = { id: run.playId, runId: run.id, name: run.name, step: stepIndex + 1, steps: stepCount, ...(stepIndex === 0 && run.kickoff ? { kickoff: run.kickoff } : {}) };
  const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${encodeURIComponent(run.taskId)}/tabs/${encodeURIComponent(run.tabId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: message, model: run.model, effort: run.effort, play }),
    signal: run.controller.signal,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `run failed (${response.status})`);
  }
  let saved = null;
  let error = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      if (event.type === 'saved') saved = event;
      if (event.type === 'error' && event.message) error = String(event.message);
    }
  }
  return { saved, error };
}

async function runPlay(run) {
  const play = playPublic(getPlay(run.playId));
  const steps = play?.steps || [];
  run.steps = steps.map((label) => ({ label, state: 'next', outcome: '' }));
  if (play) updatePlay(play.id, { noteRun: true });
  try {
    if (!play || !steps.length) throw new Error('This play has no rules to run.');
    for (let index = 0; index < steps.length; index += 1) {
      if (run.stopped) break;
      run.step = index + 1;
      run.steps[index].state = 'now';
      await waitForTabIdle(run);
      if (run.stopped) break;
      const task = getTask(run.taskId);
      const tab = task ? getTab(task, run.tabId) : null;
      if (!tab) throw new Error('That tab is gone.');
      let composed;
      if (PLAYS_FIXTURE) {
        composed = fixtureStep({ play, stepIndex: index, kickoff: run.kickoff });
      } else {
        const transcript = condenseTranscript(tab.messages || [], { maxTurns: 12, maxChars: 700 });
        const text = await playModelText({
          modelId: run.model,
          prompt: composeStepPrompt({ play, stepIndex: index, kickoff: run.kickoff, transcript }),
          signal: run.controller.signal,
        });
        composed = parseStepJson(text);
      }
      if (!composed) throw new Error(`Could not write the message for rule ${index + 1}.`);
      // The outcome is the model's own report of the previous rule, prose for
      // the panel and nothing else. Never build on it (a later drift check
      // must read the actual result set, not the model grading itself).
      if (index > 0 && composed.outcome && !run.steps[index - 1].outcome) run.steps[index - 1].outcome = composed.outcome;
      if (composed.skip || !composed.message) { run.steps[index].state = 'skipped'; continue; }
      const { saved, error } = await sendPlayTurn(run, composed.message, index, steps.length);
      if (run.stopped) break;
      if (!saved || saved.ok === false) throw new Error(error || `Rule ${index + 1} did not finish.`);
      await waitWhileWaitingOnUser(run);
      run.steps[index].state = run.stopped ? 'stopped' : 'done';
    }
    if (run.stopped) {
      run.status = 'stopped';
      for (const step of run.steps) if (step.state === 'now') step.state = 'stopped';
    } else {
      run.status = 'done';
      const last = run.steps[run.steps.length - 1];
      if (last && !last.outcome && last.state === 'done') last.outcome = 'done';
    }
  } catch (error) {
    run.status = run.stopped ? 'stopped' : 'failed';
    run.error = error?.message || String(error);
    for (const step of run.steps) if (step.state === 'now') step.state = run.stopped ? 'stopped' : 'failed';
  }
  run.finishedAt = new Date().toISOString();
}

function activePlayRunFor(taskId, tabId) {
  return [...playRuns.values()].find((run) => run.taskId === taskId && run.tabId === tabId && !run.finishedAt) || null;
}

function startPlayRun({ play, taskId, tabId, kickoff, modelId, effort }) {
  prunePlayJobs();
  const run = {
    id: newId(), playId: play.id, name: play.name, taskId, tabId, status: 'running', step: 0, steps: [],
    kickoff: String(kickoff || '').trim().slice(0, 2_000), model: modelId || null, effort: effort || null,
    error: null, stopped: false, startedAt: new Date().toISOString(), finishedAt: null, controller: new AbortController(),
  };
  playRuns.set(run.id, run);
  void runPlay(run);
  return run;
}

function stopPlayRun(run) {
  if (!run || run.finishedAt) return false;
  run.stopped = true;
  run.status = 'stopping';
  const live = liveTabRun(run.taskId, run.tabId);
  if (live) {
    live.cancelled = true;
    recordRunEvent(live.id, { type: 'status', text: 'Stopping…' });
    live.controller.abort();
  }
  run.controller.abort();
  return true;
}

function tabSummaryModel() {
  const status = probeStatus();
  for (const id of ['haiku', 'gpt-6-luna']) {
    const model = resolveModel(id);
    if (providerReadyForContext(model, status)) return model;
  }
  return null;
}

// Connected tabs, boards 4 and 5: the person's sentence becomes a When /
// Then / With rule. The small model reads it when one is signed in; the
// sentence's own shape is the fallback, so a rule always comes back and the
// words stay the source of truth either way. WB_TABMAP_PARSE=0 skips the
// model (smokes).
const TABMAP_PARSE = process.env.WB_TABMAP_PARSE !== '0';
async function makeMapRule({ words, fromName, toName }) {
  const model = TABMAP_PARSE ? tabSummaryModel() : null;
  if (model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const result = await runModel({
        thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: false, messages: [], sessions: {}, model: model.id },
        model,
        prompt: rulePrompt({ words, fromName, toName }),
        images: [],
        priorCount: 0,
        signal: controller.signal,
        effort: 'Low',
        control: {},
      }, () => {});
      const parsed = result?.ok ? parseRule(result.text) : null;
      if (parsed) return parsed;
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  return deterministicRule({ words, fromName, toName });
}

function scheduleTabSummary(taskId, tabId) {
  const key = `${taskId}:${tabId}`;
  if (tabSummaryRuns.has(key)) return;
  tabSummaryRuns.add(key);
  generateTabSummary(taskId, tabId)
    .catch((error) => console.error(`[briefing] summary for ${key} failed: ${error.message}`))
    .finally(() => tabSummaryRuns.delete(key));
}

// Resolves to the tab's summary record (fresh or already current), or null
// when there is nothing to summarize.
async function generateTabSummary(taskId, tabId) {
  const task = getTask(taskId);
  const tab = task ? getTab(task, tabId) : null;
  if (!tab) return null;
  const msgCount = (tab.messages || []).length;
  if (!msgCount) return null;
  if (tab.summary?.msgCount === msgCount) return tab.summary;
  let text = null;
  const model = tabSummaryModel();
  if (model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await runModel({
        thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: false, messages: [], sessions: {}, model: model.id },
        model,
        prompt: tabSummaryPrompt(tab),
        images: [],
        priorCount: 0,
        signal: controller.signal,
        effort: 'Low',
        control: {},
      }, () => {});
      if (result?.ok) text = parseTabSummary(result.text);
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  if (!text) text = deterministicTabSummary(tab);
  if (!text) return null;
  // Re-read before writing: the run that triggered this summary already saved,
  // and another tab may have saved since.
  const fresh = getTask(taskId);
  const ftab = fresh ? getTab(fresh, tabId) : null;
  if (!ftab) return null;
  ftab.summary = { text, msgCount, updatedAt: new Date().toISOString() };
  saveTask(fresh);
  return ftab.summary;
}


const foldRuns = new Map();
const FOLD_MANUAL_TAIL_CHARS = 24_000;

function tabIsRunning(task, tab) {
  return tab.status === 'running' || !!tab.activeRun || [...runs.values()].some((run) => run.taskId === task.id && run.tabId === tab.id);
}

// The verbatim tail a fold leaves: whatever fits under the target once the
// fixed parts (connector schemas, briefing) are paid for, in characters. A
// manual Sum up folds harder, the way the button always did.
function foldTailChars(task, tab, trigger) {
  // A cold start folds to the same short tail as a manual Sum up, since
  // every verbatim character it keeps is replayed uncached on that send.
  if (trigger === 'manual' || trigger === 'cold') return FOLD_MANUAL_TAIL_CHARS;
  const meter = contextMeterFor(task, tab);
  const fixed = meter.parts.connectors + meter.parts.briefing;
  const room = (meter.windowTokens * FOLD_TARGET_PCT) / 100 - fixed;
  return Math.max(FOLD_MANUAL_TAIL_CHARS, Math.min(120_000, Math.floor(room * 4)));
}

function coldStartWantsFold(task, tab, model) {
  if (!tab || tab.type === 'duel') return false;
  const messages = tab.messages || [];
  if (sessionResume({ sessions: tab.sessions || {}, cwd: taskWorkingDirectory(task) }, model, messages.length)) return false;
  const from = Number(tab.compaction?.keptFrom) || 0;
  if (messages.length - from < 2) return false;
  let chars = 0;
  for (const message of messages.slice(from)) chars += String(message?.content || '').length;
  return chars > REPLAY_MAX_CHARS;
}

function foldWanted(task, tab, trigger, extraTokens = 0) {
  if (!tab || tab.type === 'duel') return false;
  const meter = contextMeterFor(task, tab);
  const pct = ((meter.usedTokens + extraTokens) / meter.windowTokens) * 100;
  if (pct < (trigger === 'admission' ? FOLD_ADMIT_PCT : FOLD_SETTLE_PCT)) return false;
  const from = Number(tab.compaction?.keptFrom) || 0;
  return (tab.messages || []).length - from >= 2;
}

// The connectors this tab never used are set aside with the fold: their
// schemas are most of a heavy Claude tab, and folding turns alone often
// cannot make a run fit. Naming one in a message brings it back.
function setAsideUnusedConnectors(task, tab) {
  if (task.connectors === false) return { count: 0, names: [] };
  const used = keysUsedByTab(tab);
  const keys = new Set();
  const names = [];
  for (const row of cachedConnectorList().filter((candidate) => candidate.connected)) {
    const key = connectorKey(row.name);
    if (used.has(key) || keys.has(key)) continue;
    keys.add(key);
    names.push(row.name);
  }
  if (names.length > 0 || tab.connectorScope) tab.connectorScope = { keys: [...used.keys()], at: new Date().toISOString() };
  return { count: names.length, names };
}

// One fold per tab at a time; a caller that finds one in flight waits for it.
// The record is written in one save after a re-read: a message that landed
// during the fold, or a run that started, drops the fold rather than writing
// it against a transcript it never saw.
function foldTab(taskId, tabId, trigger) {
  const key = `${taskId}:${tabId}`;
  if (foldRuns.has(key)) return foldRuns.get(key);
  const work = (async () => {
    const task = getTask(taskId);
    const tab = task ? (task.tabs || []).find((candidate) => candidate.id === tabId) : null;
    if (!tab || tab.type === 'duel') return null;
    if (tabIsRunning(task, tab)) return null;
    const messages = tab.messages || [];
    const previous = activeFold(tab);
    const from = Number(tab.compaction?.keptFrom) || 0;
    const cut = planFoldCut(messages, { tailChars: foldTailChars(task, tab, trigger), from, minFold: trigger === 'settle' ? 2 : 1 });
    if (!cut) return null;
    const before = contextMeterFor(task, tab);
    const range = messages.slice(from, cut.keptFrom);
    const startedWith = messages.length;
    let parsed = null;
    const model = tabSummaryModel();
    if (model) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      try {
        const result = await runModel({
          thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: false, messages: [], sessions: {}, model: model.id },
          model,
          prompt: foldPrompt({ previous, messages: range }),
          images: [],
          priorCount: 0,
          signal: controller.signal,
          effort: 'Low',
          control: {},
        }, () => {});
        if (result?.ok) parsed = parseFold(result.text);
      } catch {} finally {
        clearTimeout(timer);
      }
    }
    const usedModel = parsed && model ? model.id : 'deterministic';
    if (!parsed) parsed = deterministicFold(previous, range);
    if (!parsed) return null;
    // Facts from earlier folds are pinned: the model is asked to carry them
    // forward and may say them again, but one it dropped stays. New facts
    // are checked against the message they cite (the source is still here
    // and the check costs nothing); an exact repeat folds into one.
    const carried = previous?.facts || [];
    const seen = new Set(carried.map((fact) => String(fact.text).toLowerCase()));
    const added = verifyFacts(parsed.facts, messagesById(messages)).filter((fact) => {
      const key = String(fact.text).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const facts = [...carried, ...added].slice(-FOLD_FACTS_KEEP);
    const fresh = getTask(taskId);
    const ftab = fresh ? (fresh.tabs || []).find((candidate) => candidate.id === tabId) : null;
    if (!ftab) return null;
    if ((ftab.messages || []).length !== startedWith || tabIsRunning(fresh, ftab)) {
      console.info(`[fold] thread=${taskId} tab=${tabId} dropped: the tab moved on during the fold`);
      return null;
    }
    const at = new Date().toISOString();
    const fold = {
      id: newId(),
      at,
      trigger,
      previousFoldId: previous?.id || null,
      throughId: ftab.messages[cut.throughIndex]?.id || null,
      throughIndex: cut.throughIndex,
      keptFrom: cut.keptFrom,
      count: cut.count,
      foldedNow: cut.foldedNow,
      narrative: parsed.narrative,
      facts,
      model: usedModel,
      tokensBefore: before.usedTokens,
      tokensAfter: 0,
      // The connectors set aside with this fold, by name, so the panel can
      // list them without recomputing later (recomputing would drift).
      setAside: [],
    };
    ftab.folds = [...(ftab.folds || []), fold].slice(-20);
    ftab.compaction = { msgCount: ftab.messages.length, keptFrom: cut.keptFrom, elided: cut.keptFrom, at, foldId: fold.id };
    const aside = trigger === 'manual' ? { count: 0, names: [] } : setAsideUnusedConnectors(fresh, ftab);
    fold.setAside = aside.names;
    const setAside = aside.count;
    // A natively resumed session would still carry the whole history the
    // fold just set aside; the next turn replays the projection instead.
    ftab.sessions = {};
    fold.tokensAfter = contextMeterFor(fresh, ftab).usedTokens;
    saveTask(fresh);
    console.info(`[fold] thread=${taskId} tab=${tabId} trigger=${trigger} folded=${cut.foldedNow} through=${cut.throughIndex} facts=${facts.length} verbatim=${facts.filter((fact) => fact.verbatim).length} model=${usedModel} tokens=${before.usedTokens}->${fold.tokensAfter}${setAside ? ` setAside=${setAside}` : ''}`);
    return fold;
  })().catch((error) => { console.error(`[fold] ${key} failed: ${error.message}`); return null; })
    .finally(() => foldRuns.delete(key));
  foldRuns.set(key, work);
  return work;
}

// The settle check: a run just landed; if it crossed the threshold, fold now
// while the tab is idle, so the next run finds the room already made.
function settleFold(taskId, tabId) {
  const task = getTask(taskId);
  const tab = task ? (task.tabs || []).find((candidate) => candidate.id === tabId) : null;
  if (!tab || tabIsRunning(task, tab) || !foldWanted(task, tab, 'settle')) return;
  void foldTab(taskId, tabId, 'settle');
}

// ---------------------------------------------------------------------------
// Section 26: tabs talk to each other. The bus is Supreme's; the model only
// calls a tool (lib/supreme-mcp.mjs). A message lands on both transcripts as
// a message with role 'tab': 'out' with `to` on the sender, 'in' with `from`
// on the receiver, the same pairId on both. No fate is tracked. A receiver
// mid run does not see the message: it waits in a durable holding list on
// the tab (a queue, destroyed by delivery, like the shared-thread queue) and
// enters the transcript after that turn's answer, where the next turn reads
// it. A sender mid run has its own record held the same way, so it sits
// after that turn's prompt and before its answer.

function bumpSessionCounts(tab, count) {
  // The provider session never saw a message appended between turns; the
  // count must include it or the next turn replays instead of resuming.
  for (const session of Object.values(tab.sessions || {})) {
    if (session && Number.isFinite(session.msgCount)) session.msgCount += count;
  }
}

function tabmailDestinations(taskId, tabId) {
  const summaries = listTasks().filter((summary) => !summary.archived);
  const when = (row) => Date.parse(row.lastActivity || row.updatedAt || '') || 0;
  summaries.sort((a, b) => (a.id === taskId ? -1 : b.id === taskId ? 1 : when(b) - when(a)));
  const rows = [];
  for (const summary of summaries) {
    for (const tab of summary.tabs || []) {
      if (summary.id === taskId && tab.id === tabId) continue;
      if (tab.type === 'duel') continue;
      rows.push({
        name: `${summary.title || summary.repoName || 'Untitled'} / ${tab.name || 'Untitled'}`,
        threadId: summary.id,
        tabId: tab.id,
        status: tab.done ? 'done' : tab.status === 'running' ? 'running' : 'idle',
        sameWorkstream: summary.id === taskId,
      });
    }
  }
  return rows;
}

function tabmailError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// A destination by ids, or by "Workstream / Tab"; a bare tab name means a
// sibling in the sender's workstream, else the one live tab of that name.
function resolveTabTarget(fromTask, fromTab, to) {
  const lower = (value) => String(value || '').trim().toLowerCase();
  if (to?.threadId && to?.tabId) {
    const task = to.threadId === fromTask.id ? fromTask : getTask(to.threadId);
    const tab = (task?.tabs || []).find((candidate) => candidate.id === to.tabId);
    if (!task || !tab) throw tabmailError(404, 'No such tab. Call list_tabs for the names.');
    return { task, tab };
  }
  const { threadTitle, tabName } = parseTabName(to?.name);
  if (!tabName) throw tabmailError(400, 'Say which tab, as "Workstream / Tab" from list_tabs.');
  const matches = [];
  if (!threadTitle) {
    const sibling = (fromTask.tabs || []).find((candidate) => candidate.id !== fromTab.id && candidate.type !== 'duel' && lower(candidate.name) === lower(tabName));
    if (sibling) return { task: fromTask, tab: sibling };
  }
  for (const row of tabmailDestinations(fromTask.id, fromTab.id)) {
    const [rowTitle, rowTab] = [row.name.slice(0, row.name.lastIndexOf(' / ')), row.name.slice(row.name.lastIndexOf(' / ') + 3)];
    if (lower(rowTab) !== lower(tabName)) continue;
    if (threadTitle && lower(rowTitle) !== lower(threadTitle)) continue;
    matches.push(row);
  }
  if (!matches.length) throw tabmailError(404, `No tab named "${String(to.name).trim()}". Call list_tabs for the names.`);
  if (matches.length > 1) throw tabmailError(409, `More than one tab is named "${tabName}"; say "Workstream / Tab".`);
  const task = matches[0].threadId === fromTask.id ? fromTask : getTask(matches[0].threadId);
  const tab = (task?.tabs || []).find((candidate) => candidate.id === matches[0].tabId);
  if (!task || !tab) throw tabmailError(404, 'That tab is gone. Call list_tabs for the names.');
  return { task, tab };
}

// The chain a fresh message to that tab joins: the latest one this tab has
// with it, unless a person wrote here since (a wake's hidden prompt is not
// a person), in which case the next message starts a new chain.
function tabmailRows(tab) {
  return [...(tab.messages || []), ...(tab.tabmailHold || []), ...(tab.tabmailOut || [])];
}
function tabmailOpenChain(tab, otherTask, otherTab) {
  const isOther = (address) => !!address && address.tabId === otherTab.id && (address.threadId || otherTask.id) === otherTask.id;
  let chainId = null;
  for (const message of tabmailRows(tab)) {
    if (message.role === 'user' && !message.hiddenInTranscript) { chainId = null; continue; }
    if (message.role === 'tab' && (isOther(message.to) || isOther(message.from)) && message.chainId) chainId = message.chainId;
  }
  return chainId;
}
// A chain's hop is one past the highest hop anyone has sent in it, whichever
// message the new one answers.
function tabmailChainHop(chainId, tabs) {
  let highest = 0;
  for (const tab of tabs) for (const message of tabmailRows(tab)) if (message.role === 'tab' && message.chainId === chainId) highest = Math.max(highest, Number(message.hop) || 0);
  return highest;
}

// The held messages a landing releases, less any the thread already has: a
// message lands in a tab once, whatever brought its hold back.
function heldNotYetIn(tab) {
  const have = new Set((tab.messages || []).map((message) => message.id).filter(Boolean));
  const out = [];
  for (const message of tab.tabmailHold || []) {
    if (message?.id && have.has(message.id)) continue;
    if (message?.id) have.add(message.id);
    out.push(message);
  }
  return out;
}

function sendTabMessage({ fromTaskId, fromTabId, to, text, replyTo, viaEmail = false, wake = true }) {
  const fromTask = getTask(String(fromTaskId || ''));
  const fromTab = (fromTask?.tabs || []).find((candidate) => candidate.id === String(fromTabId || ''));
  if (!fromTask || !fromTab) throw tabmailError(404, 'The sending tab is gone.');
  const content = String(text || '').trim().slice(0, TABMAIL_MAX_CHARS);
  if (!content) throw tabmailError(400, 'The message is empty.');
  const { task: toTask, tab: toTab } = resolveTabTarget(fromTask, fromTab, to);
  if (toTask.id === fromTask.id && toTab.id === fromTab.id) throw tabmailError(400, 'That is this tab.');
  if (toTab.type === 'duel') throw tabmailError(400, 'A Duel tab cannot take messages.');
  if (toTask.archived) throw tabmailError(409, 'That workstream is archived.');
  let chainId = null;
  let replyPair = null;
  if (replyTo) {
    const ref = tabmailRows(fromTab).find((candidate) => candidate.role === 'tab' && (candidate.id === replyTo || candidate.pairId === replyTo));
    if (ref) {
      chainId = ref.chainId || null;
      replyPair = ref.pairId || ref.id;
    }
  }
  if (!chainId) chainId = tabmailOpenChain(fromTab, toTask, toTab);
  const hop = (chainId ? tabmailChainHop(chainId, [fromTab, toTab]) : 0) + 1;
  if (!chainId) chainId = newId();
  if (hop > TABMAIL_HOP_LIMIT) throw tabmailError(429, `This exchange has reached ${TABMAIL_HOP_LIMIT} messages without a person. Stop here and tell the user what you need from them.`);
  const ts = new Date().toISOString();
  const pairId = newId();
  // Section 32, board 32.4a: a message that carries a forwarded email wears
  // the Email chip on both ends.
  const chain = { pairId, chainId, hop, ...(replyPair ? { replyTo: replyPair } : {}), ...(viaEmail ? { viaEmail: true } : {}) };
  const outbound = { id: newId(), role: 'tab', direction: 'out', to: addressOf(toTask, toTab), content, ts, ...chain };
  const inbound = { id: newId(), role: 'tab', direction: 'in', from: addressOf(fromTask, fromTab), content, ts, ...chain };
  if (tabIsRunning(fromTask, fromTab)) {
    // Where in the answer the tool call happened: text the model wrote
    // before it stays above the row at landing, text after stays below.
    const run = [...runs.values()].find((candidate) => candidate.taskId === fromTask.id && candidate.tabId === fromTab.id);
    outbound.atText = run ? String(runPublic(run)?.text || '').length : 0;
    fromTab.tabmailOut = [...(fromTab.tabmailOut || []), outbound];
  }
  else { fromTab.messages = [...(fromTab.messages || []), outbound]; bumpSessionCounts(fromTab, 1); }
  const held = tabIsRunning(toTask, toTab);
  if (held) toTab.tabmailHold = [...(toTab.tabmailHold || []), inbound];
  else { toTab.messages = [...(toTab.messages || []), inbound]; bumpSessionCounts(toTab, 1); }
  toTask.lastActivity = ts;
  saveTask(fromTask);
  if (toTask !== fromTask) saveTask(toTask);
  console.info(`[tabmail] ${addressName(addressOf(fromTask, fromTab))} -> ${addressName(outbound.to)} hop=${hop} chain=${chainId.slice(0, 8)}${held ? ' (receiver mid run, held)' : ''}`);
  if (!held && wake) wakeTabForMessages(toTask.id, toTab.id);
  return { ok: true, to: addressName(outbound.to), inboundId: inbound.id, outboundId: outbound.id };
}

const TRAFFIC_MAX = 200;
function trafficEvent(task, event) {
  const row = { id: newId(), at: new Date().toISOString(), kind: 'roster', by: 'orchestrator', undone: false, ...event };
  task.traffic = [...(task.traffic || []), row].slice(-TRAFFIC_MAX);
  return row;
}
function rosterCard(task, ref) {
  return normalizeMap(task, getTask).cards[cardKey(ref.threadId, ref.tabId)] || null;
}
// Write one card, adding it if it is not on the map (an own card taken off
// comes back as it was); the other workstream remembers the map.
function rosterPut(task, ref, fields) {
  const map = normalizeMap(task, getTask);
  const key = cardKey(ref.threadId, ref.tabId);
  const previous = map.cards[key] || (ref.threadId === task.id && task.map?.cards?.[key]?.hidden ? task.map.cards[key] : null);
  const card = { ...cleanCard({ ...(previous || {}), ...fields, hidden: false }), threadId: ref.threadId, tabId: ref.tabId };
  delete card.hidden;
  map.cards[key] = card;
  task.map = mergeHidden(task, map);
  task.map.cards[key] = card;
  if (ref.threadId !== task.id) {
    const other = getTask(ref.threadId);
    if (other && !(other.mapMemberships || []).includes(task.id)) { other.mapMemberships = [...(other.mapMemberships || []), task.id]; saveTask(other); }
  }
  return card;
}
// Take one card off the way the map's own x does: an own tab's card hides,
// a foreign card goes and its workstream forgets the map when none is left.
function rosterDrop(task, ref) {
  const map = normalizeMap(task, getTask);
  const key = cardKey(ref.threadId, ref.tabId);
  const taken = map.cards[key];
  if (!taken) return null;
  delete map.cards[key];
  map.edges = map.edges.filter((edge) => refKey(edge.from) !== key && refKey(edge.to) !== key);
  task.map = mergeHidden(task, map);
  if (ref.threadId === task.id) task.map.cards[key] = { ...cleanCard({ ...taken, hidden: true }), threadId: ref.threadId, tabId: ref.tabId };
  else if (!Object.values(map.cards).some((card) => card.threadId === ref.threadId)) {
    const other = getTask(ref.threadId);
    if (other && (other.mapMemberships || []).includes(task.id)) { other.mapMemberships = other.mapMemberships.filter((id) => id !== task.id); saveTask(other); }
  }
  return taken;
}
function rosterAction(body) {
  const task = getTask(String(body.taskId || ''));
  const tab = (task?.tabs || []).find((candidate) => candidate.id === String(body.tabId || ''));
  if (!task || !tab) throw tabmailError(404, 'The asking tab is gone.');
  if (tab.type !== 'orchestrator') throw tabmailError(403, 'Only an orchestrator tab keeps a roster.');
  const action = String(body.action || '');
  const why = String(body.why || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const suffix = why ? `, ${why.replace(/[.\s]+$/, '')}` : '';
  const line = body.line == null ? null : String(body.line).replace(/\s+/g, ' ').trim();
  const owes = body.owes == null ? null : String(body.owes).replace(/\s+/g, ' ').trim().slice(0, 40);
  const at = new Date().toISOString();
  if (action === 'new') {
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) throw tabmailError(400, 'Give the new tab a name.');
    const made = makeTab({ name, model: tab.model });
    task.tabs = [...(task.tabs || []), made];
    const ref = { threadId: task.id, tabId: made.id };
    const card = rosterPut(task, ref, { description: line || '', owes: owes || '', by: 'orchestrator', addedAt: at });
    const event = trafficEvent(task, { action: 'new', tab: addressOf(task, made), text: `Made ${name}${suffix}`, after: { description: card.description, owes: card.owes || '' } });
    saveTask(task);
    return { ok: true, tab: addressName(event.tab), text: `${name} is on your roster, as "${addressName(event.tab)}".`, event: event.id };
  }
  const target = body.tab && typeof body.tab === 'object' ? body.tab : { name: String(body.tab || '') };
  const { task: toTask, tab: toTab } = resolveTabTarget(task, tab, target);
  if (toTask.id === task.id && toTab.id === tab.id) throw tabmailError(400, 'That is this tab.');
  if (toTab.type === 'duel') throw tabmailError(400, 'A Duel tab cannot be on the roster.');
  const ref = { threadId: toTask.id, tabId: toTab.id };
  const address = addressOf(toTask, toTab);
  const existing = rosterCard(task, ref);
  if (action === 'add') {
    if (existing) throw tabmailError(409, `${addressName(address)} is already on the roster.`);
    const card = rosterPut(task, ref, { description: line || '', owes: owes || '', by: 'orchestrator', addedAt: at });
    const event = trafficEvent(task, { action: 'add', tab: address, text: `Put ${address.name} on the map${suffix}`, after: { description: card.description, owes: card.owes || '' } });
    saveTask(task);
    return { ok: true, tab: addressName(address), text: `${addressName(address)} is on your roster.`, event: event.id };
  }
  if (!existing) throw tabmailError(404, `${addressName(address)} is not on the roster. Call list_tabs, or roster_add it first.`);
  if (action === 'remove') {
    if (existing.by !== 'orchestrator') throw tabmailError(409, `The person put ${address.name} on the map; only they can take it off.`);
    const key = cardKey(ref.threadId, ref.tabId);
    if (normalizeMap(task, getTask).edges.some((edge) => refKey(edge.from) === key || refKey(edge.to) === key)) throw tabmailError(409, `The person connected ${address.name}; only they can take it off.`);
    const taken = rosterDrop(task, ref);
    const event = trafficEvent(task, { action: 'remove', tab: address, text: `Took ${address.name} off the map${suffix}`, before: { ...cleanCard(taken) } });
    saveTask(task);
    return { ok: true, tab: addressName(address), text: `${addressName(address)} is off your roster.`, event: event.id };
  }
  if (action === 'write') {
    if (line == null && owes == null) throw tabmailError(400, 'Say the line, what it owes, or both.');
    const before = { description: existing.description || '', owes: existing.owes || '' };
    const card = rosterPut(task, ref, { ...existing, ...(line != null ? { description: line } : {}), ...(owes != null ? { owes } : {}) });
    // The traffic row keeps to a line; the card keeps the whole text.
    const shortLine = card.description.length > 90 ? `${card.description.slice(0, 89).replace(/[\s,;:]+$/, '')}…` : card.description;
    const parts = [];
    if (line != null) parts.push(`${address.name}'s line, "${shortLine}"`);
    if (owes != null) parts.push(`${address.name} owes ${card.owes || 'nothing'}`);
    const event = trafficEvent(task, { action: 'write', tab: address, text: `Wrote ${parts.join('; ')}${suffix}`, before, after: { description: card.description || '', owes: card.owes || '' } });
    saveTask(task);
    return { ok: true, tab: addressName(address), text: `Written for ${addressName(address)}.`, event: event.id };
  }
  throw tabmailError(400, 'Unknown roster action.');
}
// The person's undo: put back what the write replaced, and say so on the
// record. A tab the orchestrator made goes if it never ran, and archives
// if it did.
function undoTraffic(task, eventId) {
  const event = (task.traffic || []).find((row) => row.id === eventId);
  if (!event) throw tabmailError(404, 'No such traffic.');
  if (event.undone) throw tabmailError(409, 'Already undone.');
  const ref = { threadId: event.tab.threadId, tabId: event.tab.tabId };
  const at = new Date().toISOString();
  if (event.action === 'add') rosterDrop(task, ref);
  else if (event.action === 'new') {
    rosterDrop(task, ref);
    if (task.map?.cards) delete task.map.cards[cardKey(ref.threadId, ref.tabId)];
    const index = (task.tabs || []).findIndex((candidate) => candidate.id === ref.tabId);
    if (index >= 0) {
      const [made] = task.tabs.splice(index, 1);
      if ((made.messages || []).length) task.archivedTabs = [...(task.archivedTabs || []), { ...made, archivedAt: at, archivedIndex: index }];
      else task.deletedTabs = [...(task.deletedTabs || []), { id: made.id, at }].slice(-200);
      if (task.activeTab === made.id) task.activeTab = (task.tabs || [])[0]?.id || null;
    }
  }
  else if (event.action === 'remove') rosterPut(task, ref, { ...(event.before || {}), hidden: false });
  else if (event.action === 'write') rosterPut(task, ref, { ...(rosterCard(task, ref) || {}), ...(event.before || {}) });
  event.undone = true;
  event.undoneAt = at;
  saveTask(task);
  return event;
}

const TABMAIL_WAKE_PROMPT = 'Read the messages from other tabs above and act on them.';
const TABMAIL_WAKE_COOLDOWN_MS = 20_000;
const TABMAIL_WAKE = process.env.WB_TABMAIL_WAKE !== '0';
const tabmailWakes = new Map();
function wakeTabForMessages(taskId, tabId, { delayMs = 250 } = {}) {
  if (!TABMAIL_WAKE) return;
  const timer = setTimeout(() => {
    try {
      const task = getTask(taskId);
      const tab = task && !task.archived ? (task.tabs || []).find((candidate) => candidate.id === tabId) : null;
      if (!tab || tab.type === 'duel' || tab.archived || tabIsRunning(task, tab)) return;
      const waiting = waitingTabMessages(tab).length;
      if (!waiting) return;
      const key = `${taskId}::${tabId}`;
      // Inside the cooldown the wake waits it out instead of being dropped:
      // a message that came in moments after the last wake used to sit
      // unread until something else ran the tab (section 33, two deal
      // replies a few seconds apart). The check runs again then, and does
      // nothing if the messages were read meanwhile.
      const since = Date.now() - (tabmailWakes.get(key) || 0);
      if (since < TABMAIL_WAKE_COOLDOWN_MS) { wakeTabForMessages(taskId, tabId, { delayMs: TABMAIL_WAKE_COOLDOWN_MS - since + 100 }); return; }
      tabmailWakes.set(key, Date.now());
      console.info(`[tabmail] ${addressName(addressOf(task, tab))} wakes for ${waiting} waiting`);
      fetch(`http://127.0.0.1:${PORT}/api/tasks/${encodeURIComponent(taskId)}/tabs/${encodeURIComponent(tabId)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: TABMAIL_WAKE_PROMPT, hiddenPrompt: true }),
      }).then(async (response) => {
        if (!response.ok) { console.error(`[tabmail] wake of ${addressName(addressOf(task, tab))} refused ${response.status}: ${(await response.text()).slice(0, 200)}`); return; }
        // The run writes its own transcript; the stream is only drained.
        for await (const _chunk of response.body) { /* drained */ }
      }).catch((err) => console.error('[tabmail] wake failed:', err.message));
    } catch (err) {
      console.error('[tabmail] wake failed:', err.message);
    }
  }, delayMs);
  timer.unref?.();
}

// Section 29, scheduled tasks by tab: the clock in front of the run route.
// A fire is the task's instructions sent into its tab through the service's
// own run route, the way a wake is, so every window sees it as it sees any
// run and the thread is where it is read. The arithmetic and the store are
// lib/scheduled.mjs; this is the timer and the send. WB_SCHEDULED=0 keeps
// the clock still, and WB_SCHEDULE_TICK_MS lets a smoke run it fast.
const SCHEDULED_ON = process.env.WB_SCHEDULED !== '0';
const SCHEDULE_TICK_MS = Math.max(250, Number(process.env.WB_SCHEDULE_TICK_MS) || 20_000);
const scheduleBootAt = Date.now();
let scheduleLastTick = Date.now();
// The last time the clock jumped between ticks: the Mac was asleep.
let scheduleGap = null;
let scheduleTicking = false;
const scheduleFiring = new Set();

function publicSchedule(schedule) {
  const running = scheduleFiring.has(schedule.id) || [...runs.values()].some((run) => run.scheduled?.id === schedule.id);
  const { pending: _pending, ...rest } = schedule;
  return { ...rest, running };
}

async function fireSchedule(schedule, { dueAt = null, missed = 0, busy = false, manual = false } = {}) {
  const ranAt = new Date().toISOString();
  const due = dueAt || ranAt;
  const task = getTask(schedule.threadId);
  const tab = task ? (task.tabs || []).find((candidate) => candidate.id === schedule.tabId) : null;
  if (!task || !tab || tab.archived || task.archived) {
    // Nothing left to run in: say so in History and stop asking, rather
    // than failing again every morning.
    const why = task?.archived && tab ? 'Its workstream is archived, so the task is paused.' : 'Its tab is gone, so the task is paused.';
    scheduled.recordFire(schedule.id, { dueAt: due, ranAt, missed, manual, error: why, pause: true });
    if (!manual) missedToPhone(schedule, why);
    return { status: 404, error: why };
  }
  if (tabIsRunning(task, tab) || [...runs.values()].some((run) => run.taskId === task.id && run.tabId === tab.id)) {
    // The tab is mid turn. The fire waits for it and lands under it, late,
    // and its line says why.
    if (!manual) scheduled.markBusy(schedule.id);
    return { status: 409, busy: true, error: 'That tab is running. Run now works once it lands.' };
  }
  const fireId = newId();
  const reason = manual ? null : scheduled.lateReason({ dueAt: due, ranAt, bootAt: scheduleBootAt, busy, gap: scheduleGap });
  scheduleFiring.add(schedule.id);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${encodeURIComponent(task.id)}/tabs/${encodeURIComponent(tab.id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: schedule.instructions, scheduled: { id: schedule.id, fireId, dueAt: due, missed, reason, manual } }),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      let message = text;
      try { message = JSON.parse(text).error || text; } catch { /* plain text */ }
      scheduleFiring.delete(schedule.id);
      if (response.status === 409 && /already running/i.test(message)) {
        if (!manual) scheduled.markBusy(schedule.id);
        return { status: 409, busy: true, error: 'That tab is running. Run now works once it lands.' };
      }
      // A failed run is a failed run (board 29.7, 04): written down once,
      // never tried again into the next slot.
      console.error(`[scheduled] "${schedule.name}" did not run: ${message}`);
      scheduled.recordFire(schedule.id, { id: fireId, dueAt: due, ranAt, missed, reason, manual, error: message }, { clearPending: !manual });
      if (!manual) missedToPhone(schedule, message);
      return { status: response.status, error: message };
    }
    console.info(`[scheduled] "${schedule.name}" sent into ${addressName(addressOf(task, tab))}${missed ? `, ${missed} not run` : ''}${reason ? ` (${reason})` : ''}`);
    scheduled.recordFire(schedule.id, { id: fireId, dueAt: due, ranAt, missed, reason, manual }, { clearPending: !manual });
    // The run writes its own transcript; the stream is only drained.
    void (async () => {
      try { for await (const _chunk of response.body) { /* drained */ } } catch { /* the run route owns its errors */ }
      scheduleFiring.delete(schedule.id);
    })();
    return { status: 200, fireId };
  } catch (err) {
    scheduleFiring.delete(schedule.id);
    console.error('[scheduled] fire failed:', err.message);
    scheduled.recordFire(schedule.id, { id: fireId, dueAt: due, ranAt, missed, reason, manual, error: err.message || 'The run did not start.' }, { clearPending: !manual });
    if (!manual) missedToPhone(schedule, err.message || 'The run did not start.');
    return { status: 500, error: err.message || 'The run did not start.' };
  }
}

// Section 33: a fire that never became a run is as worth knowing about away
// from the Mac as one that landed. Run now is pressed at the Mac, so it is
// left to the window.
function missedToPhone(schedule, why) {
  const message = phoneMessage({ name: schedule.name, outcome: 'missed', error: why });
  void pushToPhone(relay.sessionInfo(), { ...message, threadId: schedule.threadId, tabId: schedule.tabId, kind: 'missed' });
}

async function scheduleTick() {
  if (!SCHEDULED_ON || scheduleTicking) return;
  scheduleTicking = true;
  try {
    const now = Date.now();
    if (now - scheduleLastTick > SCHEDULE_TICK_MS * 3 + 5_000) scheduleGap = { from: scheduleLastTick, to: now };
    scheduleLastTick = now;
    for (const schedule of scheduled.listSchedules()) {
      if (scheduleFiring.has(schedule.id) || (!schedule.enabled && !schedule.pending)) continue;
      const owed = scheduled.takeDue(schedule.id, now);
      if (owed) await fireSchedule(schedule, owed);
    }
  } catch (err) {
    console.error('[scheduled] tick failed:', err.message);
  } finally {
    scheduleTicking = false;
  }
}

// A send goes where the tool call happened in the answer (design 26.2): the
// text before it becomes an interim part above the row, the text after
// stays the answer below it; a send after the last word sits after the
// answer. The final part keeps the answer's accounting.
function answerWithSends(answer, sends) {
  const content = String(answer.content || '');
  const chunks = [];
  let cursor = 0;
  for (const sent of sends) {
    const at = Math.max(cursor, Math.min(Number(sent.atText) || 0, content.length));
    delete sent.atText;
    chunks.push({ text: content.slice(cursor, at), sends: [sent] });
    cursor = at;
  }
  chunks.push({ text: content.slice(cursor), sends: [] });
  const merged = [];
  for (const chunk of chunks) {
    if (!chunk.text.trim() && merged.length) merged[merged.length - 1].sends.push(...chunk.sends);
    else merged.push({ text: chunk.text, sends: [...chunk.sends] });
  }
  let lastText = -1;
  merged.forEach((chunk, index) => { if (chunk.text.trim()) lastText = index; });
  if (lastText < 0) return [answer, ...sends];
  const out = [];
  merged.forEach((chunk, index) => {
    if (chunk.text.trim()) {
      out.push(index === lastText
        ? { ...answer, content: chunk.text }
        : { ...answer, id: newId(), content: chunk.text, interim: true, usage: null, costUsd: null, tools: [], computer: null, connectors: [] });
    }
    out.push(...chunk.sends);
  });
  return out;
}

function tabmailRead(fromTaskId, fromTabId, to, limit) {
  const fromTask = getTask(String(fromTaskId || ''));
  const fromTab = (fromTask?.tabs || []).find((candidate) => candidate.id === String(fromTabId || ''));
  if (!fromTask || !fromTab) throw tabmailError(404, 'The asking tab is gone.');
  const { task, tab } = resolveTabTarget(fromTask, fromTab, to);
  const count = Math.max(1, Math.min(20, Number(limit) || 8));
  const rows = (tab.messages || [])
    .filter((message) => !message.hiddenInTranscript && String(message.content || '').trim())
    .slice(-count)
    .map((message) => ({
      who: message.role === 'user' ? 'User' : message.role === 'tab' ? (message.direction === 'in' ? `Message from ${addressName(message.from)}` : `Sent to ${addressName(message.to)}`) : 'Assistant',
      text: String(message.content).replace(/\s+/g, ' ').trim().slice(0, 1_500),
    }));
  return { name: addressName(addressOf(task, tab)), messages: rows };
}

// ---------------------------------------------------------------------------
// platform-context suggestions — after a run that touched a platform, a cheap
// background model call proposes durable entries. Proposals land in the
// record's suggestions list only; the user reviews and locks them on the
// Context page. No model connected → no suggestions, never a fabricated one.

const platformSuggestionRuns = new Set(); // platform keys in flight

function schedulePlatformSuggestions(keys, turn) {
  for (const key of keys) {
    if (platformSuggestionRuns.has(key)) continue;
    platformSuggestionRuns.add(key);
    generatePlatformSuggestions(key, turn)
      .catch((error) => console.error(`[suggestions] ${key} failed: ${error.message}`))
      .finally(() => platformSuggestionRuns.delete(key));
  }
}

async function generatePlatformSuggestions(key, turn) {
  const definition = platformContextDefinition(key, currentPlatformDefinitions());
  const model = tabSummaryModel();
  if (!definition || !model) return;
  const record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let result = null;
  try {
    const providerResult = await runModel({
      thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: false, messages: [], sessions: {}, model: model.id },
      model,
      prompt: platformSuggestionPrompt({ definition, record, turn }),
      images: [],
      priorCount: 0,
      signal: controller.signal,
      effort: 'Low',
      control: {},
    }, () => {});
    if (providerResult?.ok) result = parsePlatformContextResult(providerResult.text);
  } finally {
    clearTimeout(timer);
  }
  if (!result?.entries?.length) return;
  const fresh = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
  if (mergePlatformSuggestions(fresh, result.entries)) savePlatformContextRecord(definition.key, fresh);
}

function summarizeStat(stat) {
  if (!stat) return null;
  const lines = stat.trim().split('\n');
  return lines[lines.length - 1].trim() || null;
}

// The claude.ai connector MCP servers the `claude` CLI is signed into. Parsed
// from `claude mcp list`; cached because that command runs health checks and is
// slow. These are what a connectors-on Claude agent can actually reach.
let _connectorCache = { at: 0, list: [] };

function cachedConnectorList() {
  return ONBOARDING_LAB_ENABLED ? onboardingLabState.connectors : _connectorCache.list;
}

// Usage ledger for the Connectors page. First read on an install with history
// rebuilds product counts from saved transcripts and seeds from the model
// CLIs' own session logs; after that it is push-on-write (recordConnectorUses).
function ensureConnectorUsage() {
  let usage = loadConnectorUsage();
  if (!usage.rebuiltAt || !usage.seenBy) usage = rebuildConnectorUsage(listTasks().map((summary) => getTask(summary.id)).filter(Boolean), { providerOf: (id) => resolveModel(id)?.provider || null });
  if (!usage.seededAt) usage = seedConnectorUsageFromHistory();
  return usage;
}

// Context platforms right now: the curated six plus every connected
// connector, ordered the way the Connectors page orders them.
function currentPlatformDefinitions(list = cachedConnectorList()) {
  const overview = connectorOverview(list, loadConnectorUsage());
  return platformContextDefinitions({ connectors: list, order: connectorOrder(overview) });
}

function execProviderText(binary, args) {
  return new Promise((resolve) => {
    if (!binary) return resolve('');
    execFile(binary, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (_error, stdout) => {
      resolve((stdout || '').toString());
    });
  });
}

function parseClaudeConnectors(output) {
  return String(output || '').split('\n').flatMap((line) => {
    // "claude.ai Gmail: https://... - ✔ Connected" and local stdio servers
    // share the same final status marker. Keep commands and credentials out of
    // the public response; onboarding needs only name, provider, and health.
    const match = line.match(/^(.*?):\s*(.*?)\s+-\s+(.+)$/);
    if (!match) return [];
    const name = match[1].replace(/^claude\.ai\s+/i, '').trim();
    if (!name || /^(?:plugin:|workspace$)/i.test(name)) return [];
    const raw = match[3].trim();
    const connected = /connected|✔|✓/i.test(raw) && !/needs auth|failed|error/i.test(raw);
    const url = match[2].match(/https?:\/\/\S+/)?.[0] || '';
    return [{
      name,
      url,
      connected,
      status: connected ? 'connected' : /needs auth/i.test(raw) ? 'sign-in required' : 'not responding',
      provider: 'claude',
    }];
  });
}

function parseCodexConnectors(output) {
  const internal = /^(?:codex_app|computer-use|node_repl|openaiDeveloperDocs)$/i;
  return String(output || '').split('\n').flatMap((line) => {
    const columns = line.trim().split(/\s{2,}/).filter(Boolean);
    const name = columns[0] || '';
    if (!name || /^Name$/i.test(name) || internal.test(name)) return [];
    const status = columns.find((value) => /^(?:enabled|disabled)$/i.test(value));
    if (!status) return [];
    const enabled = status.toLowerCase() === 'enabled';
    const auth = columns.at(-1) || '';
    const url = columns.find((value) => /^https?:\/\//i.test(value)) || '';
    // The Auth column is the truth for a remote server: a Codex update can
    // drop its OAuth session (0.153.0 did, 2026-09-03) while the server stays
    // enabled, and the page said Granola was live for ChatGPT when it was not.
    const needsLogin = /not logged in|needs login|login required/i.test(auth);
    return [{
      name: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      // The raw config name, so a per-tab scope can disable the server with
      // `-c mcp_servers.<name>.enabled=false`.
      server: name,
      url,
      connected: enabled && !needsLogin,
      status: !enabled ? 'off' : needsLogin ? 'sign-in required' : (/oauth/i.test(auth) ? 'configured' : 'enabled'),
      provider: 'codex',
    }];
  });
}

// Services connected inside the ChatGPT account arrive as Codex plugins, not
// MCP servers, so `codex mcp list` never shows them. The bundled runtime
// marketplaces carry tooling (pdf, browser, computer-use…), not account
// connections; everything outside them is a service the user linked.
function parseCodexPlugins(output) {
  const toolingMarketplace = /^(?:openai-primary-runtime|openai-bundled)$/i;
  const toolingName = /^(?:codex_app|computer-use|node_repl|openaiDeveloperDocs|browser|chrome|documents|pdf|spreadsheets|presentations|template-creator|sites|record-and-replay|latex|visualize)$/i;
  try {
    const text = String(output || '');
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    return (parsed.installed || []).flatMap((plugin) => {
      const name = String(plugin?.name || '').trim();
      if (!name || plugin.installed === false) return [];
      if (toolingMarketplace.test(String(plugin.marketplaceName || '')) || toolingName.test(name)) return [];
      const enabled = plugin.enabled !== false;
      return [{
        name: name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
        url: '',
        connected: enabled,
        status: enabled ? 'enabled in ChatGPT' : 'off',
        provider: 'codex',
      }];
    });
  } catch {
    return [];
  }
}

async function listConnectors({ fresh = false } = {}) {
  if (ONBOARDING_LAB_ENABLED) return onboardingLabState.connectors;
  if (!fresh && Date.now() - _connectorCache.at < 60_000) return _connectorCache.list;
  const [claudeOutput, codexOutput, codexPluginOutput] = await Promise.all([
    execProviderText(resolveCliBinary('claude'), ['mcp', 'list']),
    execProviderText(resolveCliBinary('codex'), ['mcp', 'list']),
    execProviderText(resolveCliBinary('codex'), ['plugin', 'list', '--json']),
  ]);
  const merged = [...parseClaudeConnectors(claudeOutput), ...parseCodexConnectors(codexOutput), ...parseCodexPlugins(codexPluginOutput)];
  // Collapse duplicate discovery paths inside one provider (for example a
  // ChatGPT connector exposed by both MCP and plugin discovery), but preserve
  // the Claude + Codex copies. connectorOverview needs both to show which
  // model accounts can use the same logical connector and which needs sign-in.
  const seen = new Set();
  const list = merged.filter((connector) => {
    const key = `${connector.provider}:${connector.name.toLowerCase().replace(/[\s_-]+/g, ' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  _connectorCache = { at: Date.now(), list };
  noteConnectorScan(list);
  return list;
}

async function platformContextPayload(key = null) {
  const settings = getSettings();
  const status = probeStatus();
  const connectors = await listConnectors().catch(() => []);
  const definitions = currentPlatformDefinitions(connectors);
  const snapshot = platformContextSnapshot(settings, { status, connectors, definitions });
  if (!key) return { platforms: snapshot.platforms };
  const definition = platformContextDefinition(key, definitions);
  if (!definition) return null;
  const summary = snapshot.platforms.find((candidate) => candidate.key === definition.key)
    || { key: definition.key, name: definition.name, mark: definition.mark, savedCount: 0, draftCount: 0, hasSuggestions: false, access: platformAccess(definition, { status, connectors }) };
  const record = snapshot.records[definition.key] || platformContextRecord(snapshot.records, definition.key, definitions);
  return {
    platform: summary,
    context: publicPlatformContextRecord(record, definition, summary.access),
  };
}

function savePlatformContextRecord(key, record) {
  const settings = getSettings();
  const normalized = normalizePlatformContexts(settings.platformContexts, currentPlatformDefinitions());
  normalized[key] = record;
  settings.platformContexts = normalized;
  saveSettings(settings);
  return record;
}

function providerReadyForContext(model, status) {
  return !!model && (model.provider === 'openrouter'
    ? !!status?.providers?.openrouter?.ready
    : !!status?.providers?.[model.provider]?.ready);
}

function platformContextModel({ mode, access, prompt }) {
  const status = probeStatus();
  const modelForProvider = (provider) => provider === 'codex'
    ? resolveModel('gpt-6.1-sol')
    : provider === 'claude' ? resolveModel('sonnet') : null;
  if (mode === 'history' && access?.provider) {
    const matched = modelForProvider(access.provider);
    if (providerReadyForContext(matched, status)) return matched;
  }
  const settings = getSettings();
  const configuredId = settings.defaultModel || RECOMMENDED_MODEL_ID;
  const recommended = configuredId === RECOMMENDED_MODEL_ID
    ? recommendModel({ prompt, policy: settings.performancePolicy })?.modelId
    : configuredId;
  const configured = resolveModel(recommended);
  if (providerReadyForContext(configured, status)) return configured;
  const fallback = MODELS
    .map((candidate) => resolveModel(candidate.id))
    .find((candidate) => providerReadyForContext(candidate, status));
  return fallback || null;
}

function manualPlatformContextFallback(prompt, record) {
  const clean = String(prompt || '').replace(/\r\n/g, '\n').trim().slice(0, 12_000);
  const current = (record.draftEntries?.length ? record.draftEntries : record.entries || []).map((candidate) => candidate.text);
  const additions = clean.split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const combined = current.length ? [...current, ...additions] : additions;
  return {
    entries: [...new Set(combined.map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 24),
    summary: current.length ? 'I added that as a separate draft entry.' : 'I drafted Context from your words.',
    exampleCount: null,
    examples: [],
    needsAccess: false,
    accessMessage: '',
  };
}

async function runPlatformContextTurn({ req, res, definition }) {
  if (platformContextRuns.has(definition.key)) {
    return send(res, 409, { error: `${definition.name} Context is already working.` });
  }
  const body = await readBody(req);
  const userPrompt = String(body.prompt || '').trim().slice(0, 12_000);
  const mode = body.mode === 'history' ? 'history' : 'manual';
  if (!userPrompt) return send(res, 400, { error: 'Tell Context what to learn.' });

  const payload = await platformContextPayload(definition.key);
  const access = payload.context.access;
  let record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
  appendPlatformContextMessage(record, 'user', userPrompt);
  if (mode === 'history' && !access?.ready) {
    const message = access?.detail || `Connect ${definition.name} first. You can still enter Context manually.`;
    appendPlatformContextMessage(record, 'assistant', message, 'access');
    savePlatformContextRecord(definition.key, record);
    return send(res, 409, {
      error: message,
      manualAvailable: true,
      context: publicPlatformContextRecord(record, definition, access),
    });
  }
  savePlatformContextRecord(definition.key, record);

  const model = platformContextModel({ mode, access, prompt: userPrompt });
  if (!model && mode === 'history') {
    const message = 'Connect ChatGPT or Claude before pulling examples. You can still enter Context manually.';
    record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
    appendPlatformContextMessage(record, 'assistant', message, 'access');
    savePlatformContextRecord(definition.key, record);
    return send(res, 409, {
      error: message,
      manualAvailable: true,
      context: publicPlatformContextRecord(record, definition, access),
    });
  }

  const runId = newId();
  const controller = new AbortController();
  const run = {
    id: runId,
    controller,
    control: {},
    taskId: newId(),
    tabId: newId(),
    platformContextKey: definition.key,
    model: model?.id || null,
    requestedModel: model?.id || null,
    recommendation: null,
    handoff: null,
    terminalContexts: [],
    attachments: [],
    prompt: userPrompt,
    prompts: [userPrompt],
    steers: [],
    hiddenPrompt: false,
    effort: body.effort || 'Medium',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    seq: 0,
    events: [],
  };
  runs.set(runId, run);
  platformContextRuns.set(definition.key, runId);
  refreshKeepAwake();
  const stream = sseStart(res);
  const emit = (event) => {
    const recorded = recordRunEvent(runId, event) || event;
    stream(publicRunEvent(recorded));
  };
  emit({ type: 'start', runId, model: model?.id || null, requestedModel: model?.id || null, effort: run.effort, platform: definition.key });

  let lastError = '';
  let providerResult = null;
  try {
    if (model) {
      const modelPrompt = platformContextRunPrompt({ definition, mode, userPrompt, record });
      providerResult = await runModel({
        thread: {
          cwd: DATA_DIR,
          extraDirs: [],
          tools: mode === 'history' ? 'full' : 'off',
          connectors: mode === 'history' && definition.accessKind === 'connector',
          messages: [],
          sessions: {},
          model: model.id,
        },
        model,
        prompt: modelPrompt,
        images: [],
        priorCount: 0,
        signal: controller.signal,
        effort: run.effort,
        control: run.control,
      }, (event) => {
        if (event.type === 'error') lastError = String(event.message || '');
        emit(event);
      });
    }

    if (controller.signal.aborted) {
      emit({ type: 'stopped', text: '' });
      stream({ type: 'context-stopped', platform: definition.key });
      return;
    }

    let result = model ? parsePlatformContextResult(providerResult?.text) : null;
    if ((!providerResult?.ok || !result) && mode === 'manual') result = manualPlatformContextFallback(userPrompt, record);
    if (!result) throw new Error(lastError || `Could not pull ${definition.name} history. Try again.`);

    record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
    const assistantCopy = platformContextAssistantCopy(result, mode);
    if (result.needsAccess) {
      appendPlatformContextMessage(record, 'assistant', assistantCopy, 'access');
    } else {
      if (!result.entries.length) throw new Error('No usable Context entries came back. Refine the request and try again.');
      replacePlatformContextDraft(record, result, definition, mode);
      appendPlatformContextMessage(record, 'assistant', assistantCopy);
    }
    savePlatformContextRecord(definition.key, record);
    const latestPayload = await platformContextPayload(definition.key);
    stream({ type: 'context-result', platform: definition.key, context: latestPayload.context });
  } catch (error) {
    const message = error?.message || 'Context stopped unexpectedly.';
    emit({ type: 'error', message });
  } finally {
    stream({ type: 'run-finished', runId, platform: definition.key });
    finishRun(runId);
    platformContextRuns.delete(definition.key);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// environment status — what's actually set up in THIS install, so the UI can
// onboard a new user (connect a model), degrade gracefully (grey out providers
// that aren't connected), and double as a health check. Cheap fs/PATH checks —
// a provider is "connected" when its CLI is on PATH and its credential file
// exists (the same PATH the run spawner uses). Provider-generic: new providers
// slot in by adding to MODELS + PROVIDER_META.

const PROVIDER_META = {
  claude: {
    label: 'Claude', creds: () => path.join(os.homedir(), '.claude', '.credentials.json'),
    connect: ['claude', ['auth', 'login']], disconnect: ['claude', ['auth', 'logout']],
    loginUrl: 'https://claude.ai/login', installUrl: 'https://code.claude.com/docs/en/setup', connectHint: 'Sign in to Claude',
  },
  codex: {
    label: 'ChatGPT', creds: () => path.join(os.homedir(), '.codex', 'auth.json'),
    connect: ['codex', ['login']], disconnect: ['codex', ['logout']],
    loginUrl: 'https://chatgpt.com/auth/login', installUrl: 'https://learn.chatgpt.com/docs/codex/cli', connectHint: 'Sign in to ChatGPT',
  },
};

const GROK_LOGIN_URL = 'https://accounts.x.ai/sign-in?redirect=grok-com';
const CLAUDE_CHROME_URL = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CLAUDE_CHROME_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CODEX_CHROME_URL = 'https://chromewebstore.google.com/detail/hehggadaopoacecdllhhajmbjkdcmajg';
const CODEX_CHROME_ID = 'hehggadaopoacecdllhhajmbjkdcmajg';
const ONBOARDING_LAB_ENABLED = process.env.SUPREME_ONBOARDING_LAB === '1';
const ONBOARDING_SCENARIOS = [
  { id: 'clean', label: 'Clean laptop' },
  { id: 'signed-out', label: 'CLIs installed, signed out' },
  { id: 'claude-ready', label: 'Claude ready' },
  { id: 'codex-ready', label: 'Codex ready' },
  { id: 'both-ready', label: 'Both models ready' },
  { id: 'no-tools', label: 'Model ready, no tools' },
  { id: 'wrong-profile', label: 'Chrome in wrong profile' },
  { id: 'rich', label: 'Rich: months of history, Gmail, LinkedIn resolves' },
  { id: 'gmail', label: 'Gmail: connected at sign up, sent mail joins the read' },
  { id: 'thin', label: 'Thin: LinkedIn only, nothing inherited' },
  { id: 'no-linkedin', label: 'No LinkedIn: profile fails to resolve' },
  { id: 'wrong-guess', label: 'Wrong guess: Not quite, Not this' },
  { id: 'slow-read', label: 'Slow read: the read takes a while' },
];
const providerInstallers = new Map();

// Official one-line installers. Both drop a native binary under the user's $HOME
// (~/.local/bin), which is exactly where resolveCliBinary/providerAccount look —
// so a non-technical friend never has to open a terminal. Codex's script targets
// /bin/sh; Claude's is #!/bin/bash and refuses sudo, so pipe it to bash.
const PROVIDER_INSTALL_CMD = {
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
};

function launchProviderInstaller(provider) {
  const cmd = PROVIDER_INSTALL_CMD[provider];
  if (!cmd) return false;
  const current = providerInstallers.get(provider);
  if (current && current.child?.exitCode == null && !current.error) return false;
  // The installer's own output is the only progress signal there is; keep the
  // latest line so a multi-minute install reads as movement, not a hang.
  const record = { child: null, startedAt: Date.now(), phase: 'downloading', note: '', error: null };
  const child = spawn('/bin/sh', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: os.homedir() },
  });
  record.child = child;
  providerInstallers.set(provider, record);
  const digest = (chunk) => {
    const line = String(chunk).split('\n').map((value) => value.trim()).filter(Boolean).pop() || '';
    if (!line) return;
    record.note = line.slice(0, 160);
    if (/install|extract|unpack|link|setting up/i.test(line)) record.phase = 'installing';
  };
  child.stdout?.on('data', digest);
  child.stderr?.on('data', digest);
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.on('error', (error) => {
    record.error = error?.message || 'The installer could not start.';
    record.phase = 'failed';
  });
  child.on('exit', (code) => {
    if (code === 0) {
      record.phase = 'finishing';
    } else {
      record.phase = 'failed';
      record.error = record.error || `The installer stopped early (code ${code}). ${record.note || ''}`.trim();
    }
  });
  child.unref();
  return true;
}

// Live install progress for the status payload; cleared once the binary is
// actually resolvable (the only success signal that matters).
function providerInstallProgress(provider, installed) {
  const record = providerInstallers.get(provider);
  if (!record) return null;
  if (installed) {
    providerInstallers.delete(provider);
    return null;
  }
  return {
    running: record.child?.exitCode == null && !record.error,
    phase: record.phase,
    note: record.note,
    error: record.error,
    elapsedMs: Date.now() - record.startedAt,
  };
}

function fakeProvider(provider, { installed = false, authenticated = false } = {}) {
  const claude = provider === 'claude';
  return {
    provider,
    label: claude ? 'Claude' : 'ChatGPT',
    installed,
    authenticated,
    ready: installed && authenticated,
    path: installed ? `/usr/local/bin/${claude ? 'claude' : 'codex'}` : null,
    connectCommand: claude ? 'claude auth login' : 'codex login',
    loginUrl: claude ? 'https://claude.ai/login' : 'https://chatgpt.com/auth/login',
    installUrl: claude ? 'https://code.claude.com/docs/en/setup' : 'https://learn.chatgpt.com/docs/codex/cli',
    email: authenticated ? 'friend@example.com' : '',
    plan: authenticated ? (claude ? 'max' : 'plus') : '',
    hint: !installed ? `Install ${claude ? 'Claude Code' : 'Codex'} to continue` : authenticated ? '' : `Sign in to ${claude ? 'Claude' : 'ChatGPT'}`,
  };
}

function fakeChromeProvider(provider, mode = 'missing') {
  const ready = mode === 'ready';
  const wrongProfile = mode === 'wrong-profile';
  return {
    installed: ready || wrongProfile,
    activeProfileInstalled: ready,
    activeProfileEnabled: ready,
    profiles: ready ? ['Work'] : wrongProfile ? ['Personal'] : [],
    installUrl: provider === 'claude' ? CLAUDE_CHROME_URL : CODEX_CHROME_URL,
    testStatus: ready ? 'ready' : wrongProfile ? 'failed' : 'untested',
    testMessage: wrongProfile ? 'The extension is on in Personal, but Chrome is using Work.' : '',
  };
}

// The gmail lab scenario takes its connector list from fixture-connectors.json
// in WORKBENCH_HOME — the same file the fixture CLIs fake `mcp list` from — so
// a smoke or the lab bar can flip Gmail on and off without faking OAuth.
function fixtureConnectorRows() {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fixture-connectors.json'), 'utf8'));
    return (Array.isArray(rows?.claude) ? rows.claude : []).flatMap((row) => {
      const name = String(row?.name || '').trim().slice(0, 40);
      if (!name) return [];
      const connected = /connected/i.test(String(row?.state || 'connected'));
      return [{ name, url: '', connected, status: connected ? 'connected' : 'sign-in required', provider: 'claude' }];
    });
  } catch {
    return [];
  }
}

function makeOnboardingLabState(id) {
  const scenario = ONBOARDING_SCENARIOS.some((item) => item.id === id) ? id : 'clean';
  const readScenario = ['rich', 'gmail', 'thin', 'no-linkedin', 'wrong-guess', 'slow-read'].includes(scenario);
  const claudeReady = ['claude-ready', 'both-ready', 'no-tools', 'wrong-profile', 'rich'].includes(scenario);
  const codexReady = ['codex-ready', 'both-ready'].includes(scenario) || readScenario;
  const signedOut = scenario === 'signed-out';
  const providers = {
    claude: fakeProvider('claude', { installed: signedOut || claudeReady, authenticated: claudeReady }),
    codex: fakeProvider('codex', { installed: signedOut || codexReady, authenticated: codexReady }),
    grok: {
      provider: 'grok', label: 'Grok', installed: true, authenticated: false, ready: false,
      webConnected: false, path: null, connectCommand: null, loginUrl: GROK_LOGIN_URL,
      email: '', plan: '', hint: 'Web only',
    },
    openrouter: {
      provider: 'openrouter', label: 'OpenRouter', installed: true, authenticated: false,
      ready: false, path: null, connectCommand: null, hint: 'Add an API key',
    },
  };
  const connectors = [];
  if (claudeReady && scenario !== 'no-tools') {
    connectors.push(
      { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', connected: true, status: 'connected', provider: 'claude' },
      { name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1', connected: true, status: 'connected', provider: 'claude' },
      { name: 'Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1', connected: true, status: 'connected', provider: 'claude' },
      { name: 'Notion', url: 'https://mcp.notion.com/mcp', connected: true, status: 'connected', provider: 'claude' },
      { name: 'Slack', url: 'https://mcp.slack.com/mcp', connected: false, status: 'sign-in required', provider: 'claude' },
    );
  }
  if (codexReady) {
    connectors.push(
      { name: 'Granola', url: 'https://mcp.granola.ai/mcp', connected: true, status: 'configured', provider: 'codex' },
      { name: 'Melius', url: 'https://mcp.melius.com/mcp', connected: false, status: 'sign-in required', provider: 'codex' },
    );
  }
  if (scenario === 'gmail') connectors.push(...fixtureConnectorRows());
  const selectedChromeMode = scenario === 'wrong-profile' ? 'wrong-profile' : (claudeReady || codexReady) && scenario !== 'no-tools' ? 'ready' : 'missing';
  // The onboarding read (Paper 14): how the fake user's LinkedIn and history behave.
  const read = { fails: scenario === 'no-linkedin', delayMs: scenario === 'slow-read' ? 8_000 : 600, thin: scenario === 'thin', wrongGuess: scenario === 'wrong-guess' };
  return {
    scenario,
    providers,
    connectors,
    read,
    chrome: {
      installed: selectedChromeMode !== 'missing',
      enabled: true,
      byProvider: { claude: true, codex: true, grok: true },
      installUrl: CLAUDE_CHROME_URL,
      activeProfile: 'Work',
      providers: {
        claude: fakeChromeProvider('claude', claudeReady ? selectedChromeMode : 'missing'),
        codex: fakeChromeProvider('codex', codexReady ? selectedChromeMode : 'missing'),
      },
    },
  };
}

let onboardingLabState = makeOnboardingLabState(process.env.SUPREME_ONBOARDING_SCENARIO || 'clean');

function resetOnboardingLab(scenario) {
  onboardingLabState = makeOnboardingLabState(scenario);
  return onboardingLabState;
}

function decodeJwtPayload(token) {
  try {
    const encoded = String(token || '').split('.')[1];
    return encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

// Account probes shell out to provider CLIs, which can take far longer than a
// status poll should ever block — a fresh `claude auth status` after sign-in
// has been seen taking minutes to answer quickly. So polls return the cached
// answer instantly while an async probe with a generous budget refreshes it.
// Until the first probe lands, `authenticated: null` tells probeStatus to fall
// back to the credentials file on disk, which exists the moment sign-in works.
const ACCOUNT_PROBE_TTL = 15_000;
const _accountCache = new ProviderAccountCache({ ttlMs: ACCOUNT_PROBE_TTL });

function probeProviderAccount(provider, binary) {
  return new Promise((resolve) => {
    if (provider === 'claude') {
      execFile(binary, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024 }, (error, stdout) => {
        // A signed-out CLI may exit non-zero but still print its JSON status,
        // so trust parseable output either way and only report "unknown" when
        // there is nothing to parse (timeout, crash).
        try {
          const status = JSON.parse(String(stdout || ''));
          return resolve({
            authenticated: status.loggedIn === true,
            email: publicConnectorText(status.email, 120),
            plan: publicConnectorText(status.subscriptionType, 32),
          });
        } catch {
          return resolve(error ? null : { authenticated: false, email: '', plan: '' });
        }
      });
      return;
    }
    if (provider === 'codex') {
      execFile(binary, ['login', 'status'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
        const authenticated = codexLoginAuthenticated(error, stdout, stderr);
        if (authenticated !== true) {
          return resolve(authenticated === false ? { authenticated: false, email: '', plan: '' } : null);
        }
        try {
          const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
          const claims = decodeJwtPayload(auth?.tokens?.id_token);
          const plan = claims?.['https://api.openai.com/auth']?.chatgpt_plan_type || claims?.chatgpt_plan_type || '';
          resolve({ authenticated: true, email: publicConnectorText(claims.email, 120), plan: publicConnectorText(plan, 32) });
        } catch {
          resolve({ authenticated: true, email: '', plan: '' });
        }
      });
      return;
    }
    resolve({ authenticated: null, email: '', plan: '' });
  });
}

function invalidateProviderAccount(provider) {
  _accountCache.invalidate(provider);
}

function providerAccount(provider, binary = resolveCliBinary(provider)) {
  if (!binary) return { authenticated: false, email: '', plan: '' };
  return _accountCache.read(provider, () => probeProviderAccount(provider, binary))
    || { authenticated: null, email: '', plan: '' };
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function chromeExtensionStatus() {
  const roots = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')]
      : [path.join(os.homedir(), '.config', 'google-chrome'), path.join(os.homedir(), '.config', 'chromium')];
  const extensionMeta = {
    claude: { id: CLAUDE_CHROME_ID, installUrl: CLAUDE_CHROME_URL },
    codex: { id: CODEX_CHROME_ID, installUrl: CODEX_CHROME_URL },
  };
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const localState = readJsonFile(path.join(root, 'Local State'));
    const activeDirectory = localState?.profile?.last_used || 'Default';
    const infoCache = localState?.profile?.info_cache || {};
    let profiles = [];
    try { profiles = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { continue; }
    const profileInfo = profiles.map((directory) => {
      const preferences = readJsonFile(path.join(root, directory, 'Preferences'));
      const name = preferences?.profile?.name || infoCache?.[directory]?.name || directory;
      return { directory, name, preferences };
    });
    const active = profileInfo.find((profile) => profile.directory === activeDirectory) || profileInfo.find((profile) => profile.directory === 'Default') || null;
    const providers = Object.fromEntries(Object.entries(extensionMeta).map(([provider, meta]) => {
      const installedProfiles = profileInfo.filter((profile) => fs.existsSync(path.join(root, profile.directory, 'Extensions', meta.id)));
      const activeInstalled = !!active && installedProfiles.some((profile) => profile.directory === active.directory);
      const activeSettings = active?.preferences?.extensions?.settings?.[meta.id];
      const disabledReasons = activeSettings?.disable_reasons;
      const activeEnabled = activeInstalled
        && activeSettings?.state !== 0
        && !(Array.isArray(disabledReasons) && disabledReasons.length);
      return [provider, {
        installed: installedProfiles.length > 0,
        activeProfileInstalled: activeInstalled,
        activeProfileEnabled: activeEnabled,
        profiles: installedProfiles.map((profile) => profile.name),
        installUrl: meta.installUrl,
        testStatus: 'untested',
        testMessage: '',
      }];
    }));
    return {
      activeProfile: active?.name || activeDirectory || null,
      providers,
      installed: Object.values(providers).some((provider) => provider.installed),
    };
  }
  return {
    activeProfile: null,
    installed: false,
    providers: Object.fromEntries(Object.entries(extensionMeta).map(([provider, meta]) => [provider, {
      installed: false,
      activeProfileInstalled: false,
      activeProfileEnabled: false,
      profiles: [],
      installUrl: meta.installUrl,
      testStatus: 'untested',
      testMessage: '',
    }])),
  };
}

function launchProviderAuth(provider) {
  const meta = PROVIDER_META[provider];
  if (!meta) return false;
  const [, args] = meta.connect;
  const bin = resolveCliBinary(provider);
  if (!bin) return false;
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  // A status request can race the browser callback and cache the old signed-out
  // answer. Re-probe as soon as the official OAuth process actually finishes.
  child.on('exit', () => invalidateProviderAccount(provider));
  child.unref();
  return true;
}

function runProviderLogout(provider) {
  const meta = PROVIDER_META[provider];
  if (!meta) return Promise.resolve(false);
  const [, args] = meta.disconnect;
  const bin = resolveCliBinary(provider);
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 512 * 1024 }, (error) => resolve(!error));
  });
}

function whichSync(bin) {
  return resolveCliBinary(bin);
}

function probeStatus() {
  if (ONBOARDING_LAB_ENABLED) {
    const providers = onboardingLabState.providers;
    const connectedProviders = Object.values(providers).filter((provider) => provider.ready).map((provider) => provider.provider);
    return {
      ready: connectedProviders.length > 0,
      ok: connectedProviders.length > 0,
      providers,
      connectedProviders,
      readyModels: MODELS.filter((model) => providers[model.provider]?.ready).map((model) => model.id),
      git: { installed: true },
      chrome: onboardingLabState.chrome,
      node: process.version,
      home: os.homedir(),
      dataDir: DATA_DIR,
      onboardingLab: {
        enabled: true,
        scenario: onboardingLabState.scenario,
        scenarios: ONBOARDING_SCENARIOS,
      },
    };
  }
  const providers = {};
  const cliProviders = [...new Set(MODELS.map((m) => m.provider))].filter((p) => PROVIDER_META[p]);
  for (const prov of cliProviders) {
    const meta = PROVIDER_META[prov];
    const bin = whichSync(prov);
    const installed = !!bin;
    const account = installed ? providerAccount(prov, bin) : { authenticated: false, email: '', plan: '' };
    let credentialsExist = false;
    try { credentialsExist = installed && fs.existsSync(meta.creds()); } catch { credentialsExist = false; }
    const authenticated = typeof account.authenticated === 'boolean' ? account.authenticated : credentialsExist;
    const notice = accountNoticeStore()[`provider:${prov}`] || null;
    providers[prov] = {
      provider: prov, label: meta.label, installed, authenticated,
      ready: installed && authenticated, path: bin || null, connectCommand: meta.connect.flat().join(' '),
      loginUrl: meta.loginUrl, installUrl: meta.installUrl, email: account.email, plan: account.plan,
      install: providerInstallProgress(prov, installed),
      hint: !installed ? `Install the ${meta.label} tool to connect` : !authenticated ? meta.connectHint : notice ? notice.message : '',
    };
  }
  // OpenRouter is key-based (no CLI): connected once an API key is stored.
  const s = getSettings();
  providers.openrouter = {
    provider: 'openrouter', label: 'OpenRouter', installed: true,
    authenticated: !!s.openrouterKey, ready: !!s.openrouterKey, path: null, connectCommand: null,
    hint: s.openrouterKey ? '' : 'Add an OpenRouter API key to connect',
  };
  providers.grok = {
    provider: 'grok', label: 'Grok', installed: true, authenticated: false, ready: false,
    webConnected: Array.isArray(s.onboarding?.webProviders) && s.onboarding.webProviders.includes('grok'),
    path: null, connectCommand: null, loginUrl: GROK_LOGIN_URL, email: s.onboarding?.email || '', plan: '',
    hint: 'Grok opens on the web; direct Workbench routing is coming soon',
  };
  const git = { installed: !!whichSync('git') };
  const connectedProviders = Object.values(providers).filter((p) => p.ready).map((p) => p.provider);
  const readyModels = MODELS.filter((m) => providers[m.provider] && providers[m.provider].ready).map((m) => m.id);
  const storedBrowserProviders = s.browserControlByProvider && typeof s.browserControlByProvider === 'object'
    ? s.browserControlByProvider
    : {};
  const browserByProvider = Object.fromEntries(['claude', 'codex', 'grok'].map((provider) => [
    provider,
    typeof storedBrowserProviders[provider] === 'boolean'
      ? storedBrowserProviders[provider]
      : s.browserControlEnabled !== false,
  ]));
  const chromeExtensions = chromeExtensionStatus();
  return {
    ready: connectedProviders.length > 0, // ≥1 model connected → value mode
    ok: connectedProviders.length > 0 && git.installed,
    providers, connectedProviders, readyModels, git,
    chrome: {
      installed: chromeExtensions.installed,
      enabled: Object.values(browserByProvider).some(Boolean),
      byProvider: browserByProvider,
      installUrl: CLAUDE_CHROME_URL,
      activeProfile: chromeExtensions.activeProfile,
      providers: chromeExtensions.providers,
    },
    node: process.version, home: os.homedir(), dataDir: DATA_DIR,
  };
}

const onboardingChromePages = new Map();

function onboardingModel(provider) {
  return resolveModel(provider === 'claude' ? 'haiku' : provider === 'codex' ? 'gpt-6-luna' : '');
}

async function runOnboardingProbe(provider, { chrome = false } = {}) {
  const model = onboardingModel(provider);
  if (!model) throw new Error('Choose Claude Code or Codex first.');
  const status = probeStatus();
  const providerStatus = status.providers?.[provider];
  if (!providerStatus?.installed) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} is not installed on this Mac.`);
  if (!providerStatus.authenticated) throw new Error(`Sign in to ${provider === 'claude' ? 'Claude' : 'ChatGPT'} first.`);

  if (ONBOARDING_LAB_ENABLED) {
    if (!chrome) return { ready: true, message: 'The fake model answered the setup check.' };
    const extension = onboardingLabState.chrome.providers?.[provider];
    if (extension?.testStatus === 'ready') return { ready: true, message: 'The fake model read the Supreme test page.' };
    throw new Error(extension?.testMessage || 'Chrome did not pass this fake-user scenario.');
  }

  let expected = 'SUPREME_READY';
  let prompt = 'Reply with SUPREME_READY and nothing else. Do not use any tools.';
  if (chrome) {
    const extension = status.chrome?.providers?.[provider];
    if (!extension?.installed) throw new Error('Install the Chrome extension first.');
    if (!extension.activeProfileInstalled || !extension.activeProfileEnabled) {
      const found = extension.profiles?.[0];
      throw new Error(found
        ? `The extension is on in ${found}, but Chrome is using ${status.chrome?.activeProfile || 'another profile'}.`
        : 'Turn the extension on in the Chrome profile you use.');
    }
    if (status.chrome?.byProvider?.[provider] === false) throw new Error('Turn on browser access for this model first.');
    const token = newId().replace(/-/g, '');
    expected = String(Math.floor(1000 + Math.random() * 9000));
    onboardingChromePages.set(token, { code: expected, expiresAt: Date.now() + 5 * 60_000 });
    const testUrl = `http://127.0.0.1:${PORT}/onboarding/chrome-test/${token}`;
    prompt = `Use Chrome to open ${testUrl}. Read the four-digit code shown on that page, then reply with only the code. Do not open any other page and do not use shell commands or web fetch.`;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, chrome ? 75_000 : 45_000);
  timer.unref?.();
  try {
    const result = await runModel({
      thread: {
        messages: [], sessions: {}, cwd: os.homedir(), extraDirs: [],
        tools: chrome ? 'full' : 'off', connectors: false,
      },
      model,
      prompt,
      priorCount: 0,
      signal: controller.signal,
      effort: 'Low',
      control: null,
    }, () => {});
    if (timedOut) throw new Error(chrome ? 'Chrome did not answer within 75 seconds.' : 'The model did not answer within 45 seconds.');
    // Accept the code even when the model spaces/formats it (e.g. an OCR-based
    // read of the page turns "4823" into "4 8 2 3", or it answers "code: 4823.").
    // Match on the raw text OR a whitespace-stripped copy — stripping only
    // whitespace avoids false positives from digits in the echoed test URL.
    const answer = String(result.text || '');
    const matched = answer.includes(expected) || answer.replace(/\s+/g, '').includes(expected);
    if (!result?.ok || !matched) {
      throw new Error(chrome ? 'The model is signed in, but it could not read the Supreme test page.' : 'The model is signed in, but it did not answer the setup check.');
    }
    return { ready: true, message: chrome ? 'The model read the Supreme test page.' : 'The model answered the setup check.' };
  } finally {
    clearTimeout(timer);
  }
}

function serveOnboardingChromePage(res, url) {
  const token = url.pathname.split('/').filter(Boolean).at(-1) || '';
  const page = onboardingChromePages.get(token);
  if (!page || page.expiresAt < Date.now()) {
    onboardingChromePages.delete(token);
    return send(res, 404, 'This Supreme browser test has expired.');
  }
  // Surface the code every way a browser tool might read it — page title, a large
  // display value, and a plain sentence — and drop letter-spacing (it makes
  // screenshot/OCR reads split "4823" into "4 8 2 3"). Redundancy is what makes
  // this check reliable across DOM-reading and screenshot-reading agents.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Supreme code ${page.code}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#09090b;font:16px system-ui}.card{width:min(88vw,420px);padding:36px;border:1px solid #d4d4d8;border-radius:14px;background:#fff;text-align:center}.code{font:700 56px/1 ui-monospace,monospace;margin:24px 0 14px}p{color:#71717b;line-height:1.5}</style></head><body><main class="card"><b>Supreme browser test</b><div class="code">${page.code}</div><p>The four-digit code is ${page.code}. Read this code back to Supreme.</p></main></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store, max-age=0',
  });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Onboarding (Paper section 14). Connect a model, add your LinkedIn, one
// read, one choice, and the platform opens on the work. The read's seed is
// what the model CLIs already keep on this Mac (lib/onboarding-read.mjs).

function defaultOnboarding() {
  return {
    complete: false, signedIn: false, step: 'signin', email: '', webProviders: [],
    selectedProvider: 'codex', verifiedProviders: [], chromeSkipped: false, chromeReady: false, chromeError: '',
    linkedinUrl: '', profile: null, read: null,
    answers: { role: '', roleNote: '', areas: [], somethingElse: '', voice: '', voiceNote: '' },
    direction: null, firstTaskId: null,
  };
}

function normalizeOnboardingAnswers(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    role: ['right', 'not-quite'].includes(raw.role) ? raw.role : '',
    roleNote: publicConnectorText(raw.roleNote, 300),
    areas: (Array.isArray(raw.areas) ? raw.areas : []).map((area) => publicConnectorText(area, 60)).filter(Boolean).slice(0, 8),
    somethingElse: publicConnectorText(raw.somethingElse, 120),
    voice: ['me', 'own'].includes(raw.voice) ? raw.voice : '',
    voiceNote: publicConnectorText(raw.voiceNote, 400),
  };
}

function cleanOnboardingProfile(value, url) {
  const raw = value && typeof value === 'object' ? value : {};
  const name = publicConnectorText(raw.name, 80);
  let photoUrl = '';
  try {
    const parsed = new URL(String(raw.photoUrl || ''));
    if (parsed.protocol === 'https:') photoUrl = parsed.toString().slice(0, 600);
  } catch {}
  return {
    name,
    firstName: publicConnectorText(raw.firstName, 40) || name.split(' ')[0] || '',
    headline: publicConnectorText(raw.headline, 140),
    role: publicConnectorText(raw.role, 80),
    company: publicConnectorText(raw.company, 80),
    location: publicConnectorText(raw.location, 80),
    photoUrl,
    url: String(url || ''),
    summary: publicConnectorText(raw.summary, 300),
    seniority: publicConnectorText(raw.seniority, 20),
  };
}

function fakeOnboardingProfile(url) {
  return cleanOnboardingProfile({
    name: 'Mira Chen', firstName: 'Mira', headline: 'Founder at Northwind Brokers', role: 'Founder', company: 'Northwind Brokers',
    location: 'San Francisco', summary: 'Places bridge loans for mid-market operators through a lender network.', seniority: 'founder',
  }, url);
}

function fakeOnboardingRead(lab = {}) {
  const side = lab.wrongGuess ? 'lender' : 'broker';
  // Sent mail only shows up in the fake read when the fake user actually has a
  // connected Gmail, the same honesty rule the real read follows.
  const gmail = !!lab.gmail;
  const rich = {
    roleLine: `Founder at Northwind Brokers, and from the last few months it looks like you are mostly on the ${side} side.`,
    areas: [
      { label: 'Finding brokers worth writing to', evidence: '12 threads since June', preselected: true },
      { label: 'Keeping Smartlead loaded', evidence: '9 sessions', preselected: false },
      { label: 'Lender agreements and fee letters', evidence: '7 drafts', preselected: true },
      { label: 'Chasing replies that went quiet', evidence: gmail ? '5 threads, 12 sent chasers' : '5 threads', preselected: false },
      { label: 'Investor updates', evidence: '3 documents', preselected: false },
    ],
    voice: {
      summary: gmail
        ? 'Short paragraphs, the ask in the first line, could you please rather than please do, and never an exclamation mark.'
        : 'Plain and direct in what you ask for. I can see the requests you type, not yet how you write to people.',
      sources: { prompts: 148, sentEmails: gmail ? 240 : 0, transcripts: 60 },
    },
    directions: [
      { title: 'The broker shortlist', detail: 'Forty brokers within fifty miles, checked against your CRM, a first touch drafted for each', needs: ['Gmail'], prompt: 'Build a shortlist of forty commercial mortgage brokers within fifty miles of San Francisco who closed a bridge deal this year. Check each against the CRM and existing Smartlead threads and drop anyone already in a conversation. Draft a two-line first touch for each in the user\'s voice. Do not send anything; show the list and the drafts and stop.' },
      { title: 'The Variant fee letter', detail: 'The per-deal terms you agreed on Tuesday, turned into the NDA appendix and fee letter', needs: [], prompt: 'Turn the per-deal terms agreed with Variant on Tuesday into a one-page NDA appendix and a fee letter, using the existing lender fee agreement as the base. Keep the numbers exactly as agreed and flag anything you had to assume. Do not send anything; leave both as drafts.' },
    ],
    thin: false,
    gap: '',
  };
  if (lab.thin) {
    return {
      ...rich,
      areas: rich.areas.slice(0, 3),
      voice: { summary: 'Plain and direct, from the few requests I could see.', sources: { prompts: 4, sentEmails: 0, transcripts: 0 } },
      directions: [rich.directions[1]],
      thin: true,
      gap: 'I can see the broker work, not what is live this week. Gmail would show the week too.',
    };
  }
  return rich;
}

const onboardingReadRuns = new Set();

function saveOnboardingRead(read) {
  const settings = getSettings();
  settings.onboarding = { ...defaultOnboarding(), ...(settings.onboarding || {}), read };
  saveSettings(settings);
  return read;
}

function startOnboardingRead({ force = false } = {}) {
  const settings = getSettings();
  const ob = { ...defaultOnboarding(), ...(settings.onboarding || {}) };
  if (!force && ob.read && (ob.read.status === 'reading' || ob.read.status === 'ready')) return ob.read;
  if (onboardingReadRuns.has('read')) return ob.read;
  const startedAt = new Date().toISOString();
  const read = { status: 'reading', startedAt };
  settings.onboarding = { ...ob, read };
  saveSettings(settings);
  onboardingReadRuns.add('read');
  runOnboardingRead(startedAt)
    .catch((error) => saveOnboardingRead({ status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: error.message || 'The read did not finish.' }))
    .finally(() => onboardingReadRuns.delete('read'));
  return read;
}

async function runOnboardingRead(startedAt) {
  const ob = { ...defaultOnboarding(), ...(getSettings().onboarding || {}) };
  if (ONBOARDING_LAB_ENABLED) {
    await new Promise((resolve) => setTimeout(resolve, onboardingLabState.read?.delayMs || 600));
    const gmail = onboardingLabState.connectors.some((connector) => /^gmail$/i.test(String(connector?.name || '')) && connector.connected !== false);
    const result = fakeOnboardingRead({ ...(onboardingLabState.read || {}), gmail });
    const evidence = onboardingLabState.read?.thin
      ? { claudeSessions: 0, codexSessions: 3, prompts: 4, sentEmails: 0, memoryFiles: 0, skills: 0, tools: 0 }
      : { claudeSessions: 212, codexSessions: 61, prompts: 148, sentEmails: gmail ? 240 : 0, memoryFiles: 40, skills: 6, tools: 5 };
    return saveOnboardingRead({ status: 'ready', startedAt, finishedAt: new Date().toISOString(), ...result, evidence });
  }
  const connectors = await listConnectors().catch(() => []);
  const evidence = collectInheritedEvidence({ connectors });
  const model = tabSummaryModel();
  let result = null;
  if (model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const gmail = connectors.some((connector) => /^gmail$/i.test(String(connector?.name || '')) && connector.connected !== false);
      const providerResult = await runModel({
        thread: { cwd: DATA_DIR, extraDirs: [], tools: 'off', connectors: gmail, messages: [], sessions: {}, model: model.id },
        model,
        prompt: onboardingReadPrompt({ profile: ob.profile, evidence, answers: ob.answers }),
        images: [],
        priorCount: 0,
        signal: controller.signal,
        effort: 'Medium',
        control: {},
      }, () => {});
      if (providerResult?.ok) result = parseOnboardingRead(providerResult.text);
      // The model tends to report how many prompts it quoted, not how many it
      // was given. The sources line should say what was actually read, so the
      // collector's counts win whenever it collected anything itself.
      if (result?.voice && evidence?.counts?.prompts) result.voice.sources = { ...(result.voice.sources || {}), prompts: evidence.counts.prompts };
      if (result?.voice && evidence?.counts?.sentEmails) result.voice.sources = { ...(result.voice.sources || {}), sentEmails: evidence.counts.sentEmails };
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  if (!result) result = deterministicOnboardingRead({ profile: ob.profile, evidence });
  return saveOnboardingRead({ status: 'ready', startedAt, finishedAt: new Date().toISOString(), ...result, evidence: evidence.counts });
}

// The profile is read through the user's own Chrome, because LinkedIn shows
// nothing to a stranger. Asked for at the point of need, with the reason.
async function resolveLinkedInProfile(provider, url) {
  if (ONBOARDING_LAB_ENABLED) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (onboardingLabState.read?.fails) throw new Error('I could not read that profile. Check the link, or carry on without it.');
    return fakeOnboardingProfile(url);
  }
  const model = resolveModel(provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol');
  const status = probeStatus();
  const extension = status.chrome?.providers?.[provider];
  if (!extension?.installed || !extension.activeProfileInstalled || !extension.activeProfileEnabled) {
    throw new Error('I read your profile through your own Chrome. Turn on the Chrome extension, or carry on without it.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const result = await runModel({
      thread: { messages: [], sessions: {}, cwd: os.homedir(), extraDirs: [], tools: 'full', connectors: false, model: model.id },
      model,
      prompt: `Use Chrome to open ${url} and read the profile as it is shown. Reply with JSON only, no prose: {"name":"","firstName":"","headline":"","role":"","company":"","location":"","photoUrl":"","summary":"one sentence on what they do","seniority":"founder|executive|senior|mid|early|unknown"}. Do not connect, message, follow, or change anything, and do not open any other page.`,
      images: [],
      priorCount: 0,
      signal: controller.signal,
      effort: 'Low',
      control: null,
    }, () => {});
    if (!result?.ok) throw new Error('I could not read that profile through Chrome.');
    const raw = String(result.text || '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    let parsed = null;
    try { parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null; } catch { parsed = null; }
    const profile = cleanOnboardingProfile(parsed, url);
    if (!profile.name) throw new Error('I could not read a name from that profile. Check the link, or carry on without it.');
    return profile;
  } finally {
    clearTimeout(timer);
  }
}

// Picking a direction is what ends onboarding: a project named after their
// company, one workstream named after the task, the read saved as project
// Context, and the first turn handed back to the client to run.
async function startFirstWorkstream(body) {
  const settings = getSettings();
  const ob = { ...defaultOnboarding(), ...(settings.onboarding || {}) };
  const read = ob.read && ob.read.status === 'ready' ? ob.read : null;
  const custom = publicConnectorText(body.custom, 600);
  let direction = null;
  if (custom) direction = { title: custom.length > 60 ? `${custom.slice(0, 57)}…` : custom, detail: '', needs: [], prompt: custom };
  else if (Number.isInteger(body.direction) && read?.directions?.[body.direction]?.prompt) direction = read.directions[body.direction];
  if (!direction) throw new Error('Pick a direction, or tell me the right one.');
  const provider = ['claude', 'codex'].includes(ob.selectedProvider) ? ob.selectedProvider : 'codex';
  const modelId = provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol';
  const projectName = publicConnectorText(ob.profile?.company, 80) || 'Getting started';
  let project = listRepos().find((item) => item.name === projectName && !item.archived) || listRepos().find((item) => item.name === projectName) || null;
  if (!project) {
    const projectId = newId();
    const root = await createManagedProject({ name: projectName, id: projectId });
    project = addRepo({ id: projectId, path: root, name: projectName, base: 'main', hasRemote: false, managed: true });
  } else if (project.archived) {
    project = setRepoArchived(project.path, false) || project;
  }
  const block = onboardingContextBlock({ profile: ob.profile, read, answers: ob.answers });
  if (block) {
    const kept = (project.contextBlocks || []).filter((candidate) => candidate.name !== 'From sign up');
    project = setRepoContextBlocks(project.path, [...kept, { id: newId(), name: 'From sign up', content: block }]) || project;
  }
  const root = await localProjectRoot(project);
  if (!root) throw new Error('Could not set up a project folder on this Mac.');
  const id = newId();
  const wt = await createWorktree({ repo: root, title: direction.title, base: project.base, id });
  const task = createTask({
    id, title: direction.title, projectId: project.id, repo: project.path, repoName: project.name,
    base: wt.base, branch: wt.branch, worktreePath: wt.worktreePath,
    model: modelId, tools: 'full', connectors: true, tabName: 'Main', origin: 'signup',
  });
  const prompt = firstTaskPrompt({ profile: ob.profile, read, answers: ob.answers, direction });
  settings.onboarding = { ...ob, complete: true, step: 'complete', selectedProvider: provider, firstTaskId: task.id, direction: Number.isInteger(body.direction) ? body.direction : null };
  saveSettings(settings);
  return { task: taskForClient(task), project, prompt, model: modelId };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // Local-only onboarding lab. It runs against a throwaway data directory and
  // deterministic fake provider states, so friends' first-run paths can be
  // tested without reading real credentials or touching the installed app.
  if (parts[1] === 'onboarding' && parts[2] === 'lab' && parts.length === 3) {
    if (!ONBOARDING_LAB_ENABLED) return send(res, 404, { error: 'not found' });
    if (method === 'GET') return send(res, 200, { status: probeStatus(), connectors: await listConnectors() });
    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readBody(req);
    resetOnboardingLab(String(body.scenario || 'clean'));
    _connectorCache = { at: 0, list: [] };
    const settings = getSettings();
    settings.onboarding = defaultOnboarding();
    saveSettings(settings);
    return send(res, 200, { status: probeStatus(), connectors: await listConnectors() });
  }

  if (parts[1] === 'onboarding' && parts[2] === 'lab' && parts[3] === 'connect-tool' && parts.length === 4 && method === 'POST') {
    if (!ONBOARDING_LAB_ENABLED) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const provider = ['claude', 'codex'].includes(body.provider) ? body.provider : 'claude';
    // A named request ("Connect Gmail" at sign up) connects that connector
    // wherever it lives; the unnamed form keeps the old first-disconnected pick.
    const name = String(body.name || '').trim().slice(0, 40);
    let connector = name
      ? onboardingLabState.connectors.find((item) => item.name.toLowerCase() === name.toLowerCase())
      : onboardingLabState.connectors.find((item) => item.provider === provider && !item.connected);
    if (connector) {
      connector.connected = true;
      connector.status = connector.provider === 'claude' ? 'connected' : 'configured';
    } else {
      connector = {
        name: name || (provider === 'claude' ? 'Gmail' : 'Google Drive'),
        url: provider === 'claude' ? 'https://gmailmcp.googleapis.com/mcp/v1' : 'https://mcp.example.invalid/google-drive',
        connected: true,
        status: provider === 'claude' ? 'connected' : 'configured',
        provider,
      };
      onboardingLabState.connectors.push(connector);
    }
    return send(res, 200, {
      status: probeStatus(),
      connectors: await listConnectors(),
      message: `${connector.name} is ready for this fake user.`,
    });
  }

  if (parts[1] === 'onboarding' && parts[2] === 'lab' && parts[3] === 'fix-chrome' && parts.length === 4 && method === 'POST') {
    if (!ONBOARDING_LAB_ENABLED) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const provider = ['claude', 'codex'].includes(body.provider) ? body.provider : 'claude';
    onboardingLabState.chrome.installed = true;
    onboardingLabState.chrome.providers[provider] = fakeChromeProvider(provider, 'ready');
    return send(res, 200, { status: probeStatus() });
  }

  if (parts[1] === 'onboarding' && parts[2] === 'model-check' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const provider = String(body.provider || '').toLowerCase();
    if (!['claude', 'codex'].includes(provider)) return send(res, 400, { error: 'choose Claude Code or Codex first' });
    try {
      return send(res, 200, await runOnboardingProbe(provider));
    } catch (error) {
      return send(res, 409, { error: error.message || 'the model did not answer the setup check' });
    }
  }

  if (parts[1] === 'onboarding' && parts[2] === 'chrome-check' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const provider = String(body.provider || '').toLowerCase();
    if (!['claude', 'codex'].includes(provider)) return send(res, 400, { error: 'choose Claude Code or Codex first' });
    try {
      return send(res, 200, await runOnboardingProbe(provider, { chrome: true }));
    } catch (error) {
      return send(res, 409, { error: error.message || 'Chrome did not finish the setup check' });
    }
  }

  // Onboarding, Paper section 14: add your LinkedIn, one read, one choice,
  // then the platform opens on the work. The read is asynchronous so the
  // greeting can appear before it lands.
  if (parts[1] === 'onboarding' && parts[2] === 'linkedin' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    let url = String(body.url || '').trim();
    // The placeholder and this route's own error show the link the way people
    // actually paste it — linkedin.com/in/yourname, no scheme — but the check
    // used to demand https:// while the client's did not, so a normal paste
    // passed the button and died here (E2E onboarding section 07). Accept
    // what we advertise: add the implied scheme, drop tracking query/hash.
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    url = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?#]+$/i.test(url)) {
      return send(res, 400, { error: 'Paste your LinkedIn profile link, like linkedin.com/in/yourname.' });
    }
    const settings = getSettings();
    const ob = { ...defaultOnboarding(), ...(settings.onboarding || {}) };
    const provider = ['claude', 'codex'].includes(body.provider) ? body.provider : (ob.selectedProvider || 'codex');
    try {
      const profile = await resolveLinkedInProfile(provider, url);
      settings.onboarding = { ...ob, linkedinUrl: url, profile, read: null };
      saveSettings(settings);
      const read = startOnboardingRead({ force: true });
      return send(res, 200, { profile, read });
    } catch (error) {
      settings.onboarding = { ...ob, linkedinUrl: url };
      saveSettings(settings);
      return send(res, 409, { error: error.message || 'I could not read that profile.' });
    }
  }
  // Section 29: scheduled tasks. They live on this Mac and never travel,
  // because the run is this Mac's to make.
  if (parts[1] === 'scheduled') {
    if (parts.length === 2 && method === 'GET') return send(res, 200, { schedules: scheduled.listSchedules().map(publicSchedule) });
    const tabFor = (threadId, tabId) => {
      const task = getTask(String(threadId || ''));
      const tab = task && !task.archived ? (task.tabs || []).find((candidate) => candidate.id === tabId && !candidate.archived) : null;
      return tab && tab.type !== 'duel' ? tab : null;
    };
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      if (!tabFor(body.threadId, body.tabId)) return send(res, 400, { error: 'Pick the tab that runs it.' });
      try {
        return send(res, 200, { schedule: publicSchedule(scheduled.createSchedule(body)) });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    const schedule = scheduled.getSchedule(parts[2] || '');
    if (!schedule) return send(res, 404, { error: 'no such task' });
    if (parts.length === 3 && method === 'PATCH') {
      const body = await readBody(req);
      if ((body.threadId !== undefined || body.tabId !== undefined) && !tabFor(body.threadId ?? schedule.threadId, body.tabId ?? schedule.tabId)) {
        return send(res, 400, { error: 'Pick the tab that runs it.' });
      }
      try {
        return send(res, 200, { schedule: publicSchedule(scheduled.updateSchedule(schedule.id, body)) });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
    }
    if (parts.length === 3 && method === 'DELETE') {
      scheduled.deleteSchedule(schedule.id);
      return send(res, 200, { ok: true });
    }
    if (parts[3] === 'run' && parts.length === 4 && method === 'POST') {
      // Section 33: an On reply task has nothing to run until a reply comes.
      if (schedule.repeat?.kind === 'reply') return send(res, 409, { error: 'This one runs when a reply comes in.', schedule: publicSchedule(schedule) });
      const out = await fireSchedule(schedule, { manual: true });
      if (out.error) return send(res, out.status === 404 ? 404 : 409, { error: out.error, schedule: publicSchedule(scheduled.getSchedule(schedule.id) || schedule) });
      return send(res, 200, { fireId: out.fireId, schedule: publicSchedule(scheduled.getSchedule(schedule.id) || schedule) });
    }
    if (parts[3] === 'allow' && parts.length === 4 && (method === 'POST' || method === 'DELETE')) {
      const body = await readBody(req);
      if (method === 'DELETE') return send(res, 200, { schedule: publicSchedule(scheduled.disallow(schedule.id, body) || schedule) });
      // A grant is never typed or sent in: it is the pair the service itself
      // checked and stamped on the answer that asked (board 29.8), so what
      // is written is exactly what the button showed and nothing wider.
      let asking = null;
      try { asking = getTask(String(body.threadId || '')); } catch { /* not an id: nothing to allow */ }
      const answer = (asking?.tabs || []).flatMap((candidate) => candidate.messages || []).find((message) => message.id === body.messageId);
      if (!answer?.needs || answer.needs.scheduleId !== schedule.id) return send(res, 400, { error: 'There is nothing to allow there.' });
      return send(res, 200, { schedule: publicSchedule(scheduled.allow(schedule.id, answer.needs) || schedule) });
    }
    return send(res, 404, { error: 'not found' });
  }
  // Plays (Paper 17): the store, Find a Play, the change input, and runs.
  if (parts[1] === 'plays') {
    if (parts.length === 2 && method === 'GET') return send(res, 200, { plays: loadPlays().map(playPublic) });
    if (parts.length === 2 && method === 'POST') {
      const body = await readBody(req);
      if (!String(body.name || '').trim()) return send(res, 400, { error: 'name the play first' });
      return send(res, 200, { play: playPublic(createPlay(body)) });
    }
    if (parts[2] === 'find' && parts.length === 3 && method === 'POST') {
      const body = await readBody(req);
      const task = getTask(String(body.taskId || ''));
      const tab = task ? getTab(task, String(body.tabId || '')) : null;
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const job = startPlayFind({ taskId: task.id, tabId: tab.id, modelId: body.model || tab.model || task.model });
      return send(res, 200, { job: publicPlayJob(job) });
    }
    if (parts[2] === 'find' && parts.length === 4 && method === 'GET') {
      const job = playFindJobs.get(parts[3]);
      if (!job) return send(res, 404, { error: 'no such read' });
      return send(res, 200, { job: publicPlayJob(job) });
    }
    if (parts[2] === 'revise' && parts.length === 3 && method === 'POST') {
      const body = await readBody(req);
      const instruction = String(body.instruction || '').trim();
      const current = body.play && typeof body.play === 'object' ? body.play : {};
      if (!instruction) return send(res, 400, { error: 'say what to change' });
      const draft = { name: String(current.name || ''), useWhen: String(current.useWhen || ''), rulesText: rulesHtmlToText(sanitizeRulesHtml(current.rules || '')) };
      let revised;
      if (PLAYS_FIXTURE) {
        revised = { name: draft.name || 'Thread play', useWhen: draft.useWhen, rules: [...draft.rulesText.split('\n').map((line) => line.replace(/^(\d+\.|-|#)\s+/, '')).filter(Boolean), instruction] };
      } else {
        const connectors = await connectedConnectorNames();
        const text = await playModelText({ modelId: body.model, prompt: revisePlayPrompt({ play: draft, instruction, connectors }), effort: 'Medium' })
          .catch((error) => { throw Object.assign(new Error(error.message), { status: 502 }); });
        revised = parsePlayJson(text);
      }
      if (!revised) return send(res, 502, { error: 'The model could not apply that change. Try wording it differently.' });
      return send(res, 200, { play: { name: revised.name, useWhen: revised.useWhen, rules: rulesListToHtml(revised.rules) } });
    }
    if (parts[2] === 'runs' && parts.length === 3 && method === 'GET') {
      prunePlayJobs();
      const taskId = url.searchParams.get('taskId');
      const tabId = url.searchParams.get('tabId');
      const list = [...playRuns.values()].filter((run) => (!taskId || run.taskId === taskId) && (!tabId || run.tabId === tabId));
      return send(res, 200, { runs: list.map(publicPlayRun) });
    }
    if (parts[2] === 'runs' && parts.length === 4 && method === 'GET') {
      const run = playRuns.get(parts[3]);
      if (!run) return send(res, 404, { error: 'no such play run' });
      return send(res, 200, { run: publicPlayRun(run) });
    }
    if (parts[2] === 'runs' && parts[4] === 'stop' && parts.length === 5 && method === 'POST') {
      const run = playRuns.get(parts[3]);
      if (!run) return send(res, 404, { error: 'no such play run' });
      const stopped = stopPlayRun(run);
      return send(res, 200, { ok: true, stopped, run: publicPlayRun(run) });
    }
    const play = getPlay(parts[2]);
    if (!play) return send(res, 404, { error: 'no such play' });
    if (parts.length === 3 && method === 'GET') return send(res, 200, { play: playPublic(play) });
    if (parts.length === 3 && method === 'PATCH') {
      const body = await readBody(req);
      return send(res, 200, { play: playPublic(updatePlay(play.id, { ...body, ...(team.me() ? { updatedBy: team.me() } : {}) })) });
    }
    if (parts.length === 3 && method === 'DELETE') {
      deletePlay(play.id);
      return send(res, 200, { ok: true });
    }
    if (parts[3] === 'run' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const task = getTask(String(body.taskId || ''));
      const tab = task ? getTab(task, String(body.tabId || '')) : null;
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if (tab.type === 'duel') return send(res, 400, { error: 'a play cannot run in a Duel tab' });
      if (activePlayRunFor(task.id, tab.id)) return send(res, 409, { error: 'a play is already running in this tab' });
      const run = startPlayRun({ play, taskId: task.id, tabId: tab.id, kickoff: body.instruction, modelId: body.model || tab.model || task.model, effort: body.effort || null });
      return send(res, 200, { run: publicPlayRun(run) });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (parts[1] === 'onboarding' && parts[2] === 'read' && parts.length === 3) {
    if (method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { read: startOnboardingRead({ force: !!body.force }) });
    }
    if (method === 'GET') {
      const ob = { ...defaultOnboarding(), ...(getSettings().onboarding || {}) };
      return send(res, 200, { profile: ob.profile, read: ob.read, answers: ob.answers });
    }
  }
  if (parts[1] === 'onboarding' && parts[2] === 'answer' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const settings = getSettings();
    const ob = { ...defaultOnboarding(), ...(settings.onboarding || {}) };
    const answers = normalizeOnboardingAnswers({ ...ob.answers, ...body });
    settings.onboarding = { ...ob, answers };
    saveSettings(settings);
    // "Not quite" or a new area is worth a second read; the rest just travels.
    const read = body.reread ? startOnboardingRead({ force: true }) : getSettings().onboarding?.read || null;
    return send(res, 200, { answers, read });
  }
  if (parts[1] === 'onboarding' && parts[2] === 'start' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, await startFirstWorkstream(body));
    } catch (error) {
      return send(res, 409, { error: error.message || 'Could not start the first workstream.' });
    }
  }
  if (parts[1] === 'remote' && parts[2] === 'testflight' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return send(res, 400, { error: 'enter a valid email address' });
    const phone = await mobileAppStatus();
    if (phone.installed) {
      return send(res, 200, { ok: true, requested: false, delivery: 'none', status: 'connected', email, url: null });
    }
    const requested = await recordTestFlightRequest(email);
    try {
      const invitation = await sendTestFlightInvitation(email);
      if (invitation) return send(res, 200, { ...invitation, requested, url: null });
    } catch (error) {
      return send(res, error.status || 503, { error: error.message || 'Apple could not send the invitation.' });
    }
    const testFlightUrl = configuredTestFlightUrl();
    if (!requested && !testFlightUrl) return send(res, 503, { error: 'TestFlight is not configured yet' });
    return send(res, 200, {
      ok: true,
      requested,
      delivery: testFlightUrl ? 'public-link' : 'queued',
      status: testFlightUrl ? 'link-ready' : 'queued',
      email,
      url: testFlightUrl,
    });
  }

  // Section 34, Landed on the phone: when this person last read each tab,
  // shared with their phone and other Macs (lib/seen.mjs, migration 0014).
  if (parts[1] === 'seen' && parts.length === 2) {
    if (method === 'GET') return send(res, 200, { stamps: await readSeen(relay.sessionInfo()) });
    if (method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await markSeenShared(relay.sessionInfo(), body.stamps));
    }
  }

  // GET /api/remote -> native-client control-plane snapshot plus the phone's
  // pairing status for the desktop Remote page.
  if (parts[1] === 'remote' && parts.length === 2 && method === 'GET') {
    return send(res, 200, await remoteSnapshot());
  }

  // Web Push for the Remote PWA: the phone registers its subscription here and
  // the server notifies it when a run settles. Keys live in DATA_DIR/push.json.
  if (parts[1] === 'push') {
    if (parts.length === 2 && method === 'GET') {
      return send(res, 200, { publicKey: pushPublicKey(), subscriptions: pushCount() });
    }
    if (parts[2] === 'subscribe' && method === 'POST') {
      const body = await readBody(req);
      try {
        return send(res, 200, { ok: true, subscriptions: pushSubscribe(body) });
      } catch {
        return send(res, 400, { error: 'invalid subscription' });
      }
    }
    if (parts[2] === 'unsubscribe' && method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, { ok: true, subscriptions: pushUnsubscribe(String(body.endpoint || '')) });
    }
    if (parts[2] === 'test' && method === 'POST') {
      pushNotify({ title: 'Workbench', body: 'Push notifications are working.', tag: 'push-test' });
      return send(res, 200, { ok: true, subscriptions: pushCount() });
    }
  }

  // GET /api/status -> environment readiness for onboarding + graceful
  // degradation: which providers/models are connected in THIS install.
  if (parts[1] === 'status' && parts.length === 2 && method === 'GET') {
    return send(res, 200, {
      // Desktop startup must not confuse service liveness with provider
      // readiness. A clean install is healthy before the user connects their
      // first model, which is exactly when onboarding needs the UI most.
      serviceReady: true,
      product: 'supreme',
      ...probeStatus(),
      cloudWorker: { configured: flymachines.isConfigured() },
      team: team.status(),
      keepAwake: getSettings().keepAwake || 'off',
      keepAwakeActive: keepawake.active(),
      cliUpdates: cliUpdates.status(),
    });
  }

  // Section 32. POST /api/email/inbound {to, from, subject, text, messageId,
  // inReplyTo, references} -> the same path the cloud pickup feeds; POST
  // /api/email/handoffs/:id/confirm -> the hand-over card's yes.
  if (parts[1] === 'email' && parts[2] === 'inbound' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    try {
      const out = await emailInbound(body || {});
      return send(res, out.status || 200, out);
    } catch (err) { return send(res, err.status || 500, { error: err.message }); }
  }
  if (parts[1] === 'email' && parts[2] === 'handoffs' && parts[4] === 'confirm' && parts.length === 5 && method === 'POST') {
    const handoff = email.getHandoff(parts[3]);
    if (!handoff) return send(res, 404, { error: 'That email is gone.' });
    try { return send(res, 200, await emailConfirm(handoff, { by: 'card' })); }
    catch (err) { return send(res, err.status || 500, { error: err.message }); }
  }

  // POST /api/cli-updates/check -> ask each model CLI to update itself now
  // (`claude update`, `codex update`), unless a run is live. The scheduled
  // pass does the same every six hours; this is the button and the smoke.
  if (parts[1] === 'cli-updates' && parts[2] === 'check' && parts.length === 3 && method === 'POST') {
    const results = await cliUpdates.checkOnce(cliUpdateOptions);
    return send(res, 200, { ...cliUpdates.status(), results });
  }

  // ---- Same team (Paper section 19). See docs/same-team.md. ----
  if (parts[1] === 'team' && parts.length === 2 && method === 'GET') return send(res, 200, team.status());
  // GET/POST/DELETE /api/repos/share?path= | {path, email} | ?path=&memberId=
  if (parts[1] === 'repos' && parts[2] === 'share' && parts.length === 3) {
    const body = method === 'POST' ? await readBody(req) : {};
    const wanted = String(body.path || url.searchParams.get('path') || '');
    const wantedId = String(body.projectId || url.searchParams.get('projectId') || '');
    const project = listRepos().find((r) => (wanted && r.path === wanted) || (wantedId && r.id === wantedId)) || null;
    if (!project) return send(res, 404, { error: 'no such project' });
    if (method === 'GET') return send(res, 200, { shared: team.sharedInfo(project.id) });
    try {
      if (method === 'POST') return send(res, 200, await team.shareProject({ project, email: body.email }));
      if (method === 'DELETE') return send(res, 200, { shared: await team.removeMember({ projectId: project.id, memberId: String(url.searchParams.get('memberId') || '') }) });
    } catch (err) {
      // 409: the renderer is already renewing the token; the client retries.
      return send(res, team.isExpiryError(err) ? 409 : 400, { error: team.friendlyError(err) });
    }
  }
  // POST /api/team/queue/:id/ack -> the sender takes an expired message back.
  // DELETE /api/team/queue/:id  -> the sender withdraws a queued message.
  if (parts[1] === 'team' && parts[2] === 'queue' && parts[3]) {
    try {
      if (method === 'POST' && parts[4] === 'ack') return send(res, 200, { body: await team.ackQueue(parts[3]) });
      if (method === 'DELETE' && parts.length === 4) return send(res, 200, { body: await team.withdrawQueue(parts[3]) });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  // ---- Accounts (Supabase). The app account, separate from model logins. ----
  // GET /api/auth/config -> tells the frontend whether accounts are enabled and
  // hands it the *public* values needed to init the Supabase JS client. Never
  // exposes the service key. When not configured, the app runs fully local.
  // Slack, one click. start mints the consent link; the hosted callback page
  // forwards Slack's code into conductor://slack/callback; exchange trades it
  // for the bot token, verifies it, and shares it with every project this
  // account owns so teammates are connected without pasting anything.
  if (parts[1] === 'slack' && parts[2] === 'oauth' && parts[3] === 'start' && method === 'GET') {
    const cfg = slackOAuthConfig();
    if (!cfg.configured) return send(res, 200, { configured: false });
    for (const [key, at] of slackOAuthStates) if (Date.now() - at > 10 * 60_000) slackOAuthStates.delete(key);
    const state = newId();
    slackOAuthStates.set(state, Date.now());
    return send(res, 200, { configured: true, url: slackAuthorizeUrl(state) });
  }
  if (parts[1] === 'slack' && parts[2] === 'oauth' && parts[3] === 'exchange' && method === 'POST') {
    const body = await readBody(req);
    const code = String(body.code || '');
    const state = String(body.state || '');
    if (!code) return send(res, 400, { error: 'Slack did not send a sign-in code. Try Add to Slack again.' });
    if (!state || !slackOAuthStates.has(state)) return send(res, 400, { error: 'That Slack sign-in link is stale. Try Add to Slack again.' });
    slackOAuthStates.delete(state);
    let granted;
    try { granted = await slackExchangeCode(code); } catch (err) { return send(res, 502, { error: friendlySlackError(err.message) }); }
    const s = getSettings();
    s.slack = { ...(s.slack && typeof s.slack === 'object' ? s.slack : {}), botToken: granted.token, source: 'oauth', team: granted.team };
    saveSettings(s);
    const health = await slackHealth({ force: true });
    team.shareSlackToken().catch((err) => console.warn('[slack] share token:', err.message));
    return send(res, 200, { ok: true, slack: { health, team: granted.team } });
  }

  if (parts[1] === 'auth' && parts[2] === 'config' && method === 'GET') {
    const c = supabase.config();
    return send(res, 200, { configured: c.configured, url: c.url, anonKey: c.anonKey });
  }

  // GET /api/auth/status -> current sync/session + relay state (frontend polls).
  if (parts[1] === 'auth' && parts[2] === 'status' && method === 'GET') {
    return send(res, 200, { ...sync.status(), relay: relay.status(), team: team.status() });
  }

  // POST /api/auth/session -> the frontend hands over the Supabase session after
  // sign-in. We verify the token server-side, then hydrate + start mirroring.
  if (parts[1] === 'auth' && parts[2] === 'session' && method === 'POST') {
    if (!supabase.isConfigured() && !team.hubMode()) return send(res, 409, { error: 'accounts not configured' });
    const body = await readBody(req);
    const token = body.access_token || body.accessToken;
    if (!token) return send(res, 400, { error: 'access_token required' });
    // The Same team smoke runs two servers against a local hub with fixture
    // users; there is no Supabase to verify against.
    let user;
    if (team.hubMode() && body.user?.id) {
      user = { id: String(body.user.id), email: String(body.user.email || ''), user_metadata: body.user.user_metadata || {} };
    } else {
      // A 401 tells the client its token is dead; anything less certain must
      // not: the client treats 401 as grounds to drop its stored session, and
      // "Supabase was unreachable at launch" is not that.
      const verdict = await supabase.verifyUser(token);
      if (verdict.unreachable) return send(res, 503, { error: 'could not verify the sign-in; will retry' });
      user = verdict.user;
    }
    if (!user || !user.id) return send(res, 401, { error: 'invalid or expired token' });
    // Same team first: it learns which projects are shared so the per-user
    // sync leaves those threads to it; it pulls them after sync has hydrated.
    // The same account with a fresh token (hourly) takes the short path inside
    // each of these: the token swaps, nothing is torn down or re-pulled.
    try { await team.attachSession({ token, user, port: PORT }); } catch (err) { console.error('[team] attach:', err.message); }
    const st = await sync.attachSession({ token, user });
    team.start().catch((err) => console.error('[team] start:', err.message));
    // Join the Realtime relay so the phone can control this machine (Phase A).
    // Async on purpose — never block sign-in on the Realtime socket. Poll
    // GET /api/auth/status for live relay state.
    relay.attachSession({ token, user, port: PORT, acceptCommand: runnerAcceptsCommand })
      .catch((err) => console.error('[relay] attach:', err.message));
    return send(res, 200, { ...st, team: team.status() });
  }

  // POST /api/auth/signout -> stop mirroring; local data stays put on the machine.
  if (parts[1] === 'auth' && parts[2] === 'signout' && method === 'POST') {
    sync.clearSession();
    relay.clearSession().catch(() => {});
    team.clearSession().catch(() => {});
    return send(res, 200, { ok: true });
  }

  // POST /api/account/reset -> wipe this Mac's local threads + onboarding progress
  // and sign out, returning the app to a clean first-run. Local-only: the cloud
  // copy and other machines are untouched (each Mac has its own ~/.workbench).
  // Used to re-test onboarding from scratch. Destructive — the client confirms first.
  if (parts[1] === 'account' && parts[2] === 'reset' && method === 'POST') {
    let removed = 0;
    for (const summary of listTasks()) {
      try { deleteTask(summary.id); removed += 1; } catch { /* best effort */ }
    }
    const settings = getSettings();
    delete settings.onboarding;
    delete settings.threadLayout;
    saveSettings(settings);
    sync.clearSession();
    relay.clearSession().catch(() => {});
    team.clearSession().catch(() => {});
    return send(res, 200, { ok: true, removedThreads: removed });
  }

  // Section 26: the bus behind Supreme's MCP server (lib/supreme-mcp.mjs).
  // The answer to a send is success and nothing more: no receipt, no queue
  // depth, nothing a sender could read as the receiver's state.
  if (parts[1] === 'tabmail' && method === 'POST' && ['send', 'tabs', 'read', 'recall', 'roster', 'slack-context', 'slack-people'].includes(parts[2]) && parts.length === 3) {
    const body = await readBody(req);
    try {
      if (parts[2] === 'send') { const { ok, to } = sendTabMessage({ fromTaskId: body.taskId, fromTabId: body.tabId, to: body.to, text: body.text, replyTo: body.replyTo }); return send(res, 200, { ok, to }); }
      if (parts[2] === 'roster') return send(res, 200, rosterAction(body));
      if (parts[2] === 'tabs') return send(res, 200, { tabs: tabmailDestinations(String(body.taskId || ''), String(body.tabId || '')) });
      if (parts[2] === 'read') return send(res, 200, tabmailRead(body.taskId, body.tabId, body.to, body.limit));
      const task = getTask(String(body.taskId || ''));
      const tab = (task?.tabs || []).find((candidate) => candidate.id === String(body.tabId || ''));
      if (!tab) return send(res, 404, { error: 'The asking tab is gone.' });
      if (parts[2] === 'slack-context' || parts[2] === 'slack-people') {
        if (task.archived || tab.done) return send(res, 403, { error: 'This Slack conversation is no longer active.' });
        if (!slackBackgroundAllowed(task, team.sharedInfo(task.projectId))) return send(res, 403, { error: 'Slack background and profiles stay in private workstreams. Explicitly forward the messages you want shared.' });
        // The current user message is saved only after its provider finishes.
        // Authorize tools against the server-held active Slack request first,
        // never caller-supplied channel/user fields or a synced activeRun blob.
        const active = [...runs.values()].find(run => run.taskId === task.id && run.tabId === tab.id);
        const source = active?.slackFrom
          ? { author: { id: `slack:${active.slackFrom.user.id}` }, fromSlack: active.slackFrom }
          : tab.messages?.findLast(message => message.role === 'user' && message.fromSlack);
        const from = source?.fromSlack;
        const user = String(source?.author?.id || '').replace(/^slack:/, '');
        const route = from ? rememberedSlackThread(from.channel, from.threadTs || from.ts) : null;
        if (!from || !/^U[A-Z0-9]+$/.test(user) || route?.threadId !== task.id || route?.tabId !== tab.id || !slackMayUse(await slackScopeFor(user), task)) {
          return send(res, 403, { error: 'This tab has no current authorized Slack conversation.' });
        }
        // The channel is derived from the verified request, never a tool input.
        if (parts[2] === 'slack-people') {
          const people = await slackPeople.read({ channel: from.channel, query: String(body.query || ''), cursor: String(body.cursor || ''), turn: `${task.id}:${tab.id}:${from.ts}` });
          return send(res, 200, people);
        }
        const context = await slackContext.read({ channel: from.channel, mentionTs: from.ts, before: String(body.before || ''), query: String(body.query || ''), messageTs: String(body.messageTs || ''), turn: `${task.id}:${tab.id}:${from.ts}` });
        return send(res, 200, { ...context, text: undefined });
      }
      const messages = recallFromFold(tab, String(body.query || ''), { limit: 5, maxChars: 2_000 }).map((row) => ({ id: row.id, who: row.role === 'user' ? 'User' : row.role === 'tab' ? 'Tab message' : 'Assistant', text: row.text }));
      return send(res, 200, { messages });
    } catch (error) {
      return send(res, error.status || 400, { error: error.message });
    }
  }
  // ---- Cloud handoff (Phase B): keep running with the laptop off. ----
  // Internal worker hook: after hydration + relay attach, persist the real Fly
  // Machine id in the worker's copy so later cloud-side turns retain it.
  if (parts[1] === 'handoff' && parts[2] === 'worker-ready' && method === 'POST') {
    if (RUNNER_KIND !== 'cloud' || !CLOUD_TASK_ID) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const task = getTask(CLOUD_TASK_ID);
    if (!task) return send(res, 404, { error: 'handed-off thread was not synced' });
    task.cloudHandoff = {
      ...(task.cloudHandoff || {}),
      machineId: body.machineId || process.env.FLY_MACHINE_ID || task.cloudHandoff?.machineId || '',
      state: 'running',
      startedAt: task.cloudHandoff?.startedAt || new Date().toISOString(),
    };
    saveTask(task);
    await sync.flushNow();
    return send(res, 200, { ok: true });
  }

  // The worker uploads its final workspace before it exits, then records the
  // authenticated object receipt here so the desktop can restore it safely.
  if (parts[1] === 'handoff' && parts[2] === 'worker-workspace' && method === 'POST') {
    if (RUNNER_KIND !== 'cloud' || !CLOUD_TASK_ID) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const task = getTask(CLOUD_TASK_ID);
    const source = task?.cloudHandoff?.workspace?.source;
    const returned = body.snapshot;
    if (!task || !source) return send(res, 404, { error: 'handed-off workspace was not synced' });
    if (returned?.taskId !== task.id || returned?.kind !== 'return' || returned?.parentId !== source.id) {
      return send(res, 400, { error: 'returned workspace does not match this handoff' });
    }
    task.cloudHandoff.workspace.returned = returned;
    task.cloudHandoff.state = 'stopping';
    saveTask(task);
    await sync.flushNow();
    return send(res, 200, { ok: true });
  }

  if (parts[1] === 'handoff' && parts[2] === 'worker-stopping' && method === 'POST') {
    if (RUNNER_KIND !== 'cloud' || !CLOUD_TASK_ID) return send(res, 404, { error: 'not found' });
    const task = getTask(CLOUD_TASK_ID);
    if (task) {
      const body = await readBody(req).catch(() => ({}));
      task.cloudHandoff = {
        ...(task.cloudHandoff || {}),
        state: body.workspaceError ? 'return-failed' : 'stopped',
        stoppedAt: new Date().toISOString(),
        workspaceError: String(body.workspaceError || '').slice(0, 500),
      };
      saveTask(task);
      await sync.flushNow();
    }
    return send(res, 200, { ok: true });
  }

  // POST /api/handoff/cloud {taskId} -> boot an ephemeral Fly worker, hand it the
  // model creds over the encrypted channel, and let it take the lease. The
  // desktop can then sleep. Returns { machineId }.
  if (parts[1] === 'handoff' && parts[2] === 'cloud' && method === 'POST') {
    if (!flymachines.isConfigured()) return send(res, 409, { error: 'cloud worker not configured (FLY_API_TOKEN / WORKER_IMAGE)' });
    const sess = relay.sessionInfo();
    if (!sess) return send(res, 409, { error: 'not signed in' });
    const body = await readBody(req);
    const taskId = body.taskId || body.task;
    if (!taskId) return send(res, 400, { error: 'taskId required' });
    const handoffTask = getTask(taskId);
    if (!handoffTask) return send(res, 404, { error: 'no such thread' });
    if (taskIsHandedToCloud(handoffTask)) return send(res, 409, { error: 'this thread is already moving to or running in Supreme Cloud' });
    if ([...runs.values(), ...duelRuns.values()].some((run) => run.taskId === taskId)) {
      return send(res, 409, { error: 'let the current run finish before moving this thread to Supreme Cloud' });
    }
    const cfg = supabase.config();
    const startedAt = new Date().toISOString();
    // Worktree paths are absolute + machine-specific. Threads sync across a
    // user's Macs (which can have different usernames, e.g. /Users/example vs
    // /Users/example), so a thread created on another Mac has a worktree path
    // that doesn't exist here — there are no files on this Mac to hand off. Catch
    // that before snapshotting so the user gets a clear reason, not a raw ENOENT.
    const worktree = handoffTask.worktreePath;
    if (!worktree || !fs.existsSync(worktree)) {
      return send(res, 409, {
        error: worktree
          ? 'This thread’s workspace was created on another Mac, so its files aren’t on this one. Move it to the cloud from the Mac where you started it.'
          : 'This thread has no workspace to move to the cloud yet.',
      });
    }
    let workspaceSource;
    try {
      workspaceSource = await workspaceHandoff.uploadWorkspaceSnapshot({
        root: worktree,
        taskId,
        token: sess.token,
        userId: sess.userId,
        kind: 'source',
      });
    } catch (error) {
      return send(res, 502, { error: `Could not preserve this workspace: ${error.message}` });
    }
    handoffTask.cloudHandoff = {
      machineId: '',
      state: 'starting',
      startedAt,
      workspace: {
        source: workspaceSource,
        originalWorktreePath: handoffTask.worktreePath,
        originalBranch: handoffTask.branch,
      },
    };
    saveTask(handoffTask);
    await sync.flushNow();
    try {
      const machine = await flymachines.bootWorkerForHandoff({
        env: {
          SUPABASE_URL: cfg.url,
          SUPABASE_ANON_KEY: cfg.anonKey,
          WB_SESSION_TOKEN: sess.token,
          WB_USER_ID: sess.userId,
          WB_TASK: taskId,
          WB_HANDOFF: '1',
          WB_WORKSPACE_HANDOFF: '1',
        },
      }, async (startedMachine) => {
        // Hand the worker the local model credentials (encrypted to its
        // ephemeral key) and wait until it owns the lease + relay subscription.
        await relay.sendCreds(credhandoff.readLocalCreds(), 120_000, { requireWorkspaceVersion: 1 });
        const fresh = getTask(taskId) || handoffTask;
        fresh.cloudHandoff = {
          ...(fresh.cloudHandoff || {}),
          machineId: startedMachine.id,
          state: 'running',
          startedAt,
        };
        saveTask(fresh);
        await sync.flushNow();
        return startedMachine;
      });
      return send(res, 200, { ok: true, machineId: machine.id, task: taskForClient(getTask(taskId)) });
    } catch (err) {
      const fresh = getTask(taskId);
      if (fresh?.cloudHandoff?.startedAt === startedAt) {
        delete fresh.cloudHandoff;
        saveTask(fresh);
        await sync.flushNow().catch(() => {});
      }
      await workspaceHandoff.deleteWorkspaceSnapshot(workspaceSource, {
        token: sess.token,
        userId: sess.userId,
        taskId,
      }).catch(() => {});
      return send(res, 502, { error: err.message });
    }
  }

  // POST /api/handoff/local {machineId, taskId?} -> gracefully stop the worker,
  // pull its final transcript, then let the desktop resume locally.
  if (parts[1] === 'handoff' && parts[2] === 'local' && method === 'POST') {
    if (!flymachines.isConfigured()) return send(res, 409, { error: 'cloud worker not configured' });
    const body = await readBody(req);
    if (!body.machineId) return send(res, 400, { error: 'machineId required' });
    const sess = relay.sessionInfo();
    if (!sess) return send(res, 409, { error: 'not signed in' });
    try {
      if (body.taskId) {
        const local = getTask(body.taskId);
        if (local?.cloudHandoff?.machineId && local.cloudHandoff.machineId !== body.machineId) {
          return send(res, 409, { error: 'this thread is attached to a different cloud worker' });
        }
      }
      const taskIds = body.taskId
        ? [body.taskId]
        : listTasks()
          .map((summary) => getTask(summary.id))
          .filter((candidate) => candidate?.cloudHandoff?.machineId === body.machineId)
          .map((candidate) => candidate.id);
      await flymachines.stopWorker(body.machineId);
      let updatedTask = null;
      let workspaceResult = null;
      for (const candidateId of taskIds) {
        const candidate = await sync.pullThread(candidateId).catch(() => getTask(candidateId));
        if (!candidate) continue;
        workspaceResult = await workspaceHandoff.restoreReturnedWorkspace({
          task: candidate,
          token: sess.token,
          userId: sess.userId,
        });
        candidate.lastWorkspaceHandoff = {
          ...workspaceResult,
          at: new Date().toISOString(),
        };
        delete candidate.cloudHandoff;
        saveTask(candidate);
        updatedTask = candidate;
      }
      await sync.flushNow();
      return send(res, 200, {
        ok: true,
        task: updatedTask ? taskForClient(updatedTask) : null,
        workspace: workspaceResult,
      });
    } catch (err) {
      return send(res, 502, { error: err.message });
    }
  }

  // Provider setup is launched from the UI so users never need a terminal.
  // Claude and ChatGPT use their official local OAuth flows; Grok opens its
  // official web sign-in because it is not yet a directly routable provider.
  if (parts[1] === 'providers' && parts.length === 4 && parts[3] === 'install' && method === 'POST') {
    const provider = String(parts[2] || '').toLowerCase();
    if (!['claude', 'codex'].includes(provider)) return send(res, 404, { error: 'not found' });
    if (ONBOARDING_LAB_ENABLED) {
      onboardingLabState.providers[provider] = fakeProvider(provider, { installed: true, authenticated: false });
      return send(res, 200, { ok: true, simulated: true, status: probeStatus() });
    }
    const bin = provider === 'claude' ? 'claude' : 'codex';
    if (whichSync(bin) || resolveCliBinary(provider)) return send(res, 200, { ok: true, installed: true, status: probeStatus() });
    const started = launchProviderInstaller(provider);
    return send(res, 202, { ok: true, installing: true, started });
  }

  if (parts[1] === 'providers' && parts.length === 4 && ['connect', 'disconnect'].includes(parts[3])) {
    const provider = String(parts[2] || '').toLowerCase();
    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (ONBOARDING_LAB_ENABLED && ['claude', 'codex'].includes(provider)) {
      const current = onboardingLabState.providers[provider] || fakeProvider(provider);
      onboardingLabState.providers[provider] = {
        ...current,
        installed: true,
        authenticated: parts[3] === 'connect',
        ready: parts[3] === 'connect',
        email: parts[3] === 'connect' ? 'friend@example.com' : '',
        plan: parts[3] === 'connect' ? (provider === 'claude' ? 'max' : 'plus') : '',
        hint: parts[3] === 'connect' ? '' : `Sign in to ${provider === 'claude' ? 'Claude' : 'ChatGPT'}`,
      };
      return send(res, parts[3] === 'connect' ? 202 : 200, { ok: true, simulated: true });
    }
    if (provider === 'grok') {
      const settings = getSettings();
      settings.onboarding = settings.onboarding && typeof settings.onboarding === 'object' ? settings.onboarding : {};
      const connected = new Set(Array.isArray(settings.onboarding.webProviders) ? settings.onboarding.webProviders : []);
      if (parts[3] === 'connect') connected.add('grok');
      else connected.delete('grok');
      settings.onboarding.webProviders = [...connected];
      saveSettings(settings);
      invalidateModelUsage();
      return send(res, 200, { ok: true, loginUrl: GROK_LOGIN_URL, webOnly: true });
    }
    const meta = PROVIDER_META[provider];
    if (!meta) return send(res, 404, { error: 'unknown provider' });
    if (parts[3] === 'connect') {
      if (!whichSync(provider)) return send(res, 409, { error: `${meta.label} needs to be installed first`, loginUrl: meta.loginUrl });
      launchProviderAuth(provider);
      invalidateModelUsage();
      invalidateProviderAccount(provider);
      clearAccountNotices(provider);
      return send(res, 202, { ok: true, loginUrl: meta.loginUrl });
    }
    const ok = await runProviderLogout(provider);
    if (ok) {
      invalidateModelUsage();
      // The logout just succeeded, so the answer is known — seed it rather
      // than letting the credentials-file fallback report still-signed-in.
      _accountCache.seed(provider, { authenticated: false, email: '', plan: '' });
    }
    return send(res, ok ? 200 : 409, ok ? { ok: true } : { error: `Could not sign out of ${meta.label}` });
  }

  // GET /api/duels -> real comparison history. Unpicked comparisons remain
  // blind here just as they do inside the source thread.
  if (parts[1] === 'duels' && parts.length === 2 && method === 'GET') {
    return send(res, 200, duelHistorySnapshot());
  }

  // GET /api/stats  -> real aggregates computed from actual threads/tabs/runs.
  // No fabricated numbers: everything here comes from the task store.
  if (parts[1] === 'stats' && method === 'GET') {
    let threads = 0, tabs = 0, runs = 0, errors = 0, connectorsOn = 0;
    const byModel = {};
    const byProject = {};
    for (const s of listTasks()) {
      const t = getTask(s.id);
      if (!t) continue;
      threads++;
      if (t.connectors) connectorsOn++;
      byProject[t.repoName || t.repo] = (byProject[t.repoName || t.repo] || 0) + 1;
      for (const tb of t.tabs || []) {
        tabs++;
        for (const m of tb.messages || []) {
          if (m.role === 'assistant') {
            runs++;
            if (m.ok === false) errors++;
            const mid = m.model || tb.model || 'unknown';
            byModel[mid] = (byModel[mid] || 0) + 1;
          }
        }
      }
    }
    const evals = listEvals();
    const picks = evals.filter((e) => e.kind === 'pick');
    const wins = {};
    for (const p of picks) if (p.winner) wins[p.winner] = (wins[p.winner] || 0) + 1;
    return send(res, 200, { threads, tabs, runs, errors, connectorsOn, byModel, byProject, duels: evals.filter((e) => e.kind === 'duel').length, picks: picks.length, wins });
  }

  // GET /api/performance -> month-to-date model usage and metered spend.
  // Archived tabs still count: archiving is organization, not data deletion.
  if (parts[1] === 'performance' && method === 'GET') {
    return send(res, 200, performanceSnapshot());
  }

  // GET /api/connectors  -> the claude.ai MCP connectors the `claude` CLI has,
  // so the UI can show what an agent can reach when connectors are on.
  // The Connectors page (Paper 15): one row per connector across providers,
  // with usage seeded once from local Claude/Codex history and then counted
  // per turn. Refresh forces a real scan; the overview otherwise trusts the
  // 60s cache like everything else.
  if (parts[1] === 'connectors' && parts[2] === 'overview' && parts.length === 3 && method === 'GET') {
    const list = await listConnectors({ fresh: url.searchParams.get('fresh') === '1' });
    return send(res, 200, connectorOverview(list, ensureConnectorUsage(), { chrome: chromeExtensionStatus() }));
  }
  // POST /api/connectors/login {provider:'codex', server} -> a remote Codex
  // server signs in through its own CLI (`codex mcp login <name>` opens the
  // browser and stores the token where Codex reads it). The page's Sign in
  // button for a ChatGPT row lands here; chatgpt.com settings cannot fix a
  // CLI's OAuth session.
  if (parts[1] === 'connectors' && parts[2] === 'login' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const server = String(body.server || '').trim();
    if (body.provider !== 'codex' || !/^[\w.-]+$/.test(server)) return send(res, 400, { error: 'Only a Codex server signs in here.' });
    if (!cachedConnectorList().some((row) => row.provider === 'codex' && row.server === server)) {
      return send(res, 404, { error: `Codex lists no server named ${server}.` });
    }
    try {
      const child = spawn(resolveCliBinary('codex') || 'codex', ['mcp', 'login', server], { detached: true, stdio: 'ignore', env: { ...process.env } });
      child.on('error', (err) => console.error(`[connectors] codex mcp login ${server}:`, err.message));
      child.unref();
    } catch (err) {
      return send(res, 500, { error: `Could not start the sign-in: ${err.message}` });
    }
    _connectorCache = { at: 0, list: _connectorCache.list };
    return send(res, 202, { ok: true, server });
  }
  if (parts[1] === 'connectors' && parts[2] === 'refresh' && parts.length === 3 && method === 'POST') {
    const list = await listConnectors({ fresh: true });
    return send(res, 200, connectorOverview(list, ensureConnectorUsage(), { chrome: chromeExtensionStatus() }));
  }
  if (parts[1] === 'connectors' && method === 'GET') {
    const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('refresh') === '1';
    return send(res, 200, { connectors: await listConnectors({ fresh }) });
  }

  // Platform Context is synced account data keyed by a durable platform slug,
  // never by the connector or browser mechanism currently used to reach it.
  if (parts[1] === 'context') {
    if (parts.length === 2 && method === 'GET') {
      return send(res, 200, await platformContextPayload());
    }
    const definition = platformContextDefinition(decodeURIComponent(parts[2]), currentPlatformDefinitions());
    if (!definition) return send(res, 404, { error: 'unknown platform' });
    if (parts.length === 3 && method === 'GET') {
      return send(res, 200, await platformContextPayload(definition.key));
    }
    if (parts.length === 4 && parts[3] === 'run' && method === 'POST') {
      return runPlatformContextTurn({ req, res, definition });
    }
    if (parts.length === 4 && parts[3] === 'lock' && method === 'POST') {
      const record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
      if (!lockPlatformContextDraft(record)) return send(res, 409, { error: 'There is no draft Context to save.' });
      savePlatformContextRecord(definition.key, record);
      const payload = await platformContextPayload(definition.key);
      return send(res, 200, { ok: true, context: payload.context });
    }
    if (parts.length === 5 && parts[3] === 'suggestions' && method === 'POST' && (parts[4] === 'stage' || parts[4] === 'clear')) {
      const record = platformContextRecord(getSettings().platformContexts, definition.key, currentPlatformDefinitions());
      const changed = parts[4] === 'stage' ? stagePlatformContextSuggestions(record) : clearPlatformContextSuggestions(record);
      if (!changed) return send(res, 409, { error: 'There are no suggestions to review.' });
      if (parts[4] === 'stage') {
        appendPlatformContextMessage(record, 'assistant', `From recent ${definition.name} work, I suggest these additions. Review the draft and lock it in to save.`);
      }
      savePlatformContextRecord(definition.key, record);
      const payload = await platformContextPayload(definition.key);
      return send(res, 200, { ok: true, context: payload.context });
    }
    if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
      const runId = platformContextRuns.get(definition.key);
      const run = runId ? runs.get(runId) : null;
      if (!run) return send(res, 409, { error: 'That Context run is no longer active.' });
      run.cancelled = true;
      recordRunEvent(run.id, { type: 'status', text: 'Stopping…' });
      run.controller?.abort();
      return send(res, 200, { ok: true });
    }
  }

  // GET /api/models
  if (parts[1] === 'models' && method === 'GET') {
    const or = url.searchParams.get('openrouter') === '1' ? await listOpenRouterModels() : [];
    return send(res, 200, { models: MODELS, openrouterStarters: OPENROUTER_STARTERS, openrouter: or });
  }

  // Live subscription limits from each provider's own authenticated local
  // account. The response is normalized and never includes credentials.
  if (parts[1] === 'model-usage' && parts.length === 2 && method === 'GET') {
    return send(res, 200, await getModelUsage({ fresh: url.searchParams.get('fresh') === '1' }));
  }

  // settings
  if (parts[1] === 'settings') {
    if (method === 'GET') {
      const s = getSettings();
      return send(res, 200, {
        ...s,
        ...(s.defaultModel ? { defaultModel: await currentModelFresh(s.defaultModel) } : {}),
        performancePolicy: normalizePerformancePolicy(s.performancePolicy),
        openrouterKey: s.openrouterKey ? 'set' : '',
        slack: { ...slackPrefs(s), botToken: slackPrefs(s).botToken ? 'set' : '', appToken: slackPrefs(s).appToken ? 'set' : '', listening: slackSocketStatus(), health: await slackHealth(), oauth: slackOAuthConfig().configured, source: s.slack?.source || (slackPrefs(s).botToken ? 'manual' : ''), team: s.slack?.team || '' },
        email: { ...emailSettings(), enabled: emailSettings().enabled !== false, resendKey: emailSettings().resendKey ? 'set' : '', pickup: emailPickup.status() },
        dataDir: DATA_DIR,
        home: os.homedir(),
      });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const s = getSettings();
      if (typeof body.openrouterKey === 'string') s.openrouterKey = body.openrouterKey;
      // Slack rail (mentions + landed runs). 'set' is the masked read-back,
      // never a real token.
      let verifySlackAfterSave = false;
      let restartSlackListener = false;
      // Section 32: who may email Supreme, which prefix is which project,
      // the sending domain and its key. The key reads back as "set" only.
      if (body.email && typeof body.email === 'object') {
        const current = s.email && typeof s.email === 'object' ? s.email : {};
        const next = { ...current };
        if (typeof body.email.enabled === 'boolean') next.enabled = body.email.enabled;
        if (Array.isArray(body.email.allowFrom)) next.allowFrom = body.email.allowFrom.map((value) => String(value || '').trim().toLowerCase()).filter((value) => /@/.test(value)).slice(0, 20);
        if (body.email.aliases && typeof body.email.aliases === 'object') next.aliases = Object.fromEntries(Object.entries(body.email.aliases).map(([key, value]) => [String(key).trim().toLowerCase(), String(value || '').trim()]).filter(([key, value]) => key && value).slice(0, 40));
        if (typeof body.email.domain === 'string') next.domain = body.email.domain.trim().toLowerCase().slice(0, 120);
        if (typeof body.email.resendKey === 'string' && body.email.resendKey !== 'set') next.resendKey = body.email.resendKey.trim();
        s.email = next;
        if (body.email.aliases) setTimeout(() => { team.pushOwnedProjectsNow(); }, 0);
      }
      if (body.slack && typeof body.slack === 'object') {
        const current = s.slack && typeof s.slack === 'object' ? s.slack : {};
        const next = { ...current };
        if (typeof body.slack.botToken === 'string' && body.slack.botToken !== 'set') { next.botToken = body.slack.botToken.trim(); next.source = 'manual'; next.team = ''; verifySlackAfterSave = true; }
        // @Supreme in Slack: the app-level token opens the socket; a new one restarts it.
        if (typeof body.slack.appToken === 'string' && body.slack.appToken !== 'set') { next.appToken = body.slack.appToken.trim(); restartSlackListener = true; }
        for (const key of ['notifyMentions', 'notifyCompleted', 'notifyFailures', 'startNewThreads']) {
          if (typeof body.slack[key] === 'boolean') next[key] = body.slack[key];
        }
        if (typeof body.slack.selfEmail === 'string') next.selfEmail = body.slack.selfEmail.trim().toLowerCase().slice(0, 200);
        if (body.slack.minRunSeconds !== undefined && Number.isFinite(Number(body.slack.minRunSeconds))) {
          next.minRunSeconds = Math.max(0, Number(body.slack.minRunSeconds));
        }
        s.slack = next;
      }
      // Per-install identity for the sidebar. Set during onboarding; editable in-app.
      if (typeof body.userName === 'string') s.userName = body.userName.trim().slice(0, 80);
      if (typeof body.defaultModel === 'string') {
        if (!isSelectableModel(body.defaultModel)) return send(res, 400, { error: 'unknown model' });
        s.defaultModel = body.defaultModel;
      }
      if (typeof body.defaultEffort === 'string') s.defaultEffort = body.defaultEffort;
      // Keep the Mac awake so runs finish after you step away / close the lid.
      if (typeof body.keepAwake === 'string' && ['off', 'running', 'always'].includes(body.keepAwake)) {
        s.keepAwake = body.keepAwake;
      }
      if (typeof body.browserControlEnabled === 'boolean') s.browserControlEnabled = body.browserControlEnabled;
      if (body.browserControlByProvider && typeof body.browserControlByProvider === 'object') {
        const current = s.browserControlByProvider && typeof s.browserControlByProvider === 'object'
          ? s.browserControlByProvider
          : {};
        const next = { ...current };
        for (const provider of ['claude', 'codex', 'grok']) {
          if (typeof body.browserControlByProvider[provider] === 'boolean') {
            next[provider] = body.browserControlByProvider[provider];
          }
        }
        s.browserControlByProvider = next;
      }
      if (body.onboarding && typeof body.onboarding === 'object') {
        const incoming = body.onboarding;
        const current = s.onboarding && typeof s.onboarding === 'object' ? s.onboarding : {};
        const next = { ...current };
        if (typeof incoming.complete === 'boolean') next.complete = incoming.complete;
        if (typeof incoming.signedIn === 'boolean') next.signedIn = incoming.signedIn;
        if (['signin', 'models', 'linkedin', 'greeting', 'directions', 'complete'].includes(incoming.step)) next.step = incoming.step;
        if (typeof incoming.email === 'string') next.email = incoming.email.trim().slice(0, 160);
        if (['claude', 'codex', ''].includes(incoming.selectedProvider)) next.selectedProvider = incoming.selectedProvider;
        if (Array.isArray(incoming.verifiedProviders)) {
          next.verifiedProviders = [...new Set(incoming.verifiedProviders.filter((value) => value === 'claude' || value === 'codex'))];
        }
        if (typeof incoming.chromeSkipped === 'boolean') next.chromeSkipped = incoming.chromeSkipped;
        if (typeof incoming.chromeReady === 'boolean') next.chromeReady = incoming.chromeReady;
        if (typeof incoming.chromeError === 'string') next.chromeError = incoming.chromeError.trim().slice(0, 240);
        if (typeof incoming.linkedinUrl === 'string') next.linkedinUrl = incoming.linkedinUrl.trim().slice(0, 300);
        if (incoming.profile === null) { next.profile = null; }
        if (incoming.read === null) { next.read = null; }
        if (incoming.answers && typeof incoming.answers === 'object') next.answers = normalizeOnboardingAnswers(incoming.answers);
        if (incoming.direction === null || Number.isInteger(incoming.direction)) next.direction = incoming.direction;
        if (incoming.firstTaskId === null || (typeof incoming.firstTaskId === 'string' && /^[0-9a-f-]{36}$/i.test(incoming.firstTaskId))) next.firstTaskId = incoming.firstTaskId;
        if (Array.isArray(incoming.webProviders)) next.webProviders = [...new Set(incoming.webProviders.map((value) => String(value)).filter((value) => value === 'grok'))];
        s.onboarding = next;
      }
      if (typeof body.performancePolicy === 'string') {
        if (normalizePerformancePolicy(body.performancePolicy) !== body.performancePolicy) return send(res, 400, { error: 'unknown performance policy' });
        s.performancePolicy = body.performancePolicy;
      }
      if (body.threadLayout && typeof body.threadLayout === 'object') {
        const root = String(body.threadLayout.root || '');
        if (!/^[0-9a-f-]{36}$/i.test(root)) return send(res, 400, { error: 'invalid layout root' });
        const incoming = body.threadLayout.layout;
        const updatedAt = Number((incoming && incoming.updatedAt) || body.threadLayout.updatedAt || Date.now());
        if (!Number.isFinite(updatedAt)) return send(res, 400, { error: 'invalid layout timestamp' });
        s.threadLayouts = s.threadLayouts && typeof s.threadLayouts === 'object' ? s.threadLayouts : {};
        const currentAt = Number((s.threadLayouts[root] || {}).updatedAt || 0);
        if (updatedAt >= currentAt) {
          if (!incoming || incoming.deleted) {
            // Keep a timestamped tombstone so an older Workbench tab cannot
            // resurrect a layout that was deliberately removed.
            s.threadLayouts[root] = { panes: [], updatedAt, deleted: true };
          } else {
            const panes = (Array.isArray(incoming.panes) ? incoming.panes : []).flatMap((pane) => {
              const threadId = String((pane && pane.threadId) || '');
              const tabId = pane && pane.tabId == null ? null : String(pane.tabId);
              if (!/^[0-9a-f-]{36}$/i.test(threadId)) return [];
              if (tabId != null && !/^[0-9a-f-]{36}$/i.test(tabId)) return [];
              const width = Number(pane && pane.width);
              return [{
                threadId,
                tabId,
                ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width * 10000) / 10000 } : {}),
              }];
            });
            s.threadLayouts[root] = { panes, updatedAt };
          }
        }
      }
      saveSettings(s);
      if (restartSlackListener) startSlackListener();
      refreshKeepAwake(); // apply a keepAwake change immediately
      // A freshly pasted token gets its verdict now, while the person is
      // looking at the field, not ten minutes later.
      const slack = verifySlackAfterSave ? { health: await slackHealth({ force: true }) } : undefined;
      // A pasted token travels with the owner's shared projects too.
      if (verifySlackAfterSave) team.shareSlackToken().catch((err) => console.warn('[slack] share token:', err.message));
      return send(res, 200, { ok: true, ...(slack ? { slack } : {}) });
    }
  }

  // repos
  if (parts[1] === 'repos' && parts.length === 2) {
    if (method === 'GET') return send(res, 200, { repos: team.decorateProjects(await localizeProjects()) });
    if (method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 120);
      if (!body.path) {
        if (!name) return send(res, 400, { error: 'project name required' });
        const projectId = newId();
        const root = await createManagedProject({ name, id: projectId });
        const rec = addRepo({ id: projectId, path: root, name, base: 'main', hasRemote: false, managed: true });
        return send(res, 200, { repo: rec });
      }
      // Path-based registration remains available to old API clients, but the
      // non-coding product UI never exposes it.
      const raw = String(body.path).replace(/^~/, os.homedir());
      const root = await repoRoot(raw);
      if (!root) return send(res, 400, { error: 'not a git repository' });
      const base = await currentBranch(root);
      const remote = await hasRemote(root);
      const rec = addRepo({ path: root, name: name || path.basename(root), base, hasRemote: remote, managed: false });
      return send(res, 200, { repo: rec });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const p = (body.path || '').toString();
      if (!p) return send(res, 400, { error: 'path required' });
      let r = null;
      if ('archived' in body) r = setRepoArchived(p, !!body.archived);
      if (typeof body.name === 'string' && body.name.trim()) r = renameRepo(p, body.name.trim());
      if (Array.isArray(body.contextBlocks)) r = setRepoContextBlocks(p, body.contextBlocks);
      if (!r) return send(res, 404, { error: 'no such project' });
      return send(res, 200, { repo: r });
    }
    if (method === 'DELETE') {
      const p = url.searchParams.get('path');
      if (!p) return send(res, 400, { error: 'path required' });
      const project = listRepos().find((candidate) => candidate.path === p);
      if (!project) return send(res, 404, { error: 'no such project' });
      if (!project.archived) return send(res, 409, { error: 'archive the project before permanently deleting it' });
      const projectTasks = listTasks().filter((summary) => (
        project.id && summary.projectId ? summary.projectId === project.id : summary.repo === p
      ));
      if ([...runs.values()].some((run) => projectTasks.some((summary) => summary.id === run.taskId))) {
        return send(res, 409, { error: 'a workstream in that project is still running' });
      }
      if (project.shared) {
        try { await team.deleteProject(project.id, { taskIds: projectTasks.map((summary) => summary.id) }); }
        catch (err) { return send(res, 409, { error: team.friendlyError(err) }); }
      }
      for (const summary of projectTasks) {
        const projectTask = getTask(summary.id);
        if (!projectTask) continue;
        try {
          await removeWorktree({ repo: projectTask.repo, worktreePath: projectTask.worktreePath, branch: projectTask.branch });
        } catch {}
        removeTaskImageAttachments(projectTask.id);
        deleteTask(projectTask.id);
      }
      removeRepo(p);
      return send(res, 200, { ok: true, deletedWorkstreams: projectTasks.length });
    }
  }

  // GET /api/repos/branches?path=
  if (parts[1] === 'repos' && parts[2] === 'branches' && method === 'GET') {
    const p = url.searchParams.get('path');
    const root = p ? await repoRoot(p) : null;
    if (!root) return send(res, 400, { error: 'not a git repository' });
    return send(res, 200, { branches: await listBranches(root), current: await currentBranch(root), hasRemote: await hasRemote(root) });
  }

  // Read-only Slack index, containing light summaries. Full context is read
  // only by transcript search or the existing task endpoint when opened.
  if (parts[1] === 'slack' && parts[2] === 'inbox' && parts.length === 3) {
    if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const page = slackInboxPage(team.decorateSummaries(listTasks()), {
      query: url.searchParams.get('q') || '',
      filter: url.searchParams.get('filter') === 'history' ? 'history' : 'active',
      offset: url.searchParams.get('offset') || 0,
      limit: url.searchParams.get('limit') || 50,
      readTask: (id) => { try { return getTask(id); } catch { return null; } },
    });
    return send(res, 200, page);
  }

  if (parts[1] === 'search' && parts.length === 2) {
    if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return send(res, 200, workspaceSearch(team.decorateSummaries(listTasks()), {
      query: url.searchParams.get('q') || '', offset: url.searchParams.get('offset') || 0,
      projects: listRepos(), readTask: (id) => { try { return getTask(id); } catch { return null; } },
    }));
  }

  // tasks collection
  if (parts[1] === 'tasks' && parts.length === 2) {
    if (method === 'GET' && url.searchParams.has('running')) {
      const ids = new Set([...runs.values()].map((run) => run.taskId).filter(Boolean));
      for (const key of duelRuns.keys()) ids.add(String(key).split('::')[0]);
      return send(res, 200, { ids: [...ids] });
    }
    if (method === 'GET' && url.searchParams.has('ids')) {
      const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 40);
      const rows = [];
      for (const id of ids) {
        try { const found = getTask(id); if (found) rows.push(taskSummary(found)); } catch { /* a bad id is simply not answered */ }
      }
      return send(res, 200, { tasks: team.decorateSummaries(rows) });
    }
    if (method === 'GET') return send(res, 200, { tasks: team.decorateSummaries(listTasks()) });
    if (method === 'POST') {
      const body = await readBody(req);
      const requestedRepo = String(body.repo || '').replace(/^~/, os.homedir());
      const repos = listRepos();
      let project = repos.find((candidate) => body.projectId && candidate.id === body.projectId)
        || repos.find((candidate) => candidate.path === requestedRepo)
        || null;
      let root = null;
      if (project) {
        // A synced project's `path` may point at another Mac. Registered
        // Supreme projects always get a local backing here, including legacy
        // path-only records from before projects had stable ids.
        root = await localProjectRoot(project, { portableFallback: true });
      } else root = await repoRoot(requestedRepo);
      if (!root) return send(res, 400, { error: 'Choose a Supreme project first.' });
      const model = await currentModelFresh(body.model || getSettings().defaultModel || RECOMMENDED_MODEL_ID);
      if (!isSelectableModel(model)) return send(res, 400, { error: 'unknown model' });
      const title = (body.title || titleFrom(body.prompt) || 'Untitled task').trim();
      const id = newId();
      let wt;
      try {
        wt = await createWorktree({ repo: root, title, base: body.base, id });
      } catch (e) {
        return send(res, 400, { error: `could not create worktree: ${e.message}` });
      }
      if (!project) project = listRepos().find((candidate) => candidate.path === root) || null;
      const repoKey = project?.path || root;
      const repoName = project?.name || path.basename(root);
      const task = createTask({
        id,
        title,
        projectId: project?.id,
        repo: repoKey,
        repoName,
        base: wt.base,
        branch: wt.branch,
        worktreePath: wt.worktreePath,
        model,
        tools: body.tools || 'full',
        connectors: body.connectors,
      });
      if (team.isSharedTask(task)) { team.stampCreatedBy(task); saveTask(task); }
      return send(res, 200, { task: taskForClient(task) });
    }
  }

  // single task
  if (parts[1] === 'tasks' && parts.length >= 3) {
    const id = parts[2];
    let task;
    try {
      task = getTask(id);
    } catch {
      return send(res, 400, { error: 'bad id' });
    }
    if (!task) return send(res, 404, { error: 'no such task' });

    // GET /api/tasks/:id/pulse: enough for a client to tell whether anything
    // on the thread changed since it last read the whole thing. The poll
    // used to read the full transcript of every open shared or running thread
    // every 1.2s, megabytes at a time; the pulse is a few hundred bytes.
    if (parts[3] === 'pulse' && parts.length === 4 && method === 'GET') {
      reconcileTaskRuntimeState(task, ORPHANED_RUN_MESSAGE);
      const decorated = team.decorateTask(task);
      const liveSeq = new Map([...runs.values()].filter((run) => run.taskId === task.id).map((run) => [run.tabId, run.seq || 0]));
      // Section 27: the map, its traffic and a tab's type change without a
      // message landing, so the pulse carries them too.
      const pulseMap = mapPublic(task, getTask);
      const traffic = task.traffic || [];
      return send(res, 200, {
        updatedAt: task.updatedAt || null,
        map: `${Object.keys(pulseMap.cards).length}:${pulseMap.edges.length}:${traffic.length}:${traffic.filter((row) => row.undone).length}:${task.mapOff ? 1 : 0}`,
        tabs: (decorated.tabs || []).map((tab) => ({
          id: tab.id,
          type: tab.type || '',
          status: tab.status || 'idle',
          messages: (tab.messages || []).length,
          seq: liveSeq.get(tab.id) ?? (tab.activeRun?.seq || 0),
          folds: (tab.folds || []).length,
          duel: tab.duel?.phase || '',
          queue: (tab.queue || []).map((item) => `${item.id}:${item.status}:${item.online}`),
          typing: (tab.typing || []).map((typer) => typer.userId),
          remote: tab.activeRun?.remote?.name || '',
        })),
      });
    }

    // Connected tabs (Paper page 8-2): this workstream's map. The cards are
    // its tabs plus any dragged in from elsewhere, an edge is a hand-over
    // said in words, and every write answers with the whole map read fresh
    // so names follow the tabs.
    if (parts[3] === 'map' && parts.length === 4 && method === 'GET') {
      return send(res, 200, { map: mapPublic(task, getTask), hiddenTabs: hiddenOwnTabs(task).map((tab) => ({ id: tab.id, name: tab.name || 'Untitled' })) });
    }
    // Opt-in maps: POST starts (or brings back) this workstream's map, DELETE
    // takes it off the Map page. Neither touches the workstream, its tabs,
    // or the stored cards and connections; a map taken off just stops being
    // read for turns (lib/tabmap.mjs mapsForTab) until it is back.
    if (parts[3] === 'map' && parts.length === 4 && (method === 'POST' || method === 'DELETE')) {
      task.mapOff = method === 'DELETE';
      saveTask(task);
      return send(res, 200, { task: taskForClient(task) });
    }
    // Section 27: the person undoes one of the orchestrator's roster writes.
    if (parts[3] === 'traffic' && parts.length === 6 && parts[5] === 'undo' && method === 'POST') {
      try { undoTraffic(task, parts[4]); } catch (error) { return send(res, error.status || 400, { error: error.message }); }
      return send(res, 200, { task: taskForClient(task) });
    }
    if (parts[3] === 'map' && parts[4] === 'cards' && parts.length === 6 && (method === 'PATCH' || method === 'DELETE')) {
      let rawKey = parts[5];
      try { rawKey = decodeURIComponent(rawKey); } catch {}
      const ref = parseCardKey(rawKey);
      if (!ref) return send(res, 400, { error: 'bad card' });
      const map = normalizeMap(task, getTask);
      const key = cardKey(ref.threadId, ref.tabId);
      if (method === 'DELETE') {
        if (!map.cards[key]) return send(res, 404, { error: 'no such card' });
        const own = ref.threadId === task.id;
        const taken = map.cards[key];
        delete map.cards[key];
        map.edges = map.edges.filter((edge) => refKey(edge.from) !== key && refKey(edge.to) !== key);
        task.map = mergeHidden(task, map);
        // A workstream's own tab stays a tab; off the map it is a hidden
        // card that Add tab lists and brings back.
        if (own) task.map.cards[key] = { ...cleanCard({ ...taken, hidden: true }), threadId: ref.threadId, tabId: ref.tabId };
        saveTask(task);
        const hiddenNow = hiddenOwnTabs(task).map((tab) => ({ id: tab.id, name: tab.name || 'Untitled' }));
        // The other workstream stops reading this map for its turns once
        // none of its tabs is here.
        if (!Object.values(map.cards).some((card) => card.threadId === ref.threadId)) {
          const other = getTask(ref.threadId);
          if (other && Array.isArray(other.mapMemberships) && other.mapMemberships.includes(task.id)) {
            other.mapMemberships = other.mapMemberships.filter((id) => id !== task.id);
            saveTask(other);
          }
        }
        return send(res, 200, { map: mapPublic(task, getTask), hiddenTabs: hiddenNow });
      }
      const body = await readBody(req);
      let card = map.cards[key];
      if (!card && ref.threadId === task.id && task.map?.cards?.[key]?.hidden) {
        // Board 10: an own tab taken off the map comes back as it was.
        card = { ...cleanCard({ ...task.map.cards[key], hidden: false }), threadId: ref.threadId, tabId: ref.tabId };
        delete card.hidden;
      }
      if (!card) {
        // Board 3: a tab dragged in from another workstream. Its workstream
        // remembers this map so the tab's turns read the card here.
        const other = ref.threadId === task.id ? task : getTask(ref.threadId);
        const tab = (other?.tabs || []).find((candidate) => candidate.id === ref.tabId && candidate.type !== 'duel');
        if (!other || !tab) return send(res, 404, { error: 'no such tab' });
        if (other.archived) return send(res, 409, { error: 'That workstream is archived.' });
        card = { ...cleanCard({}), threadId: ref.threadId, tabId: ref.tabId, addedAt: new Date().toISOString() };
        if (other.id !== task.id && !(other.mapMemberships || []).includes(task.id)) {
          other.mapMemberships = [...(other.mapMemberships || []), task.id];
          saveTask(other);
        }
      }
      const next = { ...card };
      if ('x' in body || 'y' in body) { next.x = body.x; next.y = body.y; }
      if ('minimized' in body) next.minimized = !!body.minimized;
      if ('description' in body) next.description = body.description;
      if ('tools' in body) next.tools = body.tools;
      if ('skill' in body) next.skill = body.skill;
      delete next.hidden;
      const merged = mergeHidden(task, map);
      delete merged.cards[key];
      merged.cards[key] = { ...cleanCard(next), threadId: ref.threadId, tabId: ref.tabId };
      task.map = merged;
      saveTask(task);
      return send(res, 200, { map: mapPublic(task, getTask), hiddenTabs: hiddenOwnTabs(task).map((tab) => ({ id: tab.id, name: tab.name || 'Untitled' })) });
    }
    if (parts[3] === 'map' && parts[4] === 'edges' && parts.length === 5 && method === 'POST') {
      const body = await readBody(req);
      const map = normalizeMap(task, getTask);
      const from = body.from?.threadId && body.from?.tabId ? { threadId: String(body.from.threadId), tabId: String(body.from.tabId) } : null;
      const to = body.to?.threadId && body.to?.tabId ? { threadId: String(body.to.threadId), tabId: String(body.to.tabId) } : null;
      if (!from || !to || !map.cards[refKey(from)] || !map.cards[refKey(to)]) return send(res, 404, { error: 'Both tabs need a card on this map.' });
      if (refKey(from) === refKey(to)) return send(res, 400, { error: 'A tab cannot hand over to itself.' });
      const words = String(body.words || '').trim().slice(0, MAP_WORDS_MAX);
      if (!words) return send(res, 400, { error: 'Say what hands over.' });
      const names = mapPublic(task, getTask);
      const rule = await makeMapRule({ words, fromName: names.cards[refKey(from)].name, toName: names.cards[refKey(to)].name });
      // The parse took a moment; a turn may have landed meanwhile. Write the
      // edge onto the workstream as it is now.
      const fresh = getTask(task.id) || task;
      const freshMap = normalizeMap(fresh, getTask);
      if (!freshMap.cards[refKey(from)] || !freshMap.cards[refKey(to)]) return send(res, 409, { error: 'One of those tabs left the map while the rule was being made.' });
      const now = new Date().toISOString();
      let edge = freshMap.edges.find((row) => refKey(row.from) === refKey(from) && refKey(row.to) === refKey(to));
      if (edge) { edge.words = words; edge.rule = rule; edge.updatedAt = now; }
      else { edge = { id: newId(), from, to, words, rule, createdAt: now, updatedAt: now }; freshMap.edges.push(edge); }
      fresh.map = mergeHidden(fresh, freshMap);
      saveTask(fresh);
      const publicMap = mapPublic(fresh, getTask);
      return send(res, 200, { map: publicMap, edge: publicMap.edges.find((row) => row.id === edge.id) || null });
    }
    if (parts[3] === 'map' && parts[4] === 'edges' && parts.length === 6 && (method === 'PATCH' || method === 'DELETE')) {
      const body = method === 'PATCH' ? await readBody(req) : {};
      const map = normalizeMap(task, getTask);
      const edge = map.edges.find((row) => row.id === parts[5]);
      if (!edge) return send(res, 404, { error: 'no such connection' });
      if (method === 'DELETE') {
        map.edges = map.edges.filter((row) => row.id !== edge.id);
        task.map = mergeHidden(task, map);
        saveTask(task);
        return send(res, 200, { map: mapPublic(task, getTask), edge: null });
      }
      // Board 5, "Say it differently": new words, a new parse, same edge.
      const words = String(body.words || '').trim().slice(0, MAP_WORDS_MAX);
      if (!words) return send(res, 400, { error: 'Say what hands over.' });
      const names = mapPublic(task, getTask);
      const rule = await makeMapRule({ words, fromName: names.cards[refKey(edge.from)]?.name || 'That tab', toName: names.cards[refKey(edge.to)]?.name || 'That tab' });
      const fresh = getTask(task.id) || task;
      const freshMap = normalizeMap(fresh, getTask);
      const target = freshMap.edges.find((row) => row.id === edge.id);
      if (!target) return send(res, 409, { error: 'That connection went away while the rule was being made.' });
      target.words = words;
      target.rule = rule;
      target.updatedAt = new Date().toISOString();
      fresh.map = mergeHidden(fresh, freshMap);
      saveTask(fresh);
      const publicMap = mapPublic(fresh, getTask);
      return send(res, 200, { map: publicMap, edge: publicMap.edges.find((row) => row.id === edge.id) || null });
    }

    if (parts[3] === 'tabs' && parts[5] === 'output-images' && parts.length === 7 && method === 'GET') {
      const tab = [...(task.tabs || []), ...(task.archivedTabs || [])].find((candidate) => candidate.id === parts[4]);
      const image = tab && await readOutputImage(tab, parts[6]);
      if (!image) return send(res, 404, { error: 'image unavailable on this computer' });
      res.writeHead(200, {
        'Content-Type': image.mimeType,
        'Content-Length': image.bytes.length,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(image.bytes);
    }

    // Pasted screenshots are private local artifacts. Only serve an id that is
    // actually referenced by this tab's persisted transcript or active run.
    if (parts[3] === 'tabs' && parts[5] === 'attachments' && parts.length === 7 && method === 'GET') {
      const tabId = parts[4];
      const attachmentId = parts[6];
      const tab = [...(task.tabs || []), ...(task.archivedTabs || [])].find((candidate) => candidate.id === tabId);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const candidates = [
        ...(tab.activeRun?.attachments || []),
        ...(tab.messages || []).flatMap((message) => message.attachments || []),
      ];
      const attachment = candidates.map(imageAttachmentRecord).find((candidate) => candidate?.id === attachmentId);
      const filePath = attachment && imageAttachmentPath(task.id, tab.id, attachment);
      if (!attachment || !filePath || !fs.existsSync(filePath)) return send(res, 404, { error: 'image unavailable on this computer' });
      const stat = fs.statSync(filePath);
      // Non-image files are served as downloads so an arbitrary type (HTML, SVG,
      // …) can never render inline in the app's own origin.
      const disposition = attachment.kind === 'file' ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': attachment.mimeType,
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename="${attachment.name.replace(/["\\]/g, '')}"`,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (parts.length === 3) {
      if (method === 'GET') {
        const active = [...runs.values()].filter((r) => r.taskId === id);
        return send(res, 200, { task: taskForClient(task), running: active.length > 0, runningTabs: active.map((r) => r.tabId).filter(Boolean) });
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        if ('title' in body) task.title = body.title;
        if (body.model) {
          if (!isSelectableModel(body.model)) return send(res, 400, { error: 'unknown model' });
          task.model = body.model;
        }
        if ('tools' in body) task.tools = body.tools;
        if ('connectors' in body) task.connectors = body.connectors;
        if ('archived' in body) {
          task.archived = !!body.archived;
          task.archivedAt = task.archived ? new Date().toISOString() : null;
        }
        if ('pinned' in body) task.pinned = !!body.pinned;
        if ('done' in body) {
          for (const tabRecord of task.tabs || []) {
            tabRecord.done = !!body.done;
            tabRecord.doneAt = tabRecord.done ? new Date().toISOString() : null;
            tabRecord.doneLine = tabRecord.done ? doneLineFor(tabRecord) : null;
          }
        }
        // The one fork at the end of the first task (Paper 14.10).
        if (['archived', 'repeat'].includes(body.signupFork)) task.signupFork = body.signupFork;
        if (Array.isArray(body.contextBlocks)) {
          task.contextBlocks = body.contextBlocks.slice(0, 100).map((block) => ({
            id: String(block.id || newId()),
            name: String(block.name || 'Context block').slice(0, 120),
            content: String(block.content || '').slice(0, 20000),
          }));
        }
        saveTask(task);
        return send(res, 200, { task: taskForClient(task) });
      }
      if (method === 'DELETE') {
        if (!task.archived) return send(res, 409, { error: 'archive the workstream before permanently deleting it' });
        if ([...runs.values()].some((run) => run.taskId === id)) {
          return send(res, 409, { error: 'that workstream is still running' });
        }
        try {
          await removeWorktree({ repo: task.repo, worktreePath: task.worktreePath, branch: task.branch });
        } catch {}
        removeTaskImageAttachments(id);
        deleteTask(id);
        return send(res, 200, { ok: true });
      }
    }

    // POST /api/tasks/:id/move {toRepo} -> the whole workstream moves into
    // another project. Tabs, transcripts, workspace and sessions come along
    // untouched, so the agent picks up where it was. Into a shared project it
    // is pushed to the cloud right away and the people in that project see it
    // on their next refresh. Out of a shared project is not offered yet: the
    // other Macs' copies would keep it, and the cloud row would put it back.
    if (parts[3] === 'move' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const requestedTarget = String(body.toRepo || '').replace(/^~/, os.homedir());
      const requested = listRepos().find((candidate) => candidate.path === requestedTarget) || null;
      if (!requested) return send(res, 400, { error: 'Choose a Supreme project first.' });
      const sameProject = task.projectId && requested.id ? task.projectId === requested.id : task.repo === requested.path;
      if (sameProject) return send(res, 400, { error: `${task.title} is already in ${requested.name}` });
      if ([...runs.values()].some((run) => run.taskId === id)) {
        return send(res, 409, { error: `${task.title} is still running — let it land first` });
      }
      if (team.isSharedTask(task)) {
        const others = (team.sharedInfo(task.projectId)?.members || []).filter((member) => !member.me && member.accepted).map((member) => member.name.split(' ')[0]);
        return send(res, 409, { error: `${task.title} is shared${others.length ? ` with ${andList(others)}` : ''}. Moving a shared workstream out isn’t possible yet.` });
      }
      // The record gets its stable id here if it never had one.
      const root = await localProjectRoot(requested, { portableFallback: true });
      if (!root) return send(res, 400, { error: `${requested.name} isn’t set up on this Mac yet.` });
      const target = listRepos().find((candidate) => (requested.id && candidate.id === requested.id) || candidate.path === requested.path) || requested;
      task.projectId = target.id;
      task.repo = target.path;
      task.repoName = target.name;
      if (team.isSharedTask(task)) team.stampCreatedBy(task);
      saveTask(task);
      let pushed = true;
      let warning = null;
      if (team.isSharedTask(task)) {
        try { await team.adoptThread(task); } catch (err) {
          pushed = false;
          warning = `${task.title} is in ${target.name}, but the cloud didn’t take it yet (${team.friendlyError(err)}). It goes up with its next change, or when Supreme restarts.`;
        }
      }
      return send(res, 200, { task: taskForClient(task), movedTo: target.path, shared: team.sharedInfo(target.id), pushed, warning });
    }

    // POST /api/tasks/:id/tabs  {model?, name?}  -> new tab, same context
    if (parts[3] === 'tabs' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);
      const modelId = await currentModelFresh(body.model || task.model);
      if (!isSelectableModel(modelId)) return send(res, 400, { error: 'unknown model' });
      const tab = makeTab({ name: body.name || 'New tab', model: modelId });
      task.tabs = task.tabs || [];
      task.tabs.push(tab);
      task.activeTab = tab.id;
      saveTask(task);
      // Freshen sibling summaries now so this tab's first run gets a briefing.
      for (const existing of task.tabs) {
        if (existing.id !== tab.id) scheduleTabSummary(task.id, existing.id);
      }
      return send(res, 200, { task: taskForClient(task), tab });
    }

    // POST /api/tasks/:id/tabs/:tabId/move  {toRepo}  -> move a tab into a new
    // thread in another project. The tab carries its transcript; because its
    // provider sessions were tied to the old worktree, they're reset so the
    // first run in the new home re-establishes context via a handoff prompt.
    if (parts[3] === 'tabs' && parts[5] === 'move' && method === 'POST') {
      const tab = getTab(task, parts[4]);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if (tab.type === 'duel' && tab.duel && !tab.duel.choice) {
        return send(res, 400, { error: 'choose a Duel winner before moving that conversation' });
      }
      if ([...runs.values()].some((r) => r.taskId === id && r.tabId === tab.id)) {
        return send(res, 400, { error: 'that tab is still running — cancel it first' });
      }
      const body = await readBody(req);

      // Drop onto an existing thread: the tab joins that thread as a new tab,
      // sharing its worktree/context. Sessions reset (bound to the old worktree).
      if (body.toThread) {
        const dest = getTask(body.toThread);
        if (!dest) return send(res, 404, { error: 'no such thread' });
        if (dest.id === id) return send(res, 400, { error: 'the tab is already in this thread' });
        const moved = makeTab({ name: tab.name, model: tab.model });
        moved.messages = tab.messages || [];
        copyTabImageAttachments({ fromTaskId: task.id, fromTabId: tab.id, toTaskId: dest.id, toTabId: moved.id, messages: moved.messages });
        moved.handoffs = tab.handoffs || [];
        if (tab.duel && tab.duel.choice) moved.duel = tab.duel;
        if (tab.duels?.length) moved.duels = tab.duels;
        moved.status = tab.status === 'running' ? 'idle' : tab.status || 'idle';
        dest.tabs = dest.tabs || [];
        dest.tabs.push(moved);
        dest.activeTab = moved.id;
        if (dest.archived) dest.archived = false;
        saveTask(dest);
        // Section 29: a scheduled task follows its tab.
        scheduled.retarget({ threadId: id, tabId: tab.id }, { threadId: dest.id, tabId: moved.id });
        const src2 = getTask(id);
        src2.tabs = (src2.tabs || []).filter((t) => t.id !== tab.id);
        tombstoneTab(src2, tab.id);
        removeTabImageAttachments(id, tab.id);
        if (src2.tabs.length === 0) src2.archived = true;
        else if (src2.activeTab === tab.id) src2.activeTab = src2.tabs[0].id;
        saveTask(src2);
        return send(res, 200, { task: taskForClient(dest), movedTo: dest.id, tabId: moved.id, sourceArchived: !!src2.archived });
      }

      const requestedTarget = String(body.toRepo || '').replace(/^~/, os.homedir());
      const targetProject = listRepos().find((candidate) => candidate.path === requestedTarget) || null;
      const root = targetProject
        ? await localProjectRoot(targetProject, { portableFallback: true })
        : await repoRoot(requestedTarget);
      if (!root) return send(res, 400, { error: 'Choose a Supreme project first.' });
      const title = tab.name || 'Moved tab';
      const nid = newId();
      let wt;
      try {
        wt = await createWorktree({ repo: root, title, base: body.base, id: nid });
      } catch (e) {
        return send(res, 400, { error: `could not create worktree: ${e.message}` });
      }
      const repoName = targetProject?.name || path.basename(root);
      const newTask = createTask({
        id: nid, title, projectId: targetProject?.id, repo: targetProject?.path || root, repoName, base: wt.base, branch: wt.branch,
        worktreePath: wt.worktreePath, model: tab.model, tools: task.tools,
        tabName: tab.name, connectors: task.connectors,
      });
      const nt = newTask.tabs[0];
      nt.messages = tab.messages || [];
      copyTabImageAttachments({ fromTaskId: task.id, fromTabId: tab.id, toTaskId: newTask.id, toTabId: nt.id, messages: nt.messages });
      nt.handoffs = tab.handoffs || [];
      if (tab.duel && tab.duel.choice) nt.duel = tab.duel;
      if (tab.duels?.length) nt.duels = tab.duels;
      nt.sessions = {}; // reset: old sessions were bound to the old worktree
      nt.model = tab.model;
      nt.status = tab.status === 'running' ? 'idle' : tab.status || 'idle';
      saveTask(newTask);
      scheduled.retarget({ threadId: id, tabId: tab.id }, { threadId: newTask.id, tabId: nt.id });
      // remove the tab from the source thread; archive the thread if now empty
      const src = getTask(id);
      src.tabs = (src.tabs || []).filter((t) => t.id !== tab.id);
      tombstoneTab(src, tab.id);
      removeTabImageAttachments(id, tab.id);
      if (src.tabs.length === 0) src.archived = true;
      else if (src.activeTab === tab.id) src.activeTab = src.tabs[0].id;
      saveTask(src);
      return send(res, 200, { task: taskForClient(newTask), movedTo: newTask.id, sourceArchived: !!src.archived });
    }

    // DELETE /api/tasks/:id/tabs/:tabId -> soft-archive a tab. Its full
    // transcript and provider state remain recoverable in archivedTabs.
    if (parts[3] === 'tabs' && parts[5] === 'permanent' && parts.length === 6 && method === 'DELETE') {
      const archivedTabs = task.archivedTabs || [];
      const index = archivedTabs.findIndex((candidate) => candidate.id === parts[4]);
      if (index < 0) return send(res, 404, { error: 'no such archived tab' });
      const [deleted] = archivedTabs.splice(index, 1);
      task.archivedTabs = archivedTabs;
      tombstoneTab(task, deleted.id);
      removeTabImageAttachments(id, deleted.id);
      saveTask(task);
      return send(res, 200, { task: taskForClient(task), deletedTabId: deleted.id });
    }

    if (parts[3] === 'tabs' && parts.length === 5 && method === 'DELETE') {
      const tabs = task.tabs || [];
      const tab = tabs.find((candidate) => candidate.id === parts[4]);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if (tabs.length <= 1) return send(res, 400, { error: 'a thread needs at least one active tab — archive the thread instead' });
      if ([...runs.values()].some((r) => r.taskId === id && r.tabId === tab.id)) {
        return send(res, 400, { error: 'that tab is still running — cancel it first' });
      }
      if (emptyTab(tab)) {
        task.tabs = tabs.filter((candidate) => candidate.id !== tab.id);
        if (task.activeTab === tab.id) task.activeTab = task.tabs[0].id;
        tombstoneTab(task, tab.id);
        removeTabImageAttachments(id, tab.id);
        saveTask(task);
        return send(res, 200, { task: taskForClient(task), deletedTabId: tab.id });
      }
      const archived = {
        ...tab,
        archivedAt: new Date().toISOString(),
        archivedIndex: tabs.findIndex((candidate) => candidate.id === tab.id),
      };
      task.tabs = tabs.filter((candidate) => candidate.id !== tab.id);
      task.archivedTabs = [...(task.archivedTabs || []), archived];
      if (task.activeTab === tab.id) task.activeTab = task.tabs[0].id;
      saveTask(task);
      return send(res, 200, { task: taskForClient(task), archivedTabId: tab.id });
    }

    // POST /api/tasks/:id/tabs/:tabId/restore -> return an archived tab to its
    // original position and make it active.
    if (parts[3] === 'tabs' && parts[5] === 'restore' && method === 'POST') {
      const archivedTabs = task.archivedTabs || [];
      const index = archivedTabs.findIndex((candidate) => candidate.id === parts[4]);
      if (index < 0) {
        // Already live (restored from another window, a teammate, or the
        // cloud copy while this one still showed it archived): nothing to
        // do, and nothing to complain about.
        const live = (task.tabs || []).find((candidate) => candidate.id === parts[4]);
        if (live) return send(res, 200, { task: taskForClient(task), restoredTabId: live.id, alreadyLive: true });
        return send(res, 404, { error: 'no such archived tab' });
      }
      const [tab] = archivedTabs.splice(index, 1);
      const restoreAt = Math.max(0, Math.min(Number(tab.archivedIndex) || 0, (task.tabs || []).length));
      delete tab.archivedAt;
      delete tab.archivedIndex;
      task.tabs = task.tabs || [];
      task.tabs.splice(restoreAt, 0, tab);
      task.archivedTabs = archivedTabs;
      task.activeTab = tab.id;
      task.archived = false;
      saveTask(task);
      return send(res, 200, { task: taskForClient(task), restoredTabId: tab.id });
    }

    // PATCH /api/tasks/:id/tabs/:tabId  {name?, model?, active?}
    if (parts[3] === 'tabs' && parts.length === 5 && method === 'PATCH') {
      const body = await readBody(req);
      const tab = getTab(task, parts[4]);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if ('name' in body) tab.name = body.name;
      if ('type' in body) {
        if (tab.type === 'duel') return send(res, 400, { error: 'A Duel tab keeps its type.' });
        // An orchestrator is its maker's own and never shared (team.mjs).
        if (body.type === 'orchestrator') {
          tab.type = 'orchestrator';
          task.mapOff = false;
          const mine = team.me()?.id;
          if (mine) tab.privateTo = mine;
        } else { delete tab.type; delete tab.privateTo; }
      }
      // Paper 20, tab level: Done is the bookend on this tab. Marking it
      // stamps the day and a one-line result for the tray; Bring back clears
      // both.
      if ('done' in body) {
        tab.done = !!body.done;
        tab.doneAt = tab.done ? new Date().toISOString() : null;
        tab.doneLine = tab.done ? doneLineFor(tab) : null;
        // The done tab collapses into the day's tray, so the active spot
        // moves to a live sibling when there is one.
        if (tab.done && task.activeTab === tab.id) {
          const nextLive = (task.tabs || []).find((candidate) => candidate.id !== tab.id && !candidate.done);
          if (nextLive) task.activeTab = nextLive.id;
        }
      }
      if (body.model) {
        if (tab.type === 'duel' && tab.duel && !tab.duel.choice) {
          return send(res, 400, { error: 'Duel contender models stay locked until you pick a winner' });
        }
        if (!isSelectableModel(body.model)) return send(res, 400, { error: 'unknown model' });
        tab.model = body.model;
      }
      if (body.active) task.activeTab = tab.id;
      saveTask(task);
      const clientTask = taskForClient(task);
      return send(res, 200, { task: clientTask, tab: getTab(clientTask, tab.id) });
    }

    // POST /api/tasks/:id/tabs/:tabId/compact — "Sum up older messages" from
    // the context meter. Refreshes the tab's rolling summary, records which
    // turns fold into it, and drops provider sessions so the next turn replays
    // summary + recent tail instead of resuming with the full history. The
    // saved transcript is untouched: nothing is deleted.
    // Auto-contextualize: the unfold is dropping the record. Only the latest
    // fold can go; the one before it, if any, is the projection again.
    if (parts[3] === 'tabs' && parts[5] === 'folds' && parts[6] && parts.length === 7 && method === 'DELETE') {
      const tab = (task.tabs || []).find((candidate) => candidate.id === parts[4]) || null;
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if (tabIsRunning(task, tab)) return send(res, 409, { error: 'Wait for the current run to finish, then bring the messages back.' });
      const folds = Array.isArray(tab.folds) ? tab.folds : [];
      const last = folds[folds.length - 1];
      if (!last || last.id !== parts[6]) return send(res, 409, { error: 'Only the latest fold can be undone.' });
      tab.folds = folds.slice(0, -1);
      const previous = activeFold(tab);
      if (previous) tab.compaction = { msgCount: (tab.messages || []).length, keptFrom: previous.keptFrom, elided: previous.keptFrom, at: previous.at, foldId: previous.id };
      else delete tab.compaction;
      tab.sessions = {};
      saveTask(task);
      console.info(`[fold] thread=${task.id} tab=${tab.id} unfolded ${last.id}: ${last.count} messages back in the window`);
      return send(res, 200, { task: taskForClient(task), unfolded: { id: last.id, count: last.count } });
    }
    if (parts[3] === 'tabs' && parts[5] === 'compact' && parts.length === 6 && method === 'POST') {
      // getTab falls back to the first tab; a sum-up must never land elsewhere.
      const tab = (task.tabs || []).find((candidate) => candidate.id === parts[4]) || null;
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const live = tab.status === 'running' || [...runs.values()].some((run) => run.taskId === task.id && run.tabId === tab.id);
      if (live) return send(res, 409, { error: 'Wait for the current run to finish, then sum up.' });
      if (!(tab.messages || []).length) return send(res, 400, { error: 'Nothing to sum up yet.' });
      // The manual fold is the same fold the tab now does on its own, plus
      // the briefing's rolling summary refreshed for the siblings. Nothing is
      // lost: the transcript stays saved, and naming a set-aside connector in
      // a message brings it back (mcpTrimForTab).
      await generateTabSummary(task.id, tab.id);
      const fold = await foldTab(task.id, tab.id, 'manual');
      const fresh = getTask(task.id);
      const ftab = fresh ? getTab(fresh, tab.id) : null;
      if (!ftab) return send(res, 404, { error: 'no such tab' });
      const aside = setAsideUnusedConnectors(fresh, ftab);
      const setAside = aside.count;
      const last = (ftab.folds || [])[(ftab.folds || []).length - 1];
      if (fold && last?.id === fold.id) last.setAside = aside.names;
      if (!fold && !setAside) {
        return send(res, 200, { task: taskForClient(fresh), compaction: null, scope: null, message: 'This tab is short enough to keep every message.' });
      }
      if (setAside) ftab.sessions = {};
      saveTask(fresh);
      console.info(`[compact] thread=${fresh.id} tab=${ftab.id} folded=${fold ? fold.foldedNow : 0} setAside=${setAside}`);
      return send(res, 200, {
        task: taskForClient(fresh),
        compaction: fold ? ftab.compaction : null,
        scope: setAside ? { kept: (ftab.connectorScope?.keys || []).length, setAside } : null,
      });
    }

    // POST /api/tasks/:id/tabs/:tabId/cancel — stable, tab-scoped stop used by
    // the composer and Escape key. It covers both ordinary runs and Duels.
    if (parts[3] === 'tabs' && ['pause', 'resume'].includes(parts[5]) && method === 'POST') {
      const tabId = parts[4];
      if (!(task.tabs || []).some((candidate) => candidate.id === tabId)) {
        return send(res, 404, { error: 'no such tab' });
      }
      const run = [...runs.values()].find((candidate) => candidate.taskId === id && candidate.tabId === tabId);
      if (!run) return send(res, 409, { error: 'that response is no longer running' });
      const activity = computerPublic(run);
      if (!activity) return send(res, 409, { error: 'computer control has not started in this response' });
      const wantsPause = parts[5] === 'pause';
      if (wantsPause === !!run.paused) return send(res, 200, { ok: true, run: runPublic(run) });
      const changed = wantsPause ? run.control?.pause?.() : run.control?.resume?.();
      if (!changed) return send(res, 409, { error: wantsPause ? 'this provider cannot be paused right now' : 'this provider cannot be resumed right now' });
      run.paused = wantsPause;
      recordRunEvent(run.id, {
        type: 'computer',
        phase: wantsPause ? 'paused' : 'resumed',
        surface: activity.surface,
        app: activity.app,
        step: wantsPause ? 'Waiting for you' : 'Resumed browser control',
      });
      return send(res, 200, { ok: true, run: runPublic(run) });
    }

    if (parts[3] === 'tabs' && parts[5] === 'note' && parts.length === 6 && method === 'POST') {
      const tab = getTab(task, parts[4]);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim().slice(0, 4_000);
      const mentions = (Array.isArray(body.mentions) ? body.mentions : [])
        .filter((row) => row && row.email)
        .map((row) => ({ email: String(row.email), name: String(row.name || '') }))
        .slice(0, 12);
      if (!prompt) return send(res, 400, { error: 'empty message' });
      if (!mentions.length) return send(res, 400, { error: 'Pick who this is for with @.' });
      const pings = (await notifySlackMentions({ task, tab, prompt, body: { mentions }, note: true })) || [];
      const ts = new Date().toISOString();
      const message = {
        role: 'user',
        content: prompt,
        mentions,
        pings,
        note: true,
        ...(team.isSharedTask(task) && team.me() ? { author: { id: team.me().id, name: team.me().name } } : {}),
        ts,
      };
      const fresh = getTask(id) || task;
      const ftab = getTab(fresh, tab.id) || tab;
      ftab.messages = [...(ftab.messages || []), message];
      for (const session of Object.values(ftab.sessions || {})) {
        if (session && Number.isFinite(session.msgCount)) session.msgCount += 1;
      }
      fresh.lastActivity = ts;
      saveTask(fresh);
      return send(res, 200, { message, pings, task: taskForClient(fresh) });
    }

    if (parts[3] === 'tabs' && parts[5] === 'steer' && method === 'POST') {
      const tabId = parts[4];
      const tab = getTab(task, tabId);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const run = [...runs.values()].find((candidate) => candidate.taskId === id && candidate.tabId === tabId);
      if (!run) return send(res, 409, { error: 'that response is no longer running', queue: true });
      const body = await readBody(req);
      if (body.runId && body.runId !== run.id) return send(res, 409, { error: 'the response has changed', queue: true });
      // The exact Slack thread may include another authorized participant.
      // Prove their real Slack message and current project access before they
      // can join a live run. A claimed author alone never grants access.
      let slackFrom = null;
      if (body.slack) {
        slackFrom = await authorizeSlackThreadSteer({ source: run.slackFrom, claimed: body.slack, task,
          readRequest: slackMessageFromSlack, mayUse: async (user, target) => slackMayUse(await slackScopeFor(user), target), userName: slackUserName });
        if (!slackFrom) return send(res, 409, { error: 'this message belongs to a different response', queue: true });
      }
      const requestId = operationId(body.requestId) || newId();
      const existing = (run.steers || []).find((steer) => steer.id === requestId);
      if (existing) {
        return send(res, 200, { ok: true, replayed: true, steer: publicRunSteers({ ...run, steers: [existing] })[0] });
      }
      if (run.acceptingSteers === false || typeof run.control?.steer !== 'function') {
        return send(res, 409, { error: 'this model will take that message in its next response', queue: true });
      }
      const batch = orderedPromptBatch(task, Array.isArray(body.prompts) ? body.prompts : body.prompt, Array.isArray(body.contextMentions) ? body.contextMentions : []);
      const { prompts, prompt, modelPrompt: baseModelPrompt } = batch;
      if (!prompts.length) return send(res, 400, { error: 'empty prompt' });
      // Paper 21.2b: the chips that rode this send, sanitized once, same as
      // a first message. They ride the steer record so the landed transcript
      // keeps them, and the ping's fate lands on the steer (below).
      const sentMentions = (Array.isArray(body.mentions) ? body.mentions : [])
        .filter((row) => row && row.email)
        .map((row) => ({ email: String(row.email), name: String(row.name || '') }))
        .slice(0, 12);
      const sentContextRefs = (Array.isArray(body.contextMentions) ? body.contextMentions : [])
        .map((name) => String(name || '').trim()).filter(Boolean).slice(0, 12);
      for (const token of Array.isArray(body.tokens) ? body.tokens : []) {
        if (token?.type === 'time') return send(res, 400, { error: 'A time in the composer does not schedule yet. That message would have run right now instead of later, so nothing was sent. New task under Scheduled does it.' });
        if (token?.type === 'person') return send(res, 400, { error: 'Handing to a person is not built yet. Hand to one of their tabs, or send it in the thread.' });
      }
      let handoffFrom = null;
      if (body.handoffFrom && typeof body.handoffFrom === 'object' && body.handoffFrom.tabId) {
        handoffFrom = resolveHandoffSource(task, tab, body.handoffFrom);
        // A claimed queue replay re-enters this route; the edge was already
        // written at the original send.
        if (handoffFrom && !body.queueId) writeHandoffEdge();
      }
      function writeHandoffEdge() { writeTabHandoffEdge(task, tab, handoffFrom); }
      // Same restriction the run endpoint enforces — a steer must not smuggle
      // shared terminal context into an OpenRouter run.
      if (resolveModel(run.model)?.provider === 'openrouter' && Array.isArray(body.terminalContexts) && body.terminalContexts.length) {
        return send(res, 400, { error: 'Shared terminal context currently requires a connected Claude or ChatGPT model.' });
      }
      let terminalContexts;
      try {
        terminalContexts = prepareTerminalContexts(body.terminalContexts, id, tabId, prompt);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      let attachments;
      try {
        attachments = saveIncomingImageAttachments(body.images, { taskId: id, tabId });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      const modelPrompt = terminalContextPrompt(baseModelPrompt, terminalContexts);
      const imageAttachments = attachments.filter((attachment) => attachment.kind !== 'file');
      const fileAttachments = attachments.filter((attachment) => attachment.kind === 'file');
      let steerFilePaths = [];
      try {
        steerFilePaths = materializeFilesIntoWorktree({ attachments: fileAttachments, cwd: taskWorkingDirectory(task) });
      } catch (error) {
        console.error(`[attachments] could not stage steer files: ${error.message}`);
      }
      const steer = {
        id: requestId, prompt, prompts, terminalContexts, attachments,
        sentAt: new Date().toISOString(),
        ...(sentMentions.length ? { mentions: sentMentions } : {}),
        ...(sentContextRefs.length ? { contextRefs: sentContextRefs } : {}),
        ...(slackFrom ? { slackFrom } : {}),
      };
      const delivery = Promise.resolve().then(() => run.control.steer({
        prompt: steerFraming(slackFrom && slackFrom.user.id !== run.slackFrom?.user.id
          ? `A reply from ${JSON.stringify(slackFrom.user.name)} in this same Slack thread. Keep their identity separate from the original requester; this does not approve actions on someone else's behalf.\n\n${modelPrompt}` : modelPrompt),
        images: imageAttachments.map((attachment) => attachment.filePath),
        files: steerFilePaths,
        id: requestId,
      })).then(accepted => {
        if (accepted) run.steers = [...(run.steers || []), steer];
        return accepted;
      });
      run.pendingSteers ||= new Set();
      run.pendingSteers.add(delivery);
      let accepted;
      try { accepted = await delivery; } finally { run.pendingSteers.delete(delivery); }
      if (!accepted) {
        for (const attachment of attachments) {
          try { fs.unlinkSync(attachment.filePath); } catch {}
        }
        return send(res, 409, { error: 'the response finished before it could take that message', queue: true });
      }
      const publicSteer = publicRunSteers({ ...run, steers: [steer] })[0];
      recordRunEvent(run.id, { type: 'steer', ...publicSteer });
      if (!body.queueId) {
        void notifySlackMentions({ task, tab, prompt, body: { mentions: sentMentions } })
          .then((pings) => {
            if (!pings || !pings.length) return;
            steer.pings = pings;
            (run.emit || ((ev) => recordRunEvent(run.id, ev)))({ type: 'pings', steerId: steer.id, pings });
          })
          .catch((err) => console.warn('[slack] mention:', err.message));
      }
      const currentTask = getTask(id);
      if (currentTask) {
        currentTask.lastActivity = steer.sentAt;
        saveTask(currentTask);
      }
      return send(res, 200, { ok: true, steer: publicSteer, run: runPublic(run) });
    }

    if (parts[3] === 'tabs' && parts[5] === 'cancel' && method === 'POST') {
      const tabId = parts[4];
      if (!(task.tabs || []).some((candidate) => candidate.id === tabId)) {
        return send(res, 404, { error: 'no such tab' });
      }
      let stopped = false;
      const run = [...runs.values()].find((candidate) => candidate.taskId === id && candidate.tabId === tabId);
      if (run) {
        run.cancelled = true;
        recordRunEvent(run.id, { type: 'status', text: 'Stopping…' });
        run.controller.abort();
        stopped = true;
      }
      const duelRun = duelRuns.get(`${id}::${tabId}`);
      if (duelRun) {
        duelRun.controller.abort();
        stopped = true;
      }
      // Idempotent by design: a run can finish between the click and this call.
      return send(res, 200, { ok: true, stopped });
    }

    // POST /api/tasks/:id/duel
    //   {setup:true, sourceTabId?, effort?} -> create a dedicated Duel tab
    //   {prompt, tabId, effort?}            -> run both hidden contenders
    if (parts[3] === 'duel' && parts.length === 4 && method === 'POST') {
      const body = await readBody(req);

      if (body.setup) {
        const setupRequestId = operationId(body.requestId);
        const existing = setupRequestId && (task.tabs || []).find((candidate) => (
          candidate.type === 'duel' && candidate.duel?.setupRequestId === setupRequestId
        ));
        if (existing) {
          task.activeTab = existing.id;
          console.info(`[duel] setup replay thread=${id} tab=${existing.id}`);
          return send(res, 200, { task: taskForClient(task), duelTabId: existing.id, replayed: true });
        }
        const source = getTab(task, body.sourceTabId || task.activeTab);
        if (!source) return send(res, 404, { error: 'no source tab for this duel' });
        // Contenders are allocated only after the user chooses effort and
        // clicks Lock it in. Until then this is just an empty Duel shell.
        const duelTab = makeTab({ name: 'Duel', model: 'contenders' });
        duelTab.type = 'duel';
        duelTab.duel = {
          duelId: newId(),
          ...(setupRequestId ? { setupRequestId } : {}),
          sourceTabId: source.id,
          phase: 'setup',
          effort: 'High',
          prompt: null,
          a: null,
          b: null,
          choice: null,
        };
        task.tabs = task.tabs || [];
        task.tabs.push(duelTab);
        task.activeTab = duelTab.id;
        saveTask(task);
        console.info(`[duel] setup thread=${id} tab=${duelTab.id} source=${source.id}`);
        return send(res, 200, { task: taskForClient(task), duelTabId: duelTab.id });
      }

      const prompt = (body.prompt || '').toString().trim();
      if (!prompt) return send(res, 400, { error: 'empty prompt' });
      const runRequestId = operationId(body.requestId);
      const duelTab = getTab(task, body.tabId || task.activeTab);
      if (!duelTab || duelTab.type !== 'duel' || !duelTab.duel) {
        return send(res, 404, { error: 'no such Duel tab' });
      }
      const phase = duelTab.duel.phase || (duelTab.duel.a && duelTab.duel.b ? 'results' : 'setup');
      if (runRequestId && duelTab.duel.runRequestId === runRequestId) {
        if (phase === 'running') {
          console.info(`[duel] run replay still-running thread=${id} tab=${duelTab.id}`);
          return send(res, 202, { task: taskForClient(task), duelTabId: duelTab.id, running: true, replayed: true });
        }
        if (phase === 'results') {
          console.info(`[duel] run replay completed thread=${id} tab=${duelTab.id}`);
          return send(res, 200, { task: taskForClient(task), duelTabId: duelTab.id, replayed: true });
        }
      }
      if (phase !== 'ready') return send(res, 400, { error: 'lock in the Duel before giving it a task' });
      const models = (duelTab.duel.models || []).map(resolveModel).filter(Boolean);
      if (models.length !== 2 || models[0].id === models[1].id) {
        return send(res, 400, { error: 'the Duel does not have two valid contenders' });
      }
      const source = getTab(task, duelTab.duel.sourceTabId) || duelTab;
      const priorCount = (source.messages || []).length;
      // A Duel compares proposed outputs; it must never execute the same email,
      // browser action, file mutation, or other side effect twice. Both models
      // get identical read-only context. The chosen winner returns to the
      // thread's normal tool/connector permissions on subsequent turns.
      const base = {
        cwd: taskWorkingDirectory(task),
        tools: task.tools === 'off' ? 'off' : 'safe',
        connectors: false,
        messages: source.messages || [],
      };
      const comparisonPrompt = [
        'You are participating in a blind comparison. Produce the requested draft or proposed deliverable only.',
        'Do not send, publish, edit external systems, change files, commit code, or take any other side effect. You may inspect the supplied context and use read-only research tools.',
        '',
        'User task:',
        promptWithContextBlocks(task, prompt),
      ].join('\n');
      const effort = ['Low', 'Medium', 'High', 'Extra high', 'Maximum'].includes(body.effort)
        ? body.effort
        : duelTab.duel.effort || 'High';

      duelTab.duel.phase = 'running';
      duelTab.duel.prompt = prompt;
      if (runRequestId) duelTab.duel.runRequestId = runRequestId;
      duelTab.status = 'running';
      task.status = 'running';
      task.lastActivity = new Date().toISOString();
      saveTask(task);

      const duelRunKey = `${id}::${duelTab.id}`;
      const controller = new AbortController();
      duelRuns.set(duelRunKey, { controller, taskId: id, tabId: duelTab.id });
      console.info(`[duel] run start thread=${id} tab=${duelTab.id} effort=${effort}`);

      const runOne = async (m) => {
        const started = Date.now();
        let t = '';
        try {
          const r = await runModel({ thread: { ...base, sessions: {} }, model: m, prompt: comparisonPrompt, priorCount, effort, signal: controller.signal }, (ev) => { if (ev.type === 'delta') t += ev.text || ''; });
          // An "ok" run with nothing to show is not a pickable answer; treat it
          // as a failure so the winner buttons never offer an empty draft.
          const answer = (r.text || t || '').trim();
          return { model: m.id, text: answer || (r.stopped ? '' : 'No output returned.'), ok: !!r.ok && !!answer, stopped: !!r.stopped, durationMs: Date.now() - started };
        } catch (e) {
          console.error(`[duel] contender failed thread=${id} tab=${duelTab.id} model=${m.id} error=${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 500)}`);
          return { model: m.id, text: e.message || 'The contender failed to return an answer.', ok: false, durationMs: Date.now() - started };
        }
      };
      let ra, rb;
      try {
        [ra, rb] = await Promise.all([runOne(models[0]), runOne(models[1])]);
      } finally {
        duelRuns.delete(duelRunKey);
      }
      const ts = new Date().toISOString();
      const fresh = getTask(id);
      const freshDuel = (fresh.tabs || []).find((tb) => tb.id === duelTab.id);
      if (!freshDuel || !freshDuel.duel) return send(res, 409, { error: 'the Duel tab was closed while it was running' });
      if (controller.signal.aborted) {
        freshDuel.duel = {
          ...freshDuel.duel,
          phase: 'ready',
          prompt: null,
          a: null,
          b: null,
          choice: null,
          runRequestId: null,
        };
        freshDuel.status = 'idle';
        fresh.status = (fresh.tabs || []).some((tb) => tb.status === 'running') ? 'running' : 'done';
        fresh.lastActivity = ts;
        saveTask(fresh);
        return send(res, 200, { task: taskForClient(fresh), duelTabId: freshDuel.id, stopped: true });
      }
      const swap = Math.random() < 0.5;
      const A = swap ? rb : ra;
      const B = swap ? ra : rb;
      freshDuel.duel = {
        ...freshDuel.duel,
        phase: 'results',
        effort,
        prompt,
        a: A,
        b: B,
        choice: null,
        completedAt: ts,
      };
      freshDuel.status = ra.ok || rb.ok ? 'done' : 'error';
      fresh.activeTab = freshDuel.id;
      fresh.status = (fresh.tabs || []).some((tb) => tb.status === 'running') ? 'running' : freshDuel.status;
      fresh.lastActivity = ts;
      saveTask(fresh);
      for (const contenderResult of [ra, rb]) {
        const contender = resolveModel(contenderResult.model);
        if (!contender) continue;
        if (contenderResult.ok) clearAccountNotices(contender);
        else recordAccountNotice(contender, contenderResult.text);
      }
      appendEval({ kind: 'duel', duelId: freshDuel.duel.duelId, threadId: id, tabId: freshDuel.id, prompt, effort, aModel: A.model, bModel: B.model, aOk: A.ok, bOk: B.ok });
      console.info(`[duel] run complete thread=${id} tab=${freshDuel.id} a=${A.ok ? 'ok' : 'failed'} b=${B.ok ? 'ok' : 'failed'}`);
      return send(res, 200, { task: taskForClient(fresh), duelTabId: freshDuel.id });
    }

    // The two-second ramp animation happens in the client; this endpoint makes
    // the ready state durable so refresh/back does not break the workflow.
    if (parts[3] === 'duel' && parts[5] === 'lock' && method === 'POST') {
      const body = await readBody(req);
      const fresh = getTask(id);
      const dtab = (fresh.tabs || []).find((tb) => tb.type === 'duel' && tb.duel && tb.duel.duelId === parts[4]);
      if (!dtab) return send(res, 404, { error: 'no such duel' });
      if (dtab.duel.choice) return send(res, 400, { error: 'this Duel has already been decided' });
      const phase = dtab.duel.phase || 'setup';
      if (phase === 'ready') return send(res, 200, { task: taskForClient(fresh) });
      if (phase !== 'setup') return send(res, 400, { error: 'this Duel can no longer be locked' });
      if (['Low', 'Medium', 'High', 'Extra high', 'Maximum'].includes(body.effort)) dtab.duel.effort = body.effort;
      const source = getTab(fresh, dtab.duel.sourceTabId);
      if (!source) return send(res, 404, { error: 'the source tab for this Duel no longer exists' });
      const models = defaultDuelModels(source.model || fresh.model);
      if (models.length !== 2 || models[0].id === models[1].id) {
        return send(res, 409, { error: 'A Duel needs two models this account can run. Connect a second model on the Models page, then try again.' });
      }
      dtab.duel.models = models.map((model) => model.id);
      dtab.duel.phase = 'ready';
      dtab.duel.rampedAt = new Date().toISOString();
      saveTask(fresh);
      return send(res, 200, { task: taskForClient(fresh) });
    }

    // POST /api/tasks/:id/duel/:duelId/retry — a finished, undecided Duel goes
    // back to ready with a freshly availability-checked pair, so failed
    // contenders are a bump in the road instead of a dead end.
    if (parts[3] === 'duel' && parts[5] === 'retry' && method === 'POST') {
      const fresh = getTask(id);
      const dtab = (fresh.tabs || []).find((tb) => tb.type === 'duel' && tb.duel && tb.duel.duelId === parts[4]);
      if (!dtab) return send(res, 404, { error: 'no such duel' });
      if (dtab.duel.choice) return send(res, 400, { error: 'this Duel has already been decided' });
      if (dtab.duel.phase !== 'results') return send(res, 400, { error: 'only a finished Duel can be retried' });
      const source = getTab(fresh, dtab.duel.sourceTabId);
      const models = defaultDuelModels(source?.model || fresh.model);
      if (models.length !== 2 || models[0].id === models[1].id) {
        return send(res, 409, { error: 'A Duel needs two models this account can run. Connect a second model on the Models page, then try again.' });
      }
      const lastPrompt = dtab.duel.prompt || null;
      dtab.duel = {
        ...dtab.duel,
        phase: 'ready',
        prompt: null,
        a: null,
        b: null,
        choice: null,
        runRequestId: null,
        models: models.map((model) => model.id),
        rampedAt: new Date().toISOString(),
      };
      dtab.status = 'idle';
      fresh.status = (fresh.tabs || []).some((tb) => tb.status === 'running') ? 'running' : 'done';
      fresh.lastActivity = new Date().toISOString();
      saveTask(fresh);
      return send(res, 200, { task: taskForClient(fresh), duelTabId: dtab.id, lastPrompt });
    }

    // POST /api/tasks/:id/duel/:duelId/pick  {choice:'a'|'b'}
    if (parts[3] === 'duel' && parts[5] === 'pick' && method === 'POST') {
      const duelId = parts[4];
      const body = await readBody(req);
      const choice = ['a', 'b'].includes(body.choice) ? body.choice : null;
      if (!choice) return send(res, 400, { error: 'choice must be a or b' });
      const fresh = getTask(id);
      const dtab = (fresh.tabs || []).find((tb) => tb.duel && tb.duel.duelId === duelId);
      if (!dtab) {
        const source = (fresh.tabs || []).find((tb) => (tb.duels || []).some((duel) => duel.duelId === duelId));
        if (source) return send(res, 200, { task: taskForClient(fresh), sourceTabId: source.id, duelId });
        return send(res, 404, { error: 'no such duel' });
      }
      if (dtab.duel.choice) {
        const sourceTabId = dtab.duel.sourceTabId;
        if (dtab.type === 'duel' && settlePickedDuelTab(fresh, dtab)) saveTask(fresh);
        return send(res, 200, { task: taskForClient(fresh), sourceTabId, duelTabId: dtab.id, duelId });
      }
      if (!dtab.duel.a || !dtab.duel.b) return send(res, 400, { error: 'this Duel has no results yet' });
      const source = (fresh.tabs || []).find((tb) => tb.id === dtab.duel.sourceTabId && tb.id !== dtab.id);
      if (!source) return send(res, 409, { error: 'the source tab for this Duel no longer exists' });
      dtab.duel.choice = choice;
      const aModel = dtab.duel.a.model, bModel = dtab.duel.b.model;
      const winner = choice === 'a' ? aModel : bModel;
      const selected = choice === 'a' ? dtab.duel.a : dtab.duel.b;
      dtab.duel.phase = 'picked';
      dtab.duel.winnerSide = choice;
      dtab.duel.pickedAt = new Date().toISOString();
      dtab.model = selected.model;
      dtab.status = selected.ok === false ? 'error' : 'done';
      const sourceTabId = source.id;
      if (!settlePickedDuelTab(fresh, dtab)) return send(res, 409, { error: 'could not settle this Duel' });
      saveTask(fresh);
      appendEval({ kind: 'pick', duelId, threadId: id, choice, winner, loser: winner === aModel ? bModel : aModel });
      return send(res, 200, { task: taskForClient(fresh), sourceTabId, duelTabId: dtab.id, duelId });
    }

    if (parts[3] === 'tabs' && parts[5] === 'typing' && method === 'POST') {
      const tab = getTab(task, parts[4]);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      const body = await readBody(req);
      team.typing({ task, tab, active: body.active !== false }).catch(() => {});
      return send(res, 200, { ok: true });
    }

    // POST /api/tasks/:id/tabs/:tabId/viewing -> where this person is looking,
    // for the other side's presence chips (Same team, presence v2).
    if (parts[3] === 'tabs' && parts[5] === 'viewing' && method === 'POST') {
      team.viewing({ taskId: id, tabId: parts[4] }).catch(() => {});
      return send(res, 200, { ok: true });
    }

    // Run a turn: POST /api/tasks/:id/tabs/:tabId/run, or legacy
    // POST /api/tasks/:id/run (uses the active tab). Body {prompt|prompts, model?}.
    const isTabRun = parts[3] === 'tabs' && parts[5] === 'run' && method === 'POST';
    const isLegacyRun = parts[3] === 'run' && method === 'POST';
    if (isTabRun || isLegacyRun) {
      const blocked = executionBlock(task);
      if (blocked) return send(res, 409, { error: blocked });
      const tabId = isTabRun ? parts[4] : task.activeTab || (task.tabs && task.tabs[0] && task.tabs[0].id);
      let tab = getTab(task, tabId);
      if (!tab) return send(res, 404, { error: 'no such tab' });
      if (tab.type === 'duel' && tab.duel && !tab.duel.choice) {
        return send(res, 400, { error: 'finish the blind Duel before continuing this tab' });
      }
      const body = await readBody(req);
      const batch = orderedPromptBatch(task, Array.isArray(body.prompts) ? body.prompts : body.prompt, Array.isArray(body.contextMentions) ? body.contextMentions : []);
      const { prompts, prompt, modelPrompt: baseModelPrompt } = batch;
      if (!prompts.length) return send(res, 400, { error: 'empty prompt' });
      for (const token of Array.isArray(body.tokens) ? body.tokens : []) {
        if (token?.type === 'time') return send(res, 400, { error: 'A time in the composer does not schedule yet. That message would have run right now instead of later, so nothing was sent. New task under Scheduled does it.' });
        if (token?.type === 'person') return send(res, 400, { error: 'Handing to a person is not built yet. Hand to one of their tabs, or send it in the thread.' });
      }
      let handoffFrom = null;
      if (body.handoffFrom && typeof body.handoffFrom === 'object' && body.handoffFrom.tabId) {
        // Written after team.beforeRun(): its cloud pull replaces the local
        // task wholesale, and an edge written before it was silently erased
        // by that replacement (E2E 2026-09-01) — the landed message kept
        // handedFrom while the task lost the durable row.
        handoffFrom = resolveHandoffSource(task, tab, body.handoffFrom);
      }
      function writeHandoffEdge() { writeTabHandoffEdge(task, tab, handoffFrom); }
      // Paper 21.2b: the chips that rode this send, sanitized once for the
      // Slack rail (body.mentions) and the message record.
      const sentMentions = (Array.isArray(body.mentions) ? body.mentions : [])
        .filter((row) => row && row.email)
        .map((row) => ({ email: String(row.email), name: String(row.name || '') }))
        .slice(0, 12);
      const sentContextRefs = (Array.isArray(body.contextMentions) ? body.contextMentions : [])
        .map((name) => String(name || '').trim()).filter(Boolean).slice(0, 12);
      // @Supreme in Slack (2026-09-16): the turn carries who asked and
      // where, so the transcript says so and the answer goes back there.
      const slackFrom = body.slack && typeof body.slack === 'object' && body.slack.channel
        ? { channel: String(body.slack.channel), channelName: String(body.slack.channelName || '').slice(0, 80), ts: String(body.slack.ts || ''), threadTs: String(body.slack.threadTs || ''), user: { id: String(body.slack.user?.id || ''), name: String(body.slack.user?.name || 'Someone on Slack').slice(0, 80) } }
        : null;
      // Section 29: a schedule sent this turn. The marker is rebuilt from the
      // store, so only a task that exists can sign a turn as its own.
      // Section 32: a turn an email started. Only the service's own inbound
      // route marks one, by the handoff it made.
      const emailHandoff = body.email && typeof body.email === 'object' ? email.getHandoff(String(body.email.handoffId || '')) : null;
      const emailFrom = emailHandoff ? { from: emailHandoff.email.from, subject: emailHandoff.email.subject, handoffId: emailHandoff.id, ...(emailHandoff.kind === 'deal_reply' ? { vime: true } : {}) } : null;
      const scheduledTask = body.scheduled && typeof body.scheduled === 'object' ? scheduled.getSchedule(String(body.scheduled.id || '')) : null;
      const scheduledFire = scheduledTask
        ? {
          id: scheduledTask.id,
          name: scheduledTask.name,
          fireId: String(body.scheduled.fireId || newId()),
          dueAt: String(body.scheduled.dueAt || new Date().toISOString()),
          ranAt: new Date().toISOString(),
          ...(Number(body.scheduled.missed) > 0 ? { missed: Math.floor(Number(body.scheduled.missed)) } : {}),
          ...(['closed', 'busy', 'asleep'].includes(body.scheduled.reason) ? { reason: body.scheduled.reason } : {}),
          ...(body.scheduled.manual === true ? { manual: true } : {}),
        }
        : null;
      const modelId = await currentModelFresh(body.model || tab.model || task.model);
      if (!isSelectableModel(modelId)) return send(res, 400, { error: 'unknown model' });
      if ([...runs.values()].some((run) => run.taskId === id && run.tabId === tab.id)) {
        return send(res, 409, { error: 'that tab is already running' });
      }
      const recommendation = modelId === RECOMMENDED_MODEL_ID
        ? recommendModel({ prompt, policy: getSettings().performancePolicy })
        : null;
      const model = resolveModel(recommendation?.modelId || modelId);
      if (!model) return send(res, 400, { error: 'recommended routing could not resolve a model' });
      // The Send again button is the deliberate retry: it never burns the
      // one-shot fast-fail warning — if the account is still dead the run
      // fails honestly and the button comes right back.
      const accountNotice = body.redo ? null : consumeAccountNoticeWarning(model.id);
      if (accountNotice) return send(res, 409, { error: accountNotice.message });
      if (model.provider === 'openrouter' && Array.isArray(body.terminalContexts) && body.terminalContexts.length) {
        return send(res, 400, { error: 'Shared terminal context currently requires a connected Claude or ChatGPT model.' });
      }
      // Paper 20.4: an archived workstream is read, not reopened.
      if (task.archived) return send(res, 409, { error: 'This workstream is archived. Unarchive it to run here.' });
      // Same team: a shared thread pulls its latest copy and takes the lease
      // first. Held elsewhere means this message queues (202) and runs on
      // this Mac once that turn lands.
      let queueId = null;
      if (team.isSharedTask(task)) {
        const gate = await team.beforeRun({ task, tab, body });
        if (gate.error) return send(res, gate.status || 409, { error: gate.error, ...(gate.code ? { code: gate.code } : {}) });
        if (gate.queued) {
          // The claimed replay skips the write (body.queueId is set), so the
          // edge must be durable from the original queued send.
          if (handoffFrom && !body.queueId) writeHandoffEdge();
          return send(res, 202, { queued: gate.queued });
        }
        queueId = gate.queueId || null;
        const fresh = gate.task || getTask(id);
        if (fresh && fresh !== task) { for (const k of Object.keys(task)) delete task[k]; Object.assign(task, fresh); }
        tab = getTab(task, tabId);
        if (!tab) return send(res, 404, { error: 'no such tab' });
      }
      // The edge lands on whichever copy of the task survives the pull above.
      if (handoffFrom && !body.queueId) writeHandoffEdge();
      // Paper 20: a new message brings a done tab back on its own.
      if (tab.done) { tab.done = false; tab.doneAt = null; tab.doneLine = null; saveTask(task); }
      let terminalContexts;
      try {
        terminalContexts = prepareTerminalContexts(body.terminalContexts, id, tab.id, prompt);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      let attachments;
      try {
        attachments = saveIncomingImageAttachments(body.images, { taskId: id, tabId: tab.id });
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      // Auto-contextualize, the admission check: never mid run, so the only
      // safe place to make room is before this run starts. If the projection
      // says the run would not fit, or a settle fold is still in flight, the
      // fold happens first and the run reads the folded tab.
      const incoming = Math.ceil(String(prompt).length / 4) + attachments.length * IMAGE_TOKENS;
      const admission = foldWanted(task, tab, 'admission', incoming);
      const cold = !admission && coldStartWantsFold(task, tab, model);
      if (foldRuns.has(`${id}:${tab.id}`) || admission || cold) {
        await foldTab(id, tab.id, cold ? 'cold' : 'admission');
        const refolded = getTask(id);
        if (refolded) { for (const k of Object.keys(task)) delete task[k]; Object.assign(task, refolded); }
        tab = getTab(task, tab.id) || tab;
      }
      // Recall on demand: a message that names something from the folded
      // part brings those messages back verbatim for this turn.
      const recalled = recallFromFold(tab, prompt);
      const slackRule = slackFrom
        ? `[This came in from Slack, from ${slackFrom.user.name}${slackFrom.channelName ? ` in #${slackFrom.channelName}` : ''}. If it asks for a message to someone (an email, a reply to a lead, a note), write the whole draft here and stop: do not send it, and end by asking whether to send it, in one short question such as "Send this?". Nothing goes out until they say so. If they have just said to confirm, send it and say what was sent.\nFor context in the originating channel or group chat, use Supreme's read_slack_context and read_slack_people tools first. They are read-only and use the bot connection that received this request, independently of other Slack connectors. Older context may be outside the recent excerpt: read_slack_context can page back, and its query filters only that page. Read member profiles before asking the user for an email. Slack Connect may hide an email; never infer one, check the person's visible Slack profile through an available browser tool or ask only for what is still missing. A failed separate connector does not mean all Slack access is revoked. If these tools refuse a shared workstream, do not copy private channel context into it by another route.\nCheck each account's actual seats and permissions before claiming an invite is free. Hold invites, access changes and purchases for approval with the exact person, tools and any added cost specified. A reply saying "Confirm" cannot supply missing details or authorize unspecified access. Ask clarification questions normally, not as approvals.]`
        : '';
      // Section 32: the orchestrator reads a forwarded email and only picks
      // a tab; the hand-over waits for the person's yes. A turn while the
      // pick is still open is told the same, so "Other tab" gets a new pick.
      const emailOpen = !emailFrom && tab.type === 'orchestrator' ? emailOpenFor(task.id, tab.id) : null;
      const emailRule = emailFrom || emailOpen ? emailPickRule(emailFrom || { ...emailOpen.email, ...(emailOpen.kind === 'deal_reply' ? { vime: true } : {}) }, !!emailOpen) : '';
      const attendedPrompt = [scheduledTask ? scheduled.unattendedPreamble(scheduledTask) : '', slackRule, emailRule, baseModelPrompt].filter(Boolean).join('\n\n');
      const modelPrompt = terminalContextPrompt(recalled.length ? `${recallBlock(recalled)}\n\n${attendedPrompt}` : attendedPrompt, terminalContexts);
      const runId = newId();
      const controller = new AbortController();
      // Set only when a play run types this turn (Paper 17.5).
      const playMarker = playMarkerFrom(body.play);
      const previousModelId = lastAssistantModel(tab.messages || []);
      const previousModel = resolveModel(previousModelId);
      const handoff = createModelHandoff({
        id: newId(),
        messages: tab.messages || [],
        fromModel: previousModelId,
        toModel: model.id,
        fromProvider: previousModel?.provider || null,
        toProvider: model.provider,
      });
      if (handoff) {
        tab.handoffs = tab.handoffs || [];
        tab.handoffs.push(handoff);
      }
      const run = {
        id: runId,
        controller,
        control: {},
        taskId: id,
        tabId: tab.id,
        model: model.id,
        requestedModel: modelId,
        recommendation,
        handoff,
        handedFrom: handoffFrom,
        slackFrom,
        terminalContexts,
        attachments: attachments.map(imageAttachmentRecord).filter(Boolean),
        imagePaths: attachments.map((attachment) => attachment.filePath),
        prompt,
        prompts,
        mentions: sentMentions,
        contextRefs: sentContextRefs,
        steers: [],
        hiddenPrompt: body.hiddenPrompt === true, play: playMarker,
        scheduled: scheduledFire,
        effort: body.effort || null,
        // Same team: whose Mac this is, kept from the start so a run cut off
        // before it lands still says whose turn it was.
        ...(team.isSharedTask(task) && team.me() ? { ranBy: { id: team.me().id, name: team.me().name, machine: team.status().machine } } : {}),
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        seq: 0,
        events: [],
      };
      tab.activeRun = {
        ...(run.ranBy ? { ranBy: run.ranBy } : {}),
        id: runId,
        taskId: id,
        tabId: tab.id,
        model: model.id,
        requestedModel: modelId,
        recommendation,
        handoff,
        terminalContexts: publicTerminalContexts(terminalContexts),
        attachments: publicImageAttachments(attachments, id, tab.id),
        prompt,
        prompts,
        mentions: sentMentions,
        contextRefs: sentContextRefs,
        steers: [],
        hiddenPrompt: body.hiddenPrompt === true, play: playMarker,
        ...(scheduledFire ? { scheduled: scheduledFire } : {}),
        effort: body.effort || null,
        startedAt: new Date(run.startedAt).toISOString(),
        text: '',
        draftText: '',
        workNotes: [],
        tools: [],
        statusText: '',
        seq: 0,
        active: true,
      };
      tab.status = 'running';
      task.status = 'running';
      task.lastActivity = tab.activeRun.startedAt;
      saveTask(task);
      runs.set(runId, run);
      // The step trace (computer steps, connector rows) travels to the other
      // person as the same public shapes the card renders; screenshots do not.
      team.startRun({ runId, taskId: id, tabId: tab.id, queueId, activity: () => ({ computer: computerPublic(run), connectors: connectorsPublic(run) }) });
      refreshKeepAwake();
      const stream = sseStart(res);
      const emit = (ev) => {
        const recorded = recordRunEvent(runId, ev) || ev;
        const shown = publicRunEvent(recorded);
        team.onRunEvent(runId, shown);
        stream(shown);
      };
      // A later request on this run (a steer's ping receipt) speaks on the
      // same stream, so the live card hears it without waiting for a poll.
      run.emit = emit;
      emit({ type: 'start', runId, model: model.id, requestedModel: modelId, recommendation, handoff, effort: body.effort || null, terminalContexts: publicTerminalContexts(terminalContexts), attachments: publicImageAttachments(attachments, id, tab.id), prompts, hiddenPrompt: body.hiddenPrompt === true, play: playMarker, tabId: tab.id, mentions: sentMentions, contextRefs: sentContextRefs, ...(handoffFrom ? { handedFrom: handoffFrom } : {}), ...(scheduledFire ? { scheduled: scheduledFire } : {}) });
      try {
        try {
          const out = await runTaskTurn({
            handoffFrom,
            slackFrom,
            emailFrom,
            scheduledFire,
            recalled: recalled.map((row) => ({ id: row.id, index: row.index })),
            mentions: sentMentions,
            contextRefs: sentContextRefs,
            task,
            tab,
            model,
            requestedModelId: modelId,
            recommendation,
            prompt,
            prompts,
            modelPrompt,
            terminalContexts,
            attachments,
            hiddenPrompt: body.hiddenPrompt === true, play: playMarker,
            emit,
            signal: controller.signal,
            effort: body.effort,
            runState: run,
          });
          emit({ type: 'saved', status: out.task.status, diffStat: out.task.diffStat, tabId: tab.id, ok: out.ok, stopped: out.stopped, waiting: out.waiting });
        } catch (err) {
          emit({ type: 'error', message: err.message });
          const f = getTask(id);
          if (f) {
            const t = (f.tabs || []).find((candidate) => candidate.id === tab.id);
            if (t) finishPendingRunAsError(f, t, err.message || 'run failed');
            else f.status = 'error';
            saveTask(f);
          }
        }
      } finally {
        // Whatever happened above (a disk full inside the save, a task file
        // that would not parse), the run leaves the live map here. One left
        // behind read as running for the life of the service: scheduled
        // fires said busy, Slack turns queued behind it, the Mac stayed
        // awake, CLI updates waited.
        try { emit({ type: 'run-finished', runId, tabId: tab.id }); } catch (err) { console.error('[run] finish event:', err.message); }
        finishRun(runId);
        team.afterRun({ runId }).catch((err) => console.error('[team] after run:', err.message));
        try {
          // Auto-contextualize, the settle check: the run has landed and the
          // tab is idle; if it crossed the threshold, fold now.
          settleFold(id, tab.id);
          // Messages held while this ran are in the transcript now; the tab
          // has nothing else to do, so it reads them.
          wakeTabForMessages(id, tab.id, { delayMs: 600 });
        } catch (err) { console.error('[run] after landing:', err.message); }
        res.end();
      }
      return;
    }

    // GET /api/tasks/:id/diff
    if (parts[3] === 'diff' && method === 'GET') {
      try {
        const d = await worktreeDiff(taskWorkingDirectory(task), task.base);
        const dirty = await isDirty(taskWorkingDirectory(task));
        return send(res, 200, { ...d, dirty });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // POST /api/tasks/:id/merge  {mode:'merge'|'pr', message?}
    if (parts[3] === 'merge' && method === 'POST') {
      const body = await readBody(req);
      try {
        await commitAll(taskWorkingDirectory(task), body.message || `conductor: ${task.title}`);
        if (body.mode === 'pr') {
          const pr = await openPr({ repo: task.repo, branch: task.branch, base: task.base, title: task.title, body: body.body || '' });
          task.prUrl = pr.url;
          task.status = 'done';
          saveTask(task);
          return send(res, 200, { ok: true, prUrl: pr.url });
        }
        await mergeToBase({ repo: task.repo, branch: task.branch, base: task.base, message: `Merge ${task.branch}: ${task.title}` });
        await removeWorktree({ repo: task.repo, worktreePath: task.worktreePath, branch: task.branch });
        task.status = 'merged';
        saveTask(task);
        return send(res, 200, { ok: true, merged: true });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // POST /api/tasks/:id/discard  -> remove worktree + branch, delete the task
    if (parts[3] === 'discard' && method === 'POST') {
      try {
        await removeWorktree({ repo: task.repo, worktreePath: task.worktreePath, branch: task.branch });
      } catch {}
      removeTaskImageAttachments(id);
      deleteTask(id);
      return send(res, 200, { ok: true });
    }
  }

  // GET /api/runs/:id/events?after=N -> replayable normalized provider events.
  if (parts[1] === 'runs' && parts[3] === 'events' && method === 'GET') {
    const run = runs.get(parts[2]) || recentRuns.get(parts[2]);
    if (!run) return send(res, 404, { error: 'no such run' });
    const after = Math.max(0, Number(url.searchParams.get('after') || 0));
    return send(res, 200, {
      run: runPublic(run),
      active: runs.has(parts[2]),
      events: (run.events || []).filter((ev) => ev.seq > after).map(publicRunEvent),
    });
  }

  // Latest safe browser screenshot for the prototype's Peek control. Pixels
  // stay only in the in-memory run buffer and are never written into a task.
  if (parts[1] === 'runs' && parts[3] === 'computer' && parts[4] === 'screen' && method === 'GET') {
    const run = runs.get(parts[2]) || recentRuns.get(parts[2]);
    const value = run?.computerPreview?.dataUrl;
    const match = typeof value === 'string' && value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) return send(res, 404, { error: 'no screen preview is available for this run' });
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > 9_000_000) return send(res, 413, { error: 'screen preview is too large' });
    res.writeHead(200, {
      'Content-Type': `image/${match[1].toLowerCase()}`,
      'Content-Length': data.length,
      'Cache-Control': 'no-store, max-age=0',
    });
    res.end(data);
    return;
  }

  // POST /api/runs/:id/cancel
  if (parts[1] === 'runs' && parts[3] === 'cancel' && method === 'POST') {
    const r = runs.get(parts[2]);
    if (!r) return send(res, 404, { error: 'no such run' });
    r.cancelled = true;
    recordRunEvent(parts[2], { type: 'status', text: 'Stopping…' });
    r.controller.abort();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

// The service holds this person's connectors and runs the model CLIs with
// their permissions, and every web page open in a browser on this Mac can
// reach 127.0.0.1. A request a page sends carries that page's Origin; one
// from the app's own window, the dev server, a local tool or curl carries
// none or a loopback one. Anything else is refused before it is read: a
// page could otherwise start a run with any prompt as a plain POST, no
// preflight needed, since the body reader parses JSON whatever the
// content type says. The Host check keeps a page whose name resolves to
// 127.0.0.1 (DNS rebinding) out the same way.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function loopbackHost(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host) return true; // an HTTP/1.0 tool sends no Host at all
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name);
}
function localRequest(headers) {
  if (!loopbackHost(headers.host)) return false;
  if (headers.origin == null) return true;
  try { return loopbackHost(new URL(headers.origin).host); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!localRequest(req.headers)) return send(res, 403, { error: 'Supreme answers only its own window' });
  try {
    // Test-only (guarded by env, never set in the app): seize the loop so the
    // watchdog smoke can prove a wedged service dies fast.
    if (process.env.WB_ALLOW_WEDGE_TEST === '1' && url.pathname === '/api/_wedge' && req.method === 'POST') {
      send(res, 200, { ok: true });
      const until = Date.now() + 60_000;
      while (Date.now() < until) { /* deliberately seized */ }
      return;
    }
    // Test-only: the Mac asleep. Both threads stop, so the watchdog's own
    // timer stalls with the loop; on waking it must not read the gap as a
    // seizure.
    if (process.env.WB_ALLOW_WEDGE_TEST === '1' && url.pathname === '/api/_nap' && req.method === 'POST') {
      const body = await readBody(req);
      const ms = Math.min(120_000, Math.max(0, Number(body?.ms) || 0));
      send(res, 200, { ok: true, ms });
      loopWatchdog?.postMessage({ nap: ms });
      const until = Date.now() + ms;
      while (Date.now() < until) { /* asleep */ }
      return;
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

let serviceShuttingDown = false;

async function shutdownLocalService(signal) {
  if (serviceShuttingDown) return;
  serviceShuttingDown = true;
  console.info(`[service] ${signal} received; releasing local model and computer-control processes`);
  clearInterval(runWatchdog);

  let serverClosedResolve;
  const serverClosed = new Promise((resolve) => { serverClosedResolve = resolve; });
  try { server.close(() => serverClosedResolve()); } catch { serverClosedResolve(); }

  // Ask every in-flight workflow to stop through its normal path first. This
  // lets Codex send turn/interrupt and persist any partial transcript before
  // the provider process gets the bounded process-tree fallback below.
  for (const run of runs.values()) run.controller?.abort();
  for (const duel of duelRuns.values()) duel.controller?.abort();
  for (const job of playFindJobs.values()) if (!job.finishedAt) job.controller?.abort();
  for (const run of playRuns.values()) if (!run.finishedAt) stopPlayRun(run);

  await new Promise((resolve) => setTimeout(resolve, 350));
  await shutdownProviderProcesses({ reason: `service-${signal.toLowerCase()}`, graceMs: 1_500 });
  await Promise.race([slackActivity.shutdown(), new Promise((resolve) => setTimeout(resolve, 1_500))]);
  await Promise.race([
    serverClosed,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  keepawake.release();
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdownLocalService('SIGTERM'); });
process.once('SIGINT', () => { void shutdownLocalService('SIGINT'); });

// Node ends the process on a promise nobody caught, and this service holds
// every run in flight: one stray rejection in a timer or a fire-and-forget
// call took them all down, and the desktop app's respawn reads back as "Run
// interrupted when Workbench restarted". Log it and carry on; the loop
// watchdog and the desktop's health loop still catch a service that has
// actually stopped answering. An uncaught exception is logged the same way,
// but a burst of them means the process is in a state nothing here can
// reason about, so it exits and lets the desktop app bring up a fresh one.
process.on('unhandledRejection', (reason) => {
  console.error('[service] unhandled rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});
const uncaughtRecently = [];
process.on('uncaughtException', (err) => {
  console.error('[service] uncaught exception:', err instanceof Error ? err.stack || err.message : err);
  const now = Date.now();
  uncaughtRecently.push(now);
  while (uncaughtRecently.length && now - uncaughtRecently[0] > 60_000) uncaughtRecently.shift();
  if (uncaughtRecently.length >= 5) {
    console.error('[service] five uncaught exceptions in a minute; exiting so the app can respawn a clean service');
    void shutdownLocalService('UNCAUGHT');
  }
});

// On boot, any task left 'running' by a previous process is not actually
// running anymore — reconcile so the UI isn't stuck on a phantom run.
function reconcile() {
  for (const t of listTasks()) {
    const full = getTask(t.id);
    if (!full) continue;
    // A cloud handoff that died mid-start (process crash before the worker
    // booted) leaves state 'starting' with no machineId, which blocks the
    // cloud button forever ("already moving to cloud"). A live start belongs
    // to one in-flight request on one machine and settles within ~2 minutes;
    // past 10 it's abandoned. The window keeps a boot on one Mac from
    // clearing a start genuinely in flight on another.
    const handoff = full.cloudHandoff;
    if (handoff?.state === 'starting' && !handoff.machineId) {
      const startedAt = Date.parse(handoff.startedAt || '');
      if (!Number.isFinite(startedAt) || Date.now() - startedAt > 10 * 60_000) {
        delete full.cloudHandoff;
        saveTask(full);
      }
    }
    reconcileTaskRuntimeState(full, 'Run interrupted when Workbench restarted. Any partial work was preserved; review it before retrying.');
  }
}

reconcile();
migrateProjectIdentities(); // one-time stable ids for legacy path-only projects
migrateTaskProjectIdentities(); // bind legacy workstreams to those stable project ids
migrateTaskContextBlocks(); // lift pre-repo-scoping blocks up to their project
pruneEmptyArchivedTabs(); // an archived tab with nothing in it is deleted, not kept
cleanupContextShares(DATA_DIR); // sweep stale shared-transcript files
refreshKeepAwake(); // honor keepAwake:'always' from a prior session
// Section 29: the scheduled tasks' clock. The first look is a few seconds in,
// once the service is answering, so what came due while Supreme was shut
// runs now and says so.
if (SCHEDULED_ON) {
  setTimeout(() => { void scheduleTick(); }, Math.min(4_000, SCHEDULE_TICK_MS)).unref?.();
  setInterval(() => { void scheduleTick(); }, SCHEDULE_TICK_MS).unref?.();
}
function slackIsMe(email) {
  const mine = new Set([slackPrefs().selfEmail, team.me()?.email, getSettings().onboarding?.email, ...(Array.isArray(getSettings().email?.allowFrom) ? getSettings().email.allowFrom : [])].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  return !!email && mine.has(email);
}
function slackIsMeUser(slackUserId, email) {
  const id = String(slackUserId || '').trim();
  const known = slackPrefs().selfUserId;
  if (id && known && id === known) return true;
  if (!slackIsMe(email)) return false;
  if (id && id !== known) {
    const settings = getSettings();
    settings.slack = { ...(settings.slack && typeof settings.slack === 'object' ? settings.slack : {}), selfUserId: id };
    saveSettings(settings);
  }
  return true;
}
async function slackScopeFor(slackUserId) {
  const email = await slackUserEmail(slackUserId);
  if (slackIsMeUser(slackUserId, email)) return null;
  const allowed = new Set();
  if (!email) return allowed;
  for (const repo of listRepos()) {
    const info = repo.id ? team.sharedInfo(repo.id) : null;
    if (info?.members?.some((member) => member.accepted && String(member.email || '').toLowerCase() === email)) allowed.add(repo.id);
  }
  return allowed;
}
// A teammate's ask runs on their own Mac (lib/slack-relay.mjs). Who this
// Mac is, and whose Mac a Slack address belongs to: a member of a shared
// project who has a Supreme account. The smokes name both by env.
function slackRelayMe() {
  return String(process.env.WB_SLACK_RELAY_ME || team.me()?.id || '');
}
function slackRelayToken() { return team.sessionToken(); }
function slackTeammateFor(email) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return null;
  if (process.env.WB_SLACK_RELAY_TEAM) {
    try {
      const row = JSON.parse(process.env.WB_SLACK_RELAY_TEAM)[address];
      if (row) return typeof row === 'string' ? { userId: row, name: '' } : row;
    } catch { /* ignore */ }
    return null;
  }
  const me = slackRelayMe();
  for (const repo of listRepos()) {
    const info = repo.id ? team.sharedInfo(repo.id) : null;
    const member = info?.members?.find((row) => row.accepted && row.userId && row.userId !== me && String(row.email || '').toLowerCase() === address);
    if (member) return { userId: member.userId, name: member.name || '' };
  }
  return null;
}
// Every row of buttons Supreme posts says whose Mac posted it, so a press
// that reaches the listening Mac goes back to the Mac that asked.
const SLACK_RUNNER_BLOCK = 'supreme:r:';
function slackActionsBlock(elements) {
  const me = slackRelayMe();
  return { type: 'actions', ...(me ? { block_id: `${SLACK_RUNNER_BLOCK}${me}`.slice(0, 255) } : {}), elements };
}
function slackRunnerOf(action) {
  const id = String(action?.block_id || '');
  return id.startsWith(SLACK_RUNNER_BLOCK) ? id.slice(SLACK_RUNNER_BLOCK.length) : '';
}
const SLACK_RELAY_WAIT_MS = Math.max(1_000, Number(process.env.WB_SLACK_RELAY_WAIT_MS) || 120_000);
// Hands an ask to the teammate's Mac. Returns true when it went.
async function relaySlack({ teammate, kind, payload, channel, threadTs, say = '' }) {
  const token = slackRelayToken();
  if (!slackRelay.available(token)) return false;
  let id;
  try { id = await slackRelay.send({ token, sender: slackRelayMe(), recipient: teammate.userId, kind, payload }); } catch (err) {
    console.warn(`[slack] could not hand this to ${teammate.name || 'a teammate'}'s Mac: ${err.message}`);
    return false;
  }
  const whose = teammate.name ? `${teammate.name.split(' ')[0]}'s Mac` : 'their own Mac';
  if (say && channel) await slackPostInThread(channel, threadTs, say.replace('{mac}', whose)).catch(() => {});
  console.info(`[slack] handed a ${kind} to ${whose}`);
  if (channel) {
    const timer = setTimeout(async () => {
      if (await slackRelay.wasPicked({ token: slackRelayToken(), id }).catch(() => true)) return;
      await slackPostInThread(channel, threadTs, `${whose[0].toUpperCase()}${whose.slice(1)} hasn't picked this up yet. It runs there when Supreme is open.`).catch(() => {});
    }, SLACK_RELAY_WAIT_MS);
    timer.unref?.();
  }
  return true;
}
// This Mac takes what the listening Mac handed over, and believes none of
// what the row says about who asked (Codex's release probe, 2026-09-26: a
// teammate-written row claiming the owner started a turn in the owner's
// private tab). The row's sender is proven by the cloud (auth.uid), nothing
// else in it is. A mention is read back from Slack with this Mac's own bot
// token, so who wrote it and what it says come from Slack; its tabs are
// then scoped as for any mention here. A button press or Edit cannot be
// read back, so it never reaches past the projects this Mac shares with
// the sender, whoever it claims pressed it.
async function takeRelayedSlack(row) {
  if (!slackPrefs().botToken) {
    console.warn('[slack] a teammate handed over a Slack ask, but this Mac has no Slack bot token');
    return;
  }
  const payload = row.payload || {};
  const sender = String(row.sender || '').trim();
  if (!sender) return;
  if (row.kind === 'mention') {
    const event = await slackMessageFromSlack(payload.event || {});
    if (!event) { console.warn('[slack] a handed-over mention could not be found in Slack; dropped'); return; }
    // Release relay pickup once the input has its FIFO place, not once the
    // entire model run finishes. Otherwise later relay rows cannot steer it.
    return new Promise(resolve => {
      handleSlackMention(event, { relayed: true, onRouted: resolve })
        .catch(error => console.warn(`[slack] relayed mention: ${error.message}`))
        .finally(resolve);
    });
  }
  if (row.kind === 'action') return handleSlackAction(payload.payload || {}, payload.action || {}, { relayedFrom: sender });
  if (row.kind === 'view') return handleSlackEditSubmit(payload.payload || {}, { relayedFrom: sender });
}
// The message as Slack has it: author, text, files, forwards and thread.
async function slackMessageFromSlack(claimed) {
  return readSlackRequest({ claimed, botId: await slackBotUserId(), readThread: slackThreadMessages,
    readConversation: async channel => (await slackCall('conversations.info', { channel })).channel,
    allowFollowup: slackFollowupAllowed });
}
// Projects this Mac shares with a Supreme user (owner or accepted member).
function projectsSharedWith(userId) {
  const out = new Set();
  if (!userId) return out;
  for (const repo of listRepos()) {
    const info = repo.id ? team.sharedInfo(repo.id) : null;
    if (!info) continue;
    if (info.ownerId === userId || info.members?.some((member) => member.accepted && member.userId === userId)) out.add(repo.id);
  }
  return out;
}
// A handed-over press never reaches past what the sender shares here.
async function slackPressScope(slackUserId, relayedFrom) {
  const scope = await slackScopeFor(slackUserId);
  if (!relayedFrom) return scope;
  const cap = projectsSharedWith(relayedFrom);
  return scope ? new Set([...scope].filter((id) => cap.has(id))) : cap;
}
function slackMayUse(scope, task) {
  return !scope || (!!task?.projectId && scope.has(task.projectId));
}
function allTabDestinations(scope = null) {
  const rows = [];
  const repos = listRepos();
  for (const summary of listTasks().filter((row) => !row.archived && (!scope || (row.projectId && scope.has(row.projectId))))) {
    const project = repos.find((repo) => (summary.projectId && repo.id === summary.projectId) || repo.path === summary.repo)?.name || summary.repoName || '';
    for (const tab of summary.tabs || []) {
      if (tab.type === 'duel' || tab.done) continue;
      rows.push({ threadId: summary.id, tabId: tab.id, tab: tab.name || 'Untitled', workstream: summary.title || summary.repoName || 'Untitled', project });
    }
  }
  return rows;
}
// Which tab a mention means: "[Workstream / Tab]" or "Workstream / Tab:" at
// the start, else the longest workstream or tab name the text mentions (a
// workstream alone means its current tab). The tag is cut from the text;
// a name mid sentence stays part of it.
function resolveSlackTab(text, scope = null) {
  const rows = allTabDestinations(scope);
  const lower = (value) => String(value || '').toLowerCase().trim();
  const clean = String(text || '');
  const activeOf = (threadId) => {
    const task = getTask(threadId);
    return rows.find((row) => row.threadId === threadId && row.tabId === task?.activeTab) || rows.find((row) => row.threadId === threadId) || null;
  };
  const byName = (name) => {
    const parts = String(name || '').split(' / ').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2) return rows.find((row) => lower(row.workstream) === lower(parts[0]) && lower(row.tab) === lower(parts[1])) || null;
    const tabs = rows.filter((row) => lower(row.tab) === lower(name));
    if (tabs.length === 1) return tabs[0];
    const workstream = rows.find((row) => lower(row.workstream) === lower(name));
    return workstream ? activeOf(workstream.threadId) : null;
  };
  const explicit = clean.match(/^\s*\[([^\]]{1,120})\]\s*/) || clean.match(/^\s*([^:\n]{2,120}?)\s*:\s+/);
  if (explicit) {
    const hit = byName(explicit[1]);
    if (hit) return { row: hit, rest: clean.slice(explicit[0].length).trim() };
  }
  return null;
}
// One thread, one tab: once a tab has been picked for a Slack thread (by
// name, or by a button), later mentions in that thread go there without
// asking again. A pressed button also needs the ask it answers.
const SLACK_THREAD_TTL_MS = 24 * 3_600_000;
const slackThreadTabs = new Map();   // channel:threadTs -> { threadId, tabId, at }
const slackThreadInputs = new Map(); // bounded read-through cursor, no message contents
const slackPendingAsks = new Map();  // channel:messageTs -> { text, threadTs, channel, user, files, at }
function slackThreadKey(channel, threadTs) { return `${channel}:${threadTs}`; }
function slackConnectionKey() {
  const token = slackPrefs().botToken;
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 24) : '';
}
const slackActivity = createSlackActivity({ call: slackCall, identity: slackConnectionKey, home: DATA_DIR });
const slackContext = createSlackContextReader({ readConversation: slackConversationInfo, readHistory: slackHistoryPage, readThread: slackThreadPage,
  messageText: slackMessageText, userName: slackUserName, botId: slackBotUserId, connectionKey: slackConnectionKey });
const slackPeople = createSlackPeopleReader({ readConversation: slackConversationInfo, readMembers: slackMemberPage, readProfile: slackUserProfile, connectionKey: slackConnectionKey });
async function slackGroupBackground(task, channel, ts) {
  if (slackBackgroundAllowed(task, team.sharedInfo(task.projectId))) return slackContext.read({ channel, mentionTs: ts, automatic: true });
  const conversation = await slackConversationInfo(channel).catch(() => null);
  return conversation?.is_mpim ? { warning: 'Recent group-chat background is not copied into shared workstreams. Use the private Slack conversation, or explicitly forward the messages you want shared.' } : { text: '' };
}
function rememberedSlackThread(channel, threadTs) {
  const key = slackThreadKey(channel, threadTs);
  const row = slackThreadTabs.get(key) || getSettings().slack?.threadTabs?.[key];
  return row?.connection === slackConnectionKey() ? row : null;
}
async function slackFollowupAllowed({ channel, threadTs, user }) {
  const known = rememberedSlackThread(channel, threadTs);
  const task = known ? getTask(known.threadId) : null;
  const tab = task ? getTab(task, known.tabId) : null;
  const scope = await slackScopeFor(user);
  if (task && !task.archived && tab && !tab.done && slackMayUse(scope, task)) return true;
  // Another participant continues with their own accounts on their own Mac.
  // Reconstruct invitation from Slack, not from a caller-supplied relay row.
  // A still-known but closed route must not silently create a replacement.
  if (known || scope !== null || !slackPrefs().startNewThreads) return false;
  const [messages, botId] = await Promise.all([slackThreadMessages(channel, threadTs).catch(() => []), slackBotUserId()]);
  return slackThreadInvited(messages, threadTs, botId);
}
async function slackTeammateThreadFollowup(event) {
  const relay = getSettings().slack?.relayThreads?.[slackThreadKey(event.channel, event.thread_ts)];
  if (!rememberedSlackThread(event.channel, event.thread_ts) && relay?.connection !== slackConnectionKey()) return false;
  const email = await slackUserEmail(event.user);
  return !slackIsMeUser(event.user, email) && !!slackTeammateFor(email);
}
function relayedSlackFollowupAllowed(event) {
  const row = getSettings().slack?.relayThreads?.[slackThreadKey(event.channel, event.thread_ts)];
  return !!(row && row.connection === slackConnectionKey() && row.user === event.user);
}
function rememberSlackRelayThread(channel, threadTs, user) {
  const settings = getSettings();
  const key = slackThreadKey(channel, threadTs);
  const relayThreads = Object.fromEntries(Object.entries({ ...settings.slack?.relayThreads,
    [key]: { user, at: Date.now(), connection: slackConnectionKey() } }).sort((a, b) => b[1].at - a[1].at).slice(0, 500));
  settings.slack = { ...settings.slack, relayThreads };
  saveSettings(settings);
}
function rememberSlackTab(channel, threadTs, threadId, tabId) {
  const now = Date.now();
  for (const [key, row] of slackThreadTabs) if (now - row.at > SLACK_THREAD_TTL_MS) slackThreadTabs.delete(key);
  for (const [key, row] of slackPendingAsks) if (now - row.at > SLACK_THREAD_TTL_MS) slackPendingAsks.delete(key);
  const key = slackThreadKey(channel, threadTs);
  const row = { threadId, tabId, at: now, connection: slackConnectionKey() };
  slackThreadTabs.set(key, row);
  const settings = getSettings();
  const previous = settings.slack?.threadTabs || {};
  // A route is metadata only. Keep recent routes bounded, and re-check access
  // on every use, including after a restart or a workspace reconnection.
  const threadTabs = Object.fromEntries(Object.entries({ ...previous, [key]: row })
    .sort((a, b) => b[1].at - a[1].at).slice(0, 500));
  settings.slack = { ...settings.slack, threadTabs };
  saveSettings(settings);
}
// An unaddressed request gets its own context, never a guessed existing tab.
// Only this Mac's owner may create private Slack workstreams here. Teammates
// keep their own-Mac relay and shared-project chooser, with no new access.
async function newSlackThread({ channel, threadTs, channelName, user, text, event }) {
  let settings = getSettings();
  let project = listRepos().find((repo) => repo.id === settings.slack?.inboxProjectId && !team.sharedInfo(repo.id));
  if (!project) {
    const id = newId();
    const root = await createManagedProject({ name: 'Slack', id });
    project = addRepo({ id, path: root, name: 'Slack', base: 'main', hasRemote: false, managed: true });
    settings = getSettings();
    settings.slack = { ...settings.slack, inboxProjectId: project.id };
    saveSettings(settings);
  }
  if (project.archived) project = setRepoArchived(project.path, false) || project;
  const parent = event.thread_ts && event.thread_ts !== event.ts ? await slackThreadParent(channel, threadTs) : null;
  const title = titleFrom(slackMessageText(parent) || text || `Request in #${channelName}`);
  const model = await currentModelFresh(getSettings().defaultModel || RECOMMENDED_MODEL_ID);
  if (!isSelectableModel(model)) throw new Error('Choose a connected model in Supreme, then mention me again.');
  const id = newId();
  const root = await localProjectRoot(project);
  const wt = await createWorktree({ repo: root, title, base: project.base, id });
  const task = createTask({ id, title, projectId: project.id, repo: project.path, repoName: project.name,
    base: wt.base, branch: wt.branch, worktreePath: wt.worktreePath, model, tools: 'full', connectors: true, origin: 'slack' });
  task.slackSession = { channel, threadTs, user, connection: slackConnectionKey() };
  saveTask(task);
  return { row: { threadId: task.id, tabId: task.tabs[0].id }, rest: text };
}
function slackButton(label, actionId, value, primary = false) {
  return { type: 'button', text: { type: 'plain_text', text: String(label).slice(0, 75), emoji: false }, action_id: actionId, value: JSON.stringify(value).slice(0, 2_000), ...(primary ? { style: 'primary' } : {}) };
}
const SLACK_SELECT_MAX = 100;
function slackOptionPath(row) {
  const tab = String(row.tab).slice(0, 60);
  const lead = [row.project, row.workstream].filter((part, index, all) => part && all.indexOf(part) === index).join(' / ');
  if (!lead) return tab;
  const room = 75 - tab.length - 3;
  return room > 0 ? `${lead.slice(0, room)} / ${tab}` : tab;
}
function slackTabSelect(actionId, placeholder = 'Another tab', scope = null) {
  const rows = allTabDestinations(scope);
  const activity = new Map();
  for (const summary of listTasks()) activity.set(summary.id, Date.parse(summary.lastActivity || summary.updatedAt || '') || 0);
  const kept = [...rows].sort((a, b) => (activity.get(b.threadId) || 0) - (activity.get(a.threadId) || 0)).slice(0, SLACK_SELECT_MAX);
  const groups = new Map();
  for (const row of kept) {
    if (!groups.has(row.threadId)) groups.set(row.threadId, { label: { type: 'plain_text', text: String(row.workstream).slice(0, 75), emoji: false }, options: [] });
    groups.get(row.threadId).options.push({ text: { type: 'plain_text', text: slackOptionPath(row), emoji: false }, value: `${row.threadId}|${row.tabId}`.slice(0, 75) });
  }
  if (!groups.size) return null;
  return { type: 'static_select', action_id: actionId, placeholder: { type: 'plain_text', text: placeholder, emoji: false }, option_groups: [...groups.values()] };
}
function emailSettings() {
  const value = getSettings().email;
  return value && typeof value === 'object' ? value : {};
}
// Only the person's own addresses may start anything: the list in
// Settings, plus the email they signed in with.
function emailAllowList() {
  const listed = Array.isArray(emailSettings().allowFrom) ? emailSettings().allowFrom : [];
  const own = [getSettings().onboarding?.email, team.me()?.email];
  return [...new Set([...listed, ...own].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}
function emailDomain() { return String(emailSettings().domain || email.DEFAULT_EMAIL_DOMAIN); }
// A Resend key in Settings sends from this Mac; without one the reply goes
// out through Supreme's cloud (resend-inbound, send), which only mails the
// signed-in person's own addresses. So a teammate sets nothing up.
function sendEmail(mail) {
  const { url, anonKey, configured } = supabase.config();
  const token = team.sessionToken();
  const cloud = configured && token ? { url, anon: anonKey, token } : null;
  return email.makeSender({ apiKey: String(emailSettings().resendKey || ''), cloud })(mail);
}
function emailProjectFor(prefix) {
  const aliases = emailSettings().aliases && typeof emailSettings().aliases === 'object' ? emailSettings().aliases : {};
  const wanted = String(aliases[prefix] || prefix || '').trim().toLowerCase();
  if (!wanted) return null;
  // Then a prefix the project's owner set, which came with the share.
  return listRepos().find((repo) => String(repo.name || '').trim().toLowerCase() === wanted)
    || listRepos().find((repo) => Array.isArray(repo.emailAliases) && repo.emailAliases.includes(String(prefix || '').trim().toLowerCase()))
    || null;
}
function tasksOfProject(repo) {
  return listTasks().filter((summary) => !summary.archived && ((summary.projectId && summary.projectId === repo.id) || summary.repo === repo.path));
}
// The project's orchestrator: one with email in its name or its
// workstream's, else the first; with none, an Email workstream gets one.
async function emailOrchestratorFor(repo) {
  const found = [];
  for (const summary of tasksOfProject(repo)) {
    for (const tab of summary.tabs || []) if (tab.type === 'orchestrator' && !tab.done) found.push({ summary, tab });
  }
  const emailish = found.find((row) => /email/i.test(`${row.tab.name} ${row.summary.title}`));
  const pick = emailish || found[0];
  if (pick) return { threadId: pick.summary.id, tabId: pick.tab.id };
  const made = await fetch(`http://127.0.0.1:${PORT}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: repo.path, title: 'Email' }) });
  const payload = await made.json().catch(() => ({}));
  if (!made.ok || !payload.task) throw new Error(payload.error || 'could not make the Email workstream');
  const tab = payload.task.tabs[0];
  const task = getTask(payload.task.id);
  const live = getTab(task, tab.id);
  live.name = 'Email Orchestrator';
  live.type = 'orchestrator';
  const mine = team.me()?.id;
  if (mine) live.privateTo = mine;
  task.mapOff = false;
  saveTask(task);
  return { threadId: task.id, tabId: tab.id };
}
function emailLabel(row) { return `${row.workstream} / ${row.tab}`; }
function emailTargetByName(name, repo) {
  const lower = (value) => String(value || '').trim().toLowerCase();
  const wanted = String(name || '').replace(/^\[|\]$/g, '').trim();
  const all = allTabDestinations();
  const own = all.filter((row) => !repo || lower(row.project) === lower(repo.name));
  const find = (rows) => {
    const parts = wanted.split(' / ').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) {
      const [project, workstream, tab] = [parts[0], parts.slice(1, -1).join(' / '), parts[parts.length - 1]];
      const hit = rows.find((row) => lower(row.project) === lower(project) && lower(row.workstream) === lower(workstream) && lower(row.tab) === lower(tab));
      if (hit) return hit;
    }
    const at = wanted.lastIndexOf(' / ');
    if (at > 0) {
      const [workstream, tab] = [wanted.slice(0, at), wanted.slice(at + 3)];
      const hits = rows.filter((row) => lower(row.workstream) === lower(workstream) && lower(row.tab) === lower(tab));
      return hits.length === 1 ? hits[0] : null;
    }
    const byTab = rows.filter((row) => lower(row.tab) === lower(wanted));
    return byTab.length === 1 ? byTab[0] : null;
  };
  return find(own) || find(all);
}
function emailOpenFor(threadId, tabId) {
  return [...email.listHandoffs()].reverse().find((row) => row.orch?.threadId === threadId && row.orch?.tabId === tabId && (row.status === 'suggesting' || row.status === 'confirming')) || null;
}
function emailPickRule(mail, again) {
  if (again) return '[The forwarded email above is still waiting for a tab. If this asks for a different tab, pick again the same way: one or two plain sentences, then a last line exactly "Hand to: Workstream / Tab" (or "Hand to: new tab <Name> in <Workstream>"). Do not send anything to any tab yourself.]';
  const how = mail.vime ? `Vime passed this on: a reply from ${mail.from} on a deal thread, subject "${mail.subject || ''}".` : `This came in by email, forwarded by ${mail.from}, subject "${mail.subject || ''}".`;
  return `[${how} You are this project's orchestrator. Do not do the work and do not send anything to any tab yet. Read it, pick the one tab best placed to take it, in this project if one fits, otherwise in any of your projects (call list_tabs for the exact names), and say in one or two plain sentences what it is and why that tab. End with a last line exactly "Hand to: Workstream / Tab", or "Hand to: new tab <Name> in <Workstream>" when no tab fits. The person confirms before it goes.]`;
}
// Board 32.3a: the pick, lifted off the answer into the card.
function emailSuggestionFor(task, tab, content) {
  const open = emailOpenFor(task.id, tab.id);
  if (!open) return null;
  const { content: rest, target } = email.takeSuggestion(content);
  if (!target) return null;
  const repo = listRepos().find((row) => row.id === open.projectId) || null;
  let pick = null;
  if (target.newTab) {
    const workstream = target.workstream || task.title || 'Email';
    pick = { newTab: target.newTab, workstream, label: `${workstream} / ${target.newTab}`, tabName: target.newTab };
  } else {
    const row = emailTargetByName(target.name, repo);
    // A name that matches no tab says so, instead of leaving no card at all.
    if (!row) return { content: `${rest ? `${rest}\n\n` : ''}I could not find a tab called "${target.name}". Tell me the tab as Workstream / Tab and I will hand it there.`, confirmation: null };
    pick = { threadId: row.threadId, tabId: row.tabId, label: emailLabel(row), tabName: row.tab };
  }
  open.status = 'confirming';
  open.target = pick;
  open.said = rest;
  email.saveHandoff(open);
  const confirmation = {
    question: `Hand this to ${pick.label}?`,
    confirmLabel: `Hand to ${pick.tabName}`,
    confirmResponse: `Hand to ${pick.tabName}.`,
    declineLabel: 'Other tab',
    declineResponse: 'Other tab. Pick a different one.',
    emailHandoff: open.id,
  };
  // Board 32.5c: the same pick, by email, answered with a yes.
  void emailReply(open, email.suggestEmail({ said: rest, label: pick.label })).catch((err) => console.error('[email] suggestion:', err.message));
  return { content: rest || `I'd hand this to ${pick.label}.`, confirmation };
}
function emailFromAddress(handoff) { return `Supreme <${handoff.prefix || 'supreme'}@${emailDomain()}>`; }
async function emailReply(handoff, text, html = '') {
  // A deal reply's sender is the lender; anything about it goes to the
  // person whose mailbox it is in.
  const to = email.parseAddress(handoff.notify || handoff.email.from).address;
  const sent = await sendEmail({
    from: emailFromAddress(handoff),
    to,
    subject: handoff.email.subject,
    text,
    ...(html ? { html } : {}),
    inReplyTo: (handoff.sent || []).at(-1) || handoff.email.messageId,
    references: [...(Array.isArray(handoff.email.references) ? handoff.email.references : []), handoff.email.messageId, ...(handoff.sent || [])].filter(Boolean),
  });
  const fresh = email.getHandoff(handoff.id) || handoff;
  fresh.sent = [...(fresh.sent || []), sent.messageId];
  email.saveHandoff(fresh);
  Object.assign(handoff, fresh);
  return { to, ...sent };
}
// The brief the tab gets: the email as it came, and the one rule.
function emailBrief(handoff) {
  if (handoff.kind === 'deal_reply') return email.dealBrief({ ...handoff.deal, instructions: handoff.instructions || '' });
  const who = email.parseAddress(handoff.email.from);
  return [
    `Forwarded by email from ${who.name || who.address}, "${handoff.email.subject || ''}":`,
    '',
    String(handoff.email.text || '').trim().slice(0, 12_000),
    '',
    'Handle it here. Anything that would go out to someone waits for their okay: draft it and ask.',
  ].join('\n');
}
// A yes, on the card or by email: the hand-over (board 32.3b).
async function emailConfirm(handoff, { by = 'card', target = null } = {}) {
  if (handoff.status !== 'confirming' && !(target && handoff.status === 'suggesting')) throw Object.assign(new Error('That email is not waiting for a tab.'), { status: 409 });
  let pick = target || handoff.target;
  const orchTask = getTask(handoff.orch.threadId);
  const orchTab = orchTask ? getTab(orchTask, handoff.orch.tabId) : null;
  if (!orchTask || !orchTab) throw Object.assign(new Error('The orchestrator tab is gone.'), { status: 404 });
  if (tabIsRunning(orchTask, orchTab)) throw Object.assign(new Error('The orchestrator is mid turn; try again when it lands.'), { status: 409 });
  if (pick.newTab) {
    const home = tasksOfProject(listRepos().find((row) => row.id === handoff.projectId) || {}).find((row) => row.title.toLowerCase() === String(pick.workstream || '').toLowerCase());
    const homeTask = getTask(home?.id || orchTask.id);
    const made = makeTab({ name: pick.newTab, model: homeTask.model });
    homeTask.tabs = [...(homeTask.tabs || []), made];
    saveTask(homeTask);
    pick = { threadId: homeTask.id, tabId: made.id, label: `${homeTask.title} / ${made.name}`, tabName: made.name };
  }
  const fresh = getTask(orchTask.id);
  const ftab = getTab(fresh, orchTab.id);
  const ts = new Date().toISOString();
  ftab.messages = [...(ftab.messages || []), { id: newId(), role: 'user', content: `Hand to ${pick.tabName}`, ...(by === 'email' ? { fromEmail: { from: handoff.email.from, subject: handoff.email.subject, reply: true } } : {}), ts }];
  bumpSessionCounts(ftab, 1);
  saveTask(fresh);
  handoff.status = 'handed';
  handoff.target = pick;
  email.saveHandoff(handoff);
  const sent = sendTabMessage({ fromTaskId: fresh.id, fromTabId: ftab.id, to: { threadId: pick.threadId, tabId: pick.tabId }, text: emailBrief(handoff), viaEmail: true });
  handoff.tabMessageId = sent.inboundId;
  email.saveHandoff(handoff);
  console.info(`[email] ${handoff.id.slice(0, 8)} handed to ${pick.label} (${by})`);
  return { ok: true, to: pick.label };
}
// The tab's turn after the email landed: report back, then the one email.
async function emailAfterLanding(threadId, tabId) {
  const handoff = [...email.listHandoffs()].reverse().find((row) => row.status === 'handed' && row.target?.threadId === threadId && row.target?.tabId === tabId);
  if (!handoff) return;
  // This is called as the answer is saved, while the run still counts as
  // running; a report sent then would wait in the tab's outbox and land
  // inside its next answer. So it waits for the run to finish first.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const now = getTask(threadId);
    const live = now ? getTab(now, tabId) : null;
    if (!live || !tabIsRunning(now, live)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const task = getTask(threadId);
  const tab = task ? getTab(task, tabId) : null;
  if (!tab) return;
  const messages = tab.messages || [];
  const inAt = messages.findIndex((message) => message.id === handoff.tabMessageId);
  const answerAt = lastAnswerIndex(messages);
  if (inAt < 0 || answerAt < inAt) return;
  const answer = messages[answerAt];
  if (answer.ok === false || answer.stopped) return;
  handoff.status = 'reporting';
  email.saveHandoff(handoff);
  const waiting = !!answer.confirmation;
  const reported = messages.slice(inAt + 1).some((message) => message.role === 'tab' && message.direction === 'out' && message.to?.tabId === handoff.orch.tabId);
  if (!reported) {
    try {
      sendTabMessage({ fromTaskId: threadId, fromTabId: tabId, to: { threadId: handoff.orch.threadId, tabId: handoff.orch.tabId }, text: `${email.summaryOf(answer.content, { max: 600 }) || 'Done.'}${waiting ? ' A draft is waiting on the person here.' : ''}`, replyTo: handoff.tabMessageId, wake: false });
    } catch (err) { console.error('[email] report back:', err.message); }
  }
  // Section 33: a deal reply handed over by an On reply task emails nobody;
  // the draft sitting in the thread is the signal.
  if (handoff.auto) {
    handoff.status = waiting ? 'waiting' : 'done';
    email.saveHandoff(handoff);
    return;
  }
  const label = `${task.title || 'Untitled'} / ${tab.name || 'Untitled'}`;
  const closing = email.closingEmail({ label, answer: answer.content, waiting, link: email.supremeLink(threadId, tabId) });
  let sentTo = '';
  try { sentTo = (await emailReply(handoff, closing.text, closing.html)).to; }
  catch (err) { console.error('[email] closing email:', err.message); }
  const orchTask = getTask(handoff.orch.threadId);
  const orchTab = orchTask ? getTab(orchTask, handoff.orch.tabId) : null;
  if (orchTab && sentTo) {
    orchTab.messages = [...(orchTab.messages || []), { id: newId(), role: 'email', note: true, content: '', emailedTo: sentTo, ts: new Date().toISOString() }];
    bumpSessionCounts(orchTab, 1);
    saveTask(orchTask);
  }
  handoff.status = waiting ? 'waiting' : 'done';
  email.saveHandoff(handoff);
}
// Everything that comes in: the pickup below, and the route the smokes use.
async function emailInbound(mail) {
  if (mail.dealReply && typeof mail.dealReply === 'object') return emailDealReply(mail);
  const from = String(mail.from || '');
  if (!email.isAllowed(from, emailAllowList())) return { status: 403, error: 'Only your own addresses can email Supreme.' };
  const messageId = String(mail.messageId || '').trim();
  if (messageId && email.seenMessage(messageId)) return { status: 200, duplicate: true };
  const replyTo = email.handoffForReply({ inReplyTo: mail.inReplyTo, references: mail.references });
  if (replyTo) {
    replyTo.replies = [...(replyTo.replies || []), messageId].filter(Boolean);
    email.saveHandoff(replyTo);
    const said = email.replyText(mail.text);
    if (email.isYes(said)) return { status: 200, ...(await emailConfirm(replyTo, { by: 'email' })) };
    const named = emailTargetByName(said.split('\n')[0], listRepos().find((row) => row.id === replyTo.projectId));
    if (named) return { status: 200, ...(await emailConfirm(replyTo, { by: 'email', target: { threadId: named.threadId, tabId: named.tabId, label: emailLabel(named), tabName: named.tab } })) };
    // Anything else is for the orchestrator, which picks again.
    replyTo.status = 'suggesting';
    email.saveHandoff(replyTo);
    void emailRunOrchestrator(replyTo, said, false);
    return { status: 200, picking: true };
  }
  const prefix = email.prefixOf(mail.to);
  const repo = emailProjectFor(prefix);
  if (!repo) return { status: 404, error: `No project for ${prefix || 'that address'}@.` };
  const orch = await emailOrchestratorFor(repo);
  const handoff = email.newHandoff({
    prefix,
    projectId: repo.id,
    orch,
    email: { from, to: String(Array.isArray(mail.to) ? mail.to.join(', ') : mail.to || ''), subject: String(mail.subject || '').slice(0, 300), text: String(mail.text || '').slice(0, 20_000), messageId, references: Array.isArray(mail.references) ? mail.references : String(mail.references || '').split(/\s+/).filter(Boolean) },
  });
  void emailRunOrchestrator(handoff, handoff.email.text, true);
  return { status: 200, handoffId: handoff.id, orchestrator: orch };
}
function onReplyTask() {
  for (const schedule of scheduled.replySchedules()) {
    const task = getTask(schedule.threadId);
    const tab = task && !task.archived ? getTab(task, schedule.tabId) : null;
    if (tab && !tab.archived && tab.type !== 'duel') return { schedule, task, tab };
  }
  return null;
}
async function emailDealReply(mail) {
  const given = mail.dealReply;
  const reply = given.reply && typeof given.reply === 'object' ? given.reply : {};
  const messageId = String(mail.messageId || '').trim();
  if (messageId && email.seenMessage(messageId)) return { status: 200, duplicate: true };
  const card = onReplyTask();
  const prefix = email.prefixOf(mail.to) || 'vime';
  const repo = card
    ? listRepos().find((row) => (card.task.projectId && row.id === card.task.projectId) || row.path === card.task.repo) || emailProjectFor(prefix)
    : emailProjectFor(prefix);
  if (!repo) return { status: 404, error: `No project for ${prefix}@.` };
  const orch = await emailOrchestratorFor(repo);
  const from = reply.from && typeof reply.from === 'object' ? reply.from : {};
  const handoff = email.newHandoff({
    kind: 'deal_reply',
    prefix,
    projectId: repo.id,
    orch,
    notify: String(reply.mailbox || '').toLowerCase(),
    deal: { reply, deal: given.deal && typeof given.deal === 'object' ? given.deal : {}, dryRun: given.dry_run === true },
    ...(card ? { auto: true, scheduleId: card.schedule.id, instructions: card.schedule.instructions } : {}),
    email: { from: from.name ? `${from.name} <${from.email || mail.from}>` : String(from.email || mail.from || ''), to: String(mail.to || ''), subject: String(reply.subject || mail.subject || '').slice(0, 300), text: String(reply.text || mail.text || '').slice(0, 20_000), messageId, references: [] },
  });
  if (!card) {
    void emailRunOrchestrator(handoff, handoff.email.text, true);
    return { status: 200, handoffId: handoff.id, orchestrator: orch, picking: true };
  }
  void emailHandDealReply(handoff, card).catch((err) => console.error('[email] deal reply:', err.message));
  return { status: 200, handoffId: handoff.id, orchestrator: orch, handing: addressName(addressOf(card.task, card.tab)) };
}
async function emailHandDealReply(handoff, card) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const task = getTask(handoff.orch.threadId);
    const tab = task ? getTab(task, handoff.orch.tabId) : null;
    if (!tab) return;
    if (!tabIsRunning(task, tab)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const otask = getTask(handoff.orch.threadId);
  const otab = otask ? getTab(otask, handoff.orch.tabId) : null;
  if (!otab) return;
  const ts = new Date().toISOString();
  const tabName = card.tab.name || 'Untitled';
  otab.messages = [
    ...(otab.messages || []),
    { id: newId(), role: 'user', content: handoff.email.text, fromEmail: { from: handoff.email.from, subject: handoff.email.subject, vime: true }, ts },
    { id: newId(), role: 'assistant', content: email.dealLine({ ...handoff.deal, tabName }), workNotes: [], model: otab.model || otask.model, requestedModel: otab.model || otask.model, ts, ok: true, tools: [], computer: null, connectors: [] },
  ];
  bumpSessionCounts(otab, 2);
  saveTask(otask);
  const target = { threadId: card.task.id, tabId: card.tab.id, label: `${card.task.title || 'Untitled'} / ${tabName}`, tabName };
  const sent = sendTabMessage({ fromTaskId: otask.id, fromTabId: otab.id, to: { threadId: target.threadId, tabId: target.tabId }, text: emailBrief(handoff), viaEmail: true });
  const fresh = email.getHandoff(handoff.id) || handoff;
  fresh.status = 'handed';
  fresh.target = target;
  fresh.tabMessageId = sent.inboundId;
  email.saveHandoff(fresh);
  scheduled.recordFire(card.schedule.id, { dueAt: handoff.deal.reply?.sent_at || ts, ranAt: ts }, { clearPending: true });
  console.info(`[email] deal reply ${handoff.id.slice(0, 8)} handed to ${target.label} (on reply)`);
}
// The orchestrator's turn, through the service's own run route the way a
// wake or a schedule is, so every window sees it as any run.
async function emailRunOrchestrator(handoff, text, first) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const task = getTask(handoff.orch.threadId);
    const tab = task ? getTab(task, handoff.orch.tabId) : null;
    if (!tab) return;
    if (!tabIsRunning(task, tab)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${handoff.orch.threadId}/tabs/${handoff.orch.tabId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: String(text || '').trim() || '(no text)', ...(first ? { email: { handoffId: handoff.id } } : {}) }),
  }).catch((err) => { console.error('[email] orchestrator run:', err.message); return null; });
  if (!response) return;
  if (!response.ok) { console.error(`[email] orchestrator run refused ${response.status}: ${(await response.text()).slice(0, 200)}`); return; }
  for await (const _chunk of response.body) { /* the run writes its own transcript */ }
}
function slackLabelOf(task, tab) {
  return `${task.title || task.repoName || 'Untitled'} / ${tab.name || 'Untitled'}`;
}
function slackAnswerSections(text) {
  // A section allows 3,000 characters. A longer displayed answer must not
  // silently lose its last paragraph when blocks override the fallback text.
  const shown = String(text).slice(0, 3_500);
  const sections = [];
  for (let at = 0; at < shown.length; at += 2_900) sections.push({ type: 'section', text: { type: 'mrkdwn', text: shown.slice(at, at + 2_900) } });
  return sections;
}
function rememberSlackChannelTab(channel, threadId, tabId) {
  if (!channel) return;
  const settings = getSettings();
  const slack = settings.slack && typeof settings.slack === 'object' ? settings.slack : {};
  settings.slack = { ...slack, lastPicked: { ...(slack.lastPicked || {}), [channel]: { threadId, tabId, at: new Date().toISOString() } } };
  saveSettings(settings);
}
function rememberedSlackChannelTab(channel, scope = null) {
  const row = getSettings().slack?.lastPicked?.[channel];
  if (!row) return null;
  return allTabDestinations(scope).find((candidate) => candidate.threadId === row.threadId && candidate.tabId === row.tabId) || null;
}
// The guess, offered: the likeliest tab first, then the next few, each a
// button. Naming a tab in a new mention still works instead.
async function offerSlackTabs({ channel, channelName, threadTs, event, text, userName, all = false, scope = null }) {
  const parent = event.thread_ts && event.thread_ts !== event.ts ? await slackThreadParent(channel, event.thread_ts) : null;
  const read = [text, parent ? slackPlainText(parent.text) : ''].filter(Boolean).join('\n');
  const tasks = listTasks().filter((row) => !row.archived && (!scope || (row.projectId && scope.has(row.projectId)))).map((row) => getTask(row.id)).filter(Boolean);
  const guesses = guessTabs({ text: read, tasks });
  if (!guesses.length) {
    const none = scope ? 'No Supreme project here is shared with you yet, so I cannot take this.' : 'There is no open tab to send this to yet. Make one in Supreme, then mention me again.';
    await slackPostInThread(channel, threadTs, none).catch(() => {});
    return;
  }
  const remembered = rememberedSlackChannelTab(channel, scope);
  const best = remembered || guesses[0];
  const sure = best.hits > 0;
  const line = remembered
    ? `Which tab should take this? Last time in #${channelName || channel} it was ${best.workstream} / ${best.tab}.`
    : sure
      ? `Which tab should take this? My best guess is ${best.workstream} / ${best.tab}.`
      : `Which tab should take this? Nothing here matches a tab yet; ${best.workstream} / ${best.tab} is the most recent.`;
  // The guess is one button, and every other tab is in the dropdown beside
  // it, grouped by workstream, so the exact tab is a pick and not a retype.
  // (Every element in one row needs its own action id: real Slack refused
  // a row of four "supreme_tab" buttons as invalid_blocks, 2026-09-21.)
  const select = slackTabSelect('supreme_tab_pick', 'Another tab', scope);
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: line } },
    slackActionsBlock([slackButton(`${best.workstream} / ${best.tab}`, 'supreme_tab_0', { k: 'tab', t: best.threadId, b: best.tabId }, true), ...(select ? [select] : [])]),
  ];
  const posted = await slackPostInThread(channel, threadTs, `${line} Or name another tab in a new mention.`, blocks);
  const askTs = String(posted?.ts || '');
  if (askTs) slackPendingAsks.set(slackThreadKey(channel, askTs), { text, threadTs, channel, user: String(event.user || ''), userName, files: Array.isArray(event.files) ? event.files : [], ts: String(event.ts || ''), threadParentTs: event.thread_ts && event.thread_ts !== event.ts ? String(event.thread_ts) : '', all, at: Date.now() });
  console.info(`[slack] mention named no tab; offered ${guesses.map((row) => `${row.workstream} / ${row.tab}`).join(', ')}`);
}
// The turn itself, and its answer back into the thread. An answer that
// stops to ask (a draft, "shall I send it?") comes with Send and Don't send;
// the person's press is the reply the Confirm row would have sent.
// Authorized participants in the active Slack thread use provider-native
// steering. Unrelated threads and models that refuse steering keep the FIFO
// full-turn queue. A Send/approval button is always its own explicit turn.
const slackTurnQueue = new Map();
// Short input decisions are FIFO too, independently of the full-turn queue.
// Waiting on a complete answer here would prevent the next input steering it.
const slackInputQueue = new Map();
const slackWaitingTurns = new Map();
const slackActiveTurns = new Map();
const SLACK_TURN_WAIT_MS = 10 * 60_000;
async function runSlackTurn(args) {
  const key = `${args.task.id}::${args.tab.id}`;
  const threadKey = slackThreadKey(args.channel, args.threadTs);
  slackThreadInputs.delete(threadKey);
  slackThreadInputs.set(threadKey, { taskId: args.task.id, tabId: args.tab.id, ts: args.ts, connection: slackConnectionKey() });
  if (slackThreadInputs.size > 500) slackThreadInputs.delete(slackThreadInputs.keys().next().value);
  const priorInput = slackInputQueue.get(key) || Promise.resolve();
  const dispatch = priorInput.catch(() => {}).then(async () => {
    if (!slackWaitingTurns.get(key) && await steerSlackTurn(args)) return { done: Promise.resolve(true) };
    return { done: queueSlackTurn(args) };
  });
  slackInputQueue.set(key, dispatch);
  try { return await (await dispatch).done; }
  catch (error) {
    console.warn(`[slack] follow-up: ${error.message}`);
    await slackPostInThread(args.channel, args.threadTs, 'I could not add that follow-up. Check the current run in Supreme before sending it again.').catch(() => {});
    return false;
  }
  finally { if (slackInputQueue.get(key) === dispatch) slackInputQueue.delete(key); }
}
async function steerSlackTurn(args) {
  if (args.announce === false || args.lead) return false; // approval buttons keep their own turn
  const key = `${args.task.id}::${args.tab.id}`;
  const starting = slackActiveTurns.get(key);
  const same = from => from && from.channel === args.channel && from.threadTs === args.threadTs;
  let run = [...runs.values()].find(row => row.taskId === args.task.id && row.tabId === args.tab.id);
  // A burst can arrive between "On it" and provider initialization. Wait
  // briefly for that same request, not for an unrelated turn to finish.
  if (same(starting)) {
    const deadline = Date.now() + 1_500;
    while ((!run || typeof run.control?.steer !== 'function') && slackActiveTurns.get(key) === starting && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
      run = [...runs.values()].find(row => row.taskId === args.task.id && row.tabId === args.tab.id);
    }
  }
  const from = run?.slackFrom;
  if (!from || from.channel !== args.channel || from.threadTs !== args.threadTs || !slackMayUse(await slackScopeFor(args.user), args.task)) return false;
  const requestId = `slack-${createHash('sha256').update(`${args.channel}:${args.ts}`).digest('hex').slice(0, 32)}`;
  const response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${args.task.id}/tabs/${args.tab.id}/steer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: run.id, requestId, prompt: args.prompt, images: args.attachments,
      slack: { channel: args.channel, threadTs: args.threadTs, ts: args.ts, user: { id: args.user } } }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409 && result.queue) return false;
    throw new Error(result.error || 'Could not add the Slack follow-up');
  }
  if (!run.slackSteeringReceipt && runs.has(run.id) && run.acceptingSteers !== false) {
    run.slackSteeringReceipt = true;
    await slackPostInThread(args.channel, args.threadTs, 'Added to the current run.').catch(() => {});
  }
  return true;
}
async function queueSlackTurn(args) {
  const key = `${args.task.id}::${args.tab.id}`;
  // Told at once when it will have to wait, whether for a turn already in
  // the tab or for the Slack asks queued ahead of it.
  const current = getTask(args.task.id);
  const live = current ? getTab(current, args.tab.id) : null;
  const busy = slackTurnQueue.has(key) || !!(live && tabIsRunning(current, live));
  // The place in the queue is taken before anything is awaited, so two asks
  // keep the order they were made in.
  const previous = slackTurnQueue.get(key) || Promise.resolve();
  slackWaitingTurns.set(key, (slackWaitingTurns.get(key) || 0) + 1);
  const next = previous.catch(() => {}).then(() => {
    const remaining = (slackWaitingTurns.get(key) || 1) - 1;
    if (remaining) slackWaitingTurns.set(key, remaining); else slackWaitingTurns.delete(key);
    return runSlackTurnNow({ ...args, told: busy });
  });
  slackTurnQueue.set(key, next);
  if (busy && args.announce !== false) await slackPostInThread(args.channel, args.threadTs, `${slackLabelOf(args.task, args.tab)} is mid turn; this runs when it is free.`).catch(() => {});
  try { return await next; } finally { if (slackTurnQueue.get(key) === next) slackTurnQueue.delete(key); }
}
// The thread's own mark: thinking while its turn runs, a green check once
// the answer is under it. A Send or Don't send press runs the tab again, so
// the check gives way to thinking until that turn lands too.
async function slackThinking(channel, threadTs) {
  await slackReact(channel, threadTs, 'white_check_mark', false);
  await slackReact(channel, threadTs, 'thinking_face', true);
}
async function slackDoneMark(channel, threadTs, ok = true) {
  await slackReact(channel, threadTs, 'thinking_face', false);
  if (ok) await slackReact(channel, threadTs, 'white_check_mark', true);
}
async function runSlackTurnNow(args) {
  const activity = { finish: null, status: 'active' };
  const key = `${args.task.id}::${args.tab.id}`;
  slackActiveTurns.set(key, args);
  try { return await runSlackTurnBody({ ...args, activity }); }
  catch (err) {
    console.warn(`[slack] turn: ${err.message}`);
    await slackPostInThread(args.channel, args.threadTs, 'I could not finish this request. Any work so far is saved in Supreme, check it before asking me to try again.').catch(() => {});
    await slackDoneMark(args.channel, args.threadTs, false);
    return false;
  } finally {
    if (slackActiveTurns.get(key) === args) slackActiveTurns.delete(key);
    if (activity.finish) await activity.finish(activity.status);
  }
}
async function runSlackTurnBody({ task, tab, prompt, attachments, channel, threadTs, ts, user, userName, channelName, lead = null, announce = true, told = false, activity }) {
  const label = slackLabelOf(task, tab);
  const ownThread = task.origin === 'slack';
  const contextLink = { type: 'context', elements: [{ type: 'mrkdwn', text: `<${email.supremeLink(task.id, tab.id)}|Open in Supreme>` }] };
  const startedWaiting = Date.now();
  let response = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (;;) {
      const current = getTask(task.id);
      const live = current ? getTab(current, tab.id) : null;
      if (!live) {
        await slackPostInThread(channel, threadTs, `${label} is gone. Mention me again and name another tab.`).catch(() => {});
        return false;
      }
      if (!tabIsRunning(current, live)) break;
      if (!told && announce) {
        told = true;
        await slackPostInThread(channel, threadTs, `${label} is mid turn; this runs when it is free.`).catch(() => {});
      }
      if (Date.now() - startedWaiting > SLACK_TURN_WAIT_MS) {
        await slackPostInThread(channel, threadTs, `Could not run that in ${label}: it has been busy for ${Math.round(SLACK_TURN_WAIT_MS / 60_000)} minutes. Mention me again later.`).catch(() => {});
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (announce && attempt === 0) {
      const text = ownThread ? 'On it.' : `On it, in ${label}.`;
      await slackPostInThread(channel, threadTs, text, [{ type: 'section', text: { type: 'mrkdwn', text } }, contextLink]).catch(() => {});
    }
    if (attempt === 0) {
      activity.finish = await slackActivity.begin({ channel, threadTs, title: task.title });
      await slackThinking(channel, threadTs);
    }
    response = await fetch(`http://127.0.0.1:${PORT}/api/tasks/${task.id}/tabs/${tab.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, images: attachments, slack: { channel, channelName, ts, threadTs, user: { id: user, name: userName } } }),
    });
    if (response.ok) break;
    const payload = await response.json().catch(() => ({}));
    // Someone started a turn between the look and the send: wait again.
    if (/already running/i.test(String(payload.error || '')) && attempt < 2) { response = null; continue; }
    await slackPostInThread(channel, threadTs, `Could not run that in ${label}: ${payload.error || response.status}.`).catch(() => {});
    await slackDoneMark(channel, threadTs, false);
    return false;
  }
  if (!response) { await slackDoneMark(channel, threadTs, false); return false; }
  await response.text();
  const after = getTask(task.id);
  const landed = after ? getTab(after, tab.id) : null;
  const messages = landed?.messages || [];
  const askedAt = messages.findLastIndex((message) => message.role === 'user' && message.fromSlack?.channel === channel && message.fromSlack?.ts === ts);
  const afterAsk = askedAt < 0 ? [] : messages.slice(askedAt + 1);
  // Steers belong to this answer too, not a new independently queued turn.
  const nextAsk = afterAsk.findIndex((message) => message.role === 'user' && !message.steered);
  const answer = (nextAsk < 0 ? afterAsk : afterAsk.slice(0, nextAsk)).findLast((message) => message.role === 'assistant' && !message.interim);
  const reply = !answer
    ? `No answer came back in ${label}. Check the thread in Supreme before retrying.`
    : answer.ok === false
      ? `That turn failed in ${label}: ${answer.error || 'unknown error'}.`
      : answer.stopped
        ? `Stopped in ${label}. Any work so far is saved in Supreme.`
      : String(answer.content || '').trim() || `Done in ${label}, nothing written back.`;
  const confirmation = answer && answer.ok !== false && !answer.stopped ? (answer.confirmation || confirmationRequest(answer.content)) : null;
  const shown = slackMrkdwn(reply);
  if (!confirmation) {
    const text = ownThread ? shown.slice(0, 3_500) : `${shown.slice(0, 3_500)}\n_Answered in Supreme, ${label}_`;
    await slackPostInThread(channel, threadTs, text, [...slackAnswerSections(shown), contextLink]);
    const ok = !!answer && answer.ok !== false && !answer.stopped;
    await slackDoneMark(channel, threadTs, ok);
    return ok;
  }
  // Under a lead's own post the yes and the no name the lead, so the tab
  // sends that one reply whatever it has drafted since (reply to all runs
  // the leads one after another in one tab).
  const who = lead ? `${lead.name}${lead.email ? ` (${lead.email})` : ''}` : '';
  const yes = lead ? `Send the reply to ${who} now.` : confirmation.confirmResponse;
  const no = lead ? `Do not send the reply to ${who}; leave it as a draft.` : confirmation.declineResponse;
  const sending = !!lead || /^(?:send|email|message|dm|reply|forward)\b/i.test(confirmation.question || '');
  const footer = sending ? `_Drafted in Supreme, ${label}${lead ? `, for ${lead.name}` : ''}. Nothing has been sent._` : '_Waiting for your approval._';
  const blocks = [
    ...slackAnswerSections(shown),
    { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
    contextLink,
    slackActionsBlock([
      slackButton(sending ? 'Send' : 'Confirm', 'supreme_send', { k: sending ? 'send' : 'approve', t: task.id, b: tab.id, r: yes }, true),
      ...(sending ? [slackButton('Edit', 'supreme_edit', { k: 'edit', t: task.id, b: tab.id, ...(who ? { l: who } : {}) })] : []),
      slackButton(sending ? "Don't send" : 'Not yet', 'supreme_hold', { k: 'hold', t: task.id, b: tab.id, r: no, ...(sending ? {} : { approval: true }) }),
    ]),
  ];
  await slackPostInThread(channel, threadTs, `${shown.slice(0, 3_500)}\n${footer}`, blocks);
  activity.status = 'suspended';
  await slackDoneMark(channel, threadTs);
  return true;
}
const SLACK_REPLY_ALL = /^\s*(?:(?:please|pls|can you|could you)\s+)?(?:reply|respond|answer|draft(?:\s+(?:a\s+)?repl(?:y|ies))?)\s+(?:to\s+)?(?:all|each|every(?:one|thing)?|them all|all of them)\b/i;
const SLACK_REPLY_ALL_DAYS = 7;
const SLACK_REPLY_ALL_MAX = 20;
function slackReplyAllAsk(text) { return SLACK_REPLY_ALL.test(String(text || '')); }
// The person a post is about: the email in it, and the line before the
// email when it reads as a name.
function slackLeadOf(text) {
  const plain = slackPlainText(text);
  const email = plain.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  if (!email) return null;
  const lines = plain.split('\n').map((line) => line.trim()).filter(Boolean);
  const at = lines.findIndex((line) => line.includes(email));
  const before = at > 0 ? lines[at - 1].replace(/^[*_~`]+|[*_~`]+$/g, '').trim() : '';
  const name = /^[A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*){1,3}$/.test(before) && !/\b(?:reply|subject|campaign|inbox)\b/i.test(before) ? before : email;
  return { email: email.toLowerCase(), name };
}
async function slackLeadPosts(channel, { exceptTs = '' } = {}) {
  const botUserId = await slackBotUserId();
  const oldest = String(Math.floor(Date.now() / 1000) - SLACK_REPLY_ALL_DAYS * 86_400);
  const history = await slackChannelHistory(channel, { oldest });
  const leads = [];
  for (const message of history) {
    if (!message?.ts || message.ts === exceptTs) continue;
    if (message.thread_ts && message.thread_ts !== message.ts) continue;
    if (botUserId && message.user === botUserId) continue;
    if (message.subtype && message.subtype !== 'bot_message') continue;
    const lead = slackLeadOf(message.text);
    if (!lead) continue;
    leads.push({ ts: String(message.ts), user: String(message.user || ''), poster: String(message.bot_profile?.name || message.username || ''), text: String(message.text || ''), files: Array.isArray(message.files) ? message.files : [], lead });
  }
  leads.sort((a, b) => Number(a.ts) - Number(b.ts));
  const open = [];
  const answered = [];
  for (const post of leads.slice(-SLACK_REPLY_ALL_MAX)) {
    const thread = await slackThreadMessages(channel, post.ts).catch(() => []);
    const done = thread.some((message) => message.ts !== post.ts && botUserId && message.user === botUserId);
    (done ? answered : open).push(post);
  }
  return { open, answered };
}
async function runSlackReplyAll({ task, tab, channel, channelName, threadTs, exceptTs, user, userName }) {
  const label = slackLabelOf(task, tab);
  const { open, answered } = await slackLeadPosts(channel, { exceptTs });
  const names = (rows) => rows.map((post) => post.lead.name).join(', ');
  if (!open.length) {
    await slackPostInThread(channel, threadTs, `No lead replies in #${channelName || channel} from the last ${SLACK_REPLY_ALL_DAYS} days that I have not answered under${answered.length ? ` (${names(answered)} already ${answered.length === 1 ? 'has' : 'have'} one)` : ''}.`).catch(() => {});
    return;
  }
  await slackPostInThread(channel, threadTs, `Drafting a reply for each, under their posts, in ${label}: ${names(open)}.${answered.length ? ` ${names(answered)} already ${answered.length === 1 ? 'has' : 'have'} one.` : ''}`).catch(() => {});
  console.info(`[slack] reply to all in ${channelName} by ${userName} -> ${label}: ${open.length} lead(s), ${answered.length} already answered`);
  let up = 0;
  const missed = [];
  for (const post of open) {
    rememberSlackTab(channel, post.ts, task.id, tab.id);
    const posterName = post.poster || (post.user ? await slackUserName(post.user) : 'someone');
    const postText = slackPlainText(post.text);
    const prompt = `Reply to this.\n\nIn reply to ${posterName} in Slack: "${postText}"`;
    const attachments = [];
    for (const file of post.files.slice(0, 5)) {
      const attachment = await slackFileAttachment(file).catch(() => null);
      if (attachment) attachments.push(attachment);
    }
    const ok = await runSlackTurn({ task, tab, prompt, attachments, channel, threadTs: post.ts, ts: post.ts, user, userName, channelName, lead: post.lead, announce: false });
    if (ok) up += 1; else missed.push(post.lead.name);
  }
  const line = `${up} draft${up === 1 ? ' is' : 's are'} up, one under each post, each with its own Send.${missed.length ? ` Not drafted: ${missed.join(', ')}.` : ''}`;
  await slackPostInThread(channel, threadTs, line).catch(() => {});
}
// Mentions reach a tab's queue in the order they were made: the reading
// before a run (who asked, which channel, the thread's first message) is
// done one mention at a time, and the next mention is read once this one
// has its place in the queue.
let slackInbound = Promise.resolve();
async function handleSlackMention(event, options = {}) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => { resolve(); options.onRouted?.(); }; });
  const previous = slackInbound;
  slackInbound = previous.then(() => gate);
  await previous;
  try {
    const botId = await slackBotUserId();
    if (!event.user || event.user === botId || event.bot_id || event.edited || (event.subtype && event.subtype !== 'file_share')) return;
    const followup = event.type === 'message' && event.channel_type !== 'im' && !String(event.text || '').includes(`<@${botId}>`);
    if (followup) {
      if (!event.thread_ts || event.thread_ts === event.ts || (!relayedSlackFollowupAllowed(event)
        && !await slackFollowupAllowed({ channel: event.channel, threadTs: event.thread_ts, user: event.user })
        && !(options.relayed !== true && await slackTeammateThreadFollowup(event)))) return;
      if (slackThreadAcknowledgment(event.text, event.files)) return;
    }
    // Claim inside the existing FIFO gate: asynchronous bot lookup must not
    // reorder requests. Socket and relay copies share the durable receipt.
    if (!claimSlackRequest({ home: DATA_DIR, botId, channel: event.channel, ts: event.ts })) return;
    await handleSlackMentionNow(event, release, { ...options, followup });
  } finally { release(); }
}
// What a mention inside a thread answers: the thread's first message, then
// every reply under it from before the mention, so a result someone posted
// in the thread reaches the tab. Supreme's own posts are left out.
const SLACK_THREAD_REPLIES_MAX = 20;
const SLACK_THREAD_REPLY_CHARS = 6_000;
async function slackThreadBefore(channel, threadTs, mentionTs, afterTs = '') {
  const out = { text: '', files: [] };
  let error = null;
  const page = await slackThreadPage(channel, threadTs, { latest: mentionTs, limit: 200 }).catch(failure => { error = failure; return null; });
  let messages = page?.messages;
  if (!messages) {
    const parent = await slackThreadParent(channel, threadTs);
    messages = parent ? [parent] : [];
  }
  if (!messages.length && error) { out.text = `\n\nSlack thread context: ${slackContextError(error)}`; return out; }
  const parent = messages[0];
  if (!parent || parent.ts === mentionTs) return out;
  if (!afterTs) {
    const parentName = parent.user ? await slackUserName(parent.user) : String(parent.bot_profile?.name || parent.username || 'someone');
    const original = slackMessageText(parent);
    const parentText = original.slice(0, SLACK_CONTEXT_MESSAGE_CHARS);
    if (parentText) out.text += `\n\nIn reply to ${parentName} in Slack: "${parentText}"${original.length > parentText.length ? ' [excerpt truncated]' : ''}`;
    if (Array.isArray(parent.files)) out.files.push(...parent.files);
  }
  const botUserId = await slackBotUserId();
  const replies = messages.slice(1)
    .filter((message) => message.ts !== mentionTs && (!mentionTs || Number(message.ts) < Number(mentionTs)))
    .filter((message) => !afterTs || Number(message.ts) > Number(afterTs))
    .filter((message) => !(botUserId && message.user === botUserId))
    .slice(-SLACK_THREAD_REPLIES_MAX);
  const lines = [];
  let chars = out.text.length;
  let clipped = !!page?.hasMore;
  for (const message of [...replies].reverse()) {
    const text = slackMessageText(message).slice(0, SLACK_THREAD_REPLY_CHARS);
    if (!text && !message.files?.length) continue;
    const name = message.user ? await slackUserName(message.user) : String(message.bot_profile?.name || message.username || 'someone');
    const line = `${name}: "${text}"`;
    if (chars + line.length + 2 > SLACK_CONTEXT_MAX_CHARS - 350) { clipped = true; continue; }
    chars += line.length + 2;
    lines.unshift(line);
    if (Array.isArray(message.files)) out.files.push(...message.files);
  }
  if (lines.length) out.text += `\n\nThe replies under it in that thread, oldest first:\n${lines.join('\n\n')}`;
  if (clipped) out.text += '\n\nThis thread excerpt is bounded. Use read_slack_context or a connected Slack search for an earlier exact message if needed.';
  out.files = out.files.slice(0, 5);
  return out;
}
// What a forwarded Slack message carries: Slack puts the original in an
// attachment marked as a share, with who wrote it and where.
function slackForwardedText(event) {
  const rows = [];
  for (const item of Array.isArray(event.attachments) ? event.attachments : []) {
    if (!(item.is_share || item.is_msg_unfurl || item.from_url)) continue;
    const said = slackPlainText(item.text || item.fallback || '');
    if (!said) continue;
    const who = String(item.author_name || item.author_subname || 'someone');
    const where = item.channel_name ? ` in #${item.channel_name}` : '';
    rows.push(`Forwarded from ${who}${where}: "${said}"`);
  }
  return rows.join('\n\n');
}
async function handleSlackMentionNow(event, release, { relayed = false, followup = false } = {}) {
  const prefs = slackPrefs();
  if (!prefs.botToken) return;
  const channel = String(event.channel || '');
  const threadTs = String(event.thread_ts || event.ts || '');
  // A teammate with Supreme of their own: it runs on their Mac, with their
  // tabs and their model accounts, not here.
  if (!relayed) {
    const askerEmail = await slackUserEmail(event.user);
    const teammate = !slackIsMeUser(event.user, askerEmail) ? slackTeammateFor(askerEmail) : null;
    if (teammate && await relaySlack({ teammate, kind: 'mention', payload: { event }, channel, threadTs, say: followup ? '' : 'Passing this to {mac}.' })) {
      // The listening Mac needs only a subscription to forward this person's
      // replies. The receiving Mac still verifies the real message and route.
      rememberSlackRelayThread(channel, threadTs, String(event.user || ''));
      return;
    }
  }
  const botMention = String(event.text || '').match(/^\s*<@([A-Z0-9]+)>/)?.[1] || '';
  const typed = slackPlainText(event.text, botMention);
  // A message forwarded to Supreme rides along with whatever was typed over
  // it; the tab is only ever read from the typed part.
  const forwarded = slackForwardedText(event);
  const text = [typed, forwarded].filter(Boolean).join('\n\n');
  const [userName, channelName, scope] = await Promise.all([slackUserName(event.user), slackChannelName(channel), slackScopeFor(event.user)]);
  let target = followup ? null : resolveSlackTab(typed, scope);
  if (target && forwarded) target = { ...target, rest: [target.rest, forwarded].filter(Boolean).join('\n\n') };
  // A tab named in the mention is a pick for that channel too.
  const named = !!target;
  const inThread = !!(event.thread_ts && event.thread_ts !== event.ts);
  const all = !inThread && slackReplyAllAsk(target ? target.rest : text);
  // A thread that already has its tab keeps it.
  if (!target) {
    const known = rememberedSlackThread(channel, threadTs);
    if (known) {
      const knownTask = getTask(known.threadId);
      const knownTab = knownTask?.tabs?.find((tab) => tab.id === known.tabId);
      if (knownTask && !knownTask.archived && knownTab && !knownTab.done && slackMayUse(scope, knownTask)) target = { row: { threadId: known.threadId, tabId: known.tabId }, rest: text };
    }
  }
  if (!target && followup && (scope !== null || !prefs.startNewThreads)) return;
  if (!target && !all && !scope && prefs.startNewThreads) {
    // A misspelled explicit address should not silently start somewhere else.
    if (/^\s*\[[^\]]+\]/.test(typed)) {
      await offerSlackTabs({ channel, channelName, threadTs, event, text, userName, all, scope });
      return;
    }
    try { target = await newSlackThread({ channel, threadTs, channelName, user: String(event.user || ''), text, event }); }
    catch (err) {
      console.warn(`[slack] new thread: ${err.message}`);
      await slackPostInThread(channel, threadTs, 'I could not start a thread. Open Supreme and check that a model is connected, then mention me again.').catch(() => {});
      return;
    }
  }
  if (!target) {
    await offerSlackTabs({ channel, channelName, threadTs, event, text, userName, all, scope });
    return;
  }
  const task = getTask(target.row.threadId);
  const tab = task ? getTab(task, target.row.tabId) : null;
  if (!task || !tab || !slackMayUse(scope, task)) return;
  rememberSlackTab(channel, threadTs, task.id, tab.id);
  if (named) rememberSlackChannelTab(channel, task.id, tab.id);
  const label = slackLabelOf(task, tab);
  if (all) {
    await runSlackReplyAll({ task, tab, channel, channelName, threadTs, exceptTs: String(event.ts || ''), user: String(event.user || ''), userName });
    return;
  }
  let prompt = target.rest || text;
  const attachments = [];
  const bring = async (files) => {
    for (const file of (Array.isArray(files) ? files : []).slice(0, 5)) {
      const attachment = await slackFileAttachment(file).catch(() => null);
      if (attachment) attachments.push(attachment);
    }
  };
  if (event.thread_ts && event.thread_ts !== event.ts) {
    const previous = tab.messages?.findLast(message => message.role === 'user' && message.fromSlack?.channel === channel && message.fromSlack?.threadTs === event.thread_ts);
    const active = [...runs.values()].find(run => run.taskId === task.id && run.tabId === tab.id && run.slackFrom?.channel === channel && run.slackFrom.threadTs === event.thread_ts);
    const received = slackThreadInputs.get(slackThreadKey(channel, event.thread_ts));
    const cursor = received?.connection === slackConnectionKey() && received.taskId === task.id && received.tabId === tab.id ? received : null;
    const latest = cursor || active?.steers?.findLast(steer => steer.slackFrom)?.slackFrom || active?.slackFrom || previous?.fromSlack;
    const before = await slackThreadBefore(channel, event.thread_ts, String(event.ts || ''), latest?.ts || '');
    prompt += before.text;
    await bring(before.files);
  } else {
    const recent = await slackGroupBackground(task, channel, String(event.ts || ''));
    prompt += recent.warning ? `\n\nSlack conversation context: ${recent.warning}` : recent.text;
  }
  await bring(event.files);
  console.info(`[slack] mention in ${channelName} by ${userName} -> ${label}${attachments.length ? ` with ${attachments.length} file(s)` : ''}`);
  const turn = runSlackTurn({ task, tab, prompt, attachments, channel, threadTs, ts: String(event.ts || ''), user: String(event.user || ''), userName, channelName });
  release();
  await turn;
}
// A button under one of the bot's messages: a tab picked for a mention that
// named none, or Send / Don't send under a draft.
const SLACK_EDIT_VIEW = 'supreme_edit';
async function handleSlackAction(payload, action, { relayedFrom = '' } = {}) {
  const prefs = slackPrefs();
  if (!prefs.botToken) return;
  if (payload.type === 'view_submission') return handleSlackEditSubmit(payload, { relayedFrom });
  // A press under a teammate's Mac's buttons goes back to that Mac.
  const runner = relayedFrom ? '' : slackRunnerOf(action);
  const elsewhere = !!runner && runner !== slackRelayMe();
  let value = null;
  // A button carries JSON; a dropdown pick carries the two ids joined.
  const picked = action.selected_option?.value;
  if (picked) {
    const [t, b] = String(picked).split('|');
    value = { k: 'tab', t, b };
  } else {
    try { value = JSON.parse(action.value || '{}'); } catch { return; }
  }
  const channel = String(payload.channel?.id || payload.container?.channel_id || '');
  const messageTs = String(payload.message?.ts || payload.container?.message_ts || '');
  const threadTs = String(payload.message?.thread_ts || messageTs);
  // Edit opens its box at once: Slack's trigger lasts three seconds, so
  // nothing is looked up first.
  if (value.k === 'edit') {
    const view = {
      type: 'modal',
      callback_id: SLACK_EDIT_VIEW,
      private_metadata: JSON.stringify({ t: value.t, b: value.b, l: value.l || '', c: channel, m: messageTs, h: threadTs, ...(elsewhere ? { r: runner } : {}) }).slice(0, 3_000),
      title: { type: 'plain_text', text: 'Edit draft', emoji: false },
      submit: { type: 'plain_text', text: 'Redraft', emoji: false },
      close: { type: 'plain_text', text: 'Cancel', emoji: false },
      blocks: [{ type: 'input', block_id: 'edit', label: { type: 'plain_text', text: 'What should change?', emoji: false }, element: { type: 'plain_text_input', action_id: 'text', multiline: true } }],
    };
    await slackCall('views.open', { trigger_id: String(payload.trigger_id || ''), view: JSON.stringify(view) }).catch((err) => console.warn(`[slack] edit box: ${err.message}`));
    return;
  }
  if (elsewhere) {
    // Whether the person pressing is that Mac's own, or someone else there
    // who only reaches what is shared with them.
    await relaySlack({ teammate: { userId: runner, name: '' }, kind: 'action', payload: { payload, action }, channel: '', threadTs });
    return;
  }
  const userId = String(payload.user?.id || '');
  const userName = await slackUserName(userId);
  const channelName = await slackChannelName(channel);
  const task = getTask(String(value.t || ''));
  const tab = task ? getTab(task, String(value.b || '')) : null;
  if (!task || !tab) {
    await slackUpdateMessage(channel, messageTs, 'That tab is gone. Mention me again and name another.').catch(() => {});
    return;
  }
  // A button in a shared channel can be pressed by anyone in it: the tab
  // behind it has to be one that person may use.
  // A real pending ask does not authenticate the person choosing its target.
  // Every relayed press stays inside the sender's shared-project boundary.
  const pressScope = await slackPressScope(userId, relayedFrom);
  if (!slackMayUse(pressScope, task)) {
    console.info(`[slack] ${userName} pressed a button for a tab outside what is shared with them; ignored`);
    if (relayedFrom && value.k === 'tab') await slackPostInThread(channel, threadTs, 'That tab is not available through this relay. Name the tab in a new @Supreme message, or choose it in Supreme.').catch(() => {});
    return;
  }
  const label = slackLabelOf(task, tab);
  if (value.k === 'tab') {
    const ask = slackPendingAsks.get(slackThreadKey(channel, messageTs));
    slackPendingAsks.delete(slackThreadKey(channel, messageTs));
    if (!ask) {
      await slackUpdateMessage(channel, messageTs, `That ask is gone (Supreme was restarted). Mention me again with "${label}" in it.`).catch(() => {});
      return;
    }
    rememberSlackTab(channel, ask.threadTs, task.id, tab.id);
    rememberSlackChannelTab(channel, task.id, tab.id);
    await slackUpdateMessage(channel, messageTs, `${label}, picked by ${userName}.`).catch(() => {});
    if (ask.all) {
      console.info(`[slack] ${userName} picked ${label} for reply to all in ${channelName}`);
      await runSlackReplyAll({ task, tab, channel, channelName, threadTs: ask.threadTs, exceptTs: ask.ts, user: ask.user || userId, userName: ask.userName || userName });
      return;
    }
    let prompt = ask.text || 'Reply to this.';
    const attachments = [];
    const bring = async (files) => {
      for (const file of (Array.isArray(files) ? files : []).slice(0, 5)) {
        const attachment = await slackFileAttachment(file).catch(() => null);
        if (attachment) attachments.push(attachment);
      }
    };
    if (ask.threadParentTs) {
      const previous = tab.messages?.findLast(message => message.role === 'user' && message.fromSlack?.channel === channel && message.fromSlack?.threadTs === ask.threadParentTs);
      const before = await slackThreadBefore(channel, ask.threadParentTs, String(ask.ts || ''), previous?.fromSlack?.ts || '');
      prompt += before.text;
      await bring(before.files);
    } else {
      const recent = await slackGroupBackground(task, channel, String(ask.ts || ''));
      prompt += recent.warning ? `\n\nSlack conversation context: ${recent.warning}` : recent.text;
    }
    await bring(ask.files);
    console.info(`[slack] ${userName} picked ${label} for the mention in ${channelName}`);
    await runSlackTurn({ task, tab, prompt, attachments, channel, threadTs: ask.threadTs, ts: ask.ts, user: ask.user || userId, userName: ask.userName || userName, channelName });
    return;
  }
  if (value.k === 'send' || value.k === 'approve' || value.k === 'hold') {
    const sending = value.k === 'send';
    const approval = value.k === 'approve' || value.approval;
    const stripped = String(payload.message?.text || '').replace(/\n_(?:Drafted in Supreme|Waiting for your approval)[^\n]*$/, '');
    await slackUpdateMessage(channel, messageTs, `${stripped.slice(0, 2_700)}\n_${approval ? `${value.k === 'approve' ? 'Approved' : 'Held'}, ${userName}.` : sending ? `Sending, ${userName} said yes.` : `Not sent, ${userName} said no.`}_`).catch(() => {});
    console.info(`[slack] ${userName} pressed ${approval ? value.k === 'approve' ? 'Confirm' : 'Not yet' : sending ? 'Send' : "Don't send"} for ${label}`);
    await runSlackTurn({ task, tab, prompt: String(value.r || (sending ? 'Confirm.' : 'Not yet.')), attachments: [], channel, threadTs, ts: messageTs, user: userId, userName, channelName, announce: false });
  }
}
// What the Edit box sent back: the change goes into the same tab as a
// normal turn, the old draft is marked as being redrafted, and the new one
// comes back under it with Send, Edit and Don't send.
async function handleSlackEditSubmit(payload, { relayedFrom = '' } = {}) {
  if (payload.view?.callback_id !== SLACK_EDIT_VIEW) return;
  let meta = {};
  try { meta = JSON.parse(payload.view.private_metadata || '{}'); } catch { return; }
  if (!relayedFrom && meta.r && meta.r !== slackRelayMe()) {
    await relaySlack({ teammate: { userId: String(meta.r), name: '' }, kind: 'view', payload: { payload }, channel: '', threadTs: '' });
    return;
  }
  const change = String(payload.view.state?.values?.edit?.text?.value || '').trim();
  if (!change) return;
  const channel = String(meta.c || '');
  const messageTs = String(meta.m || '');
  const threadTs = String(meta.h || messageTs);
  const userId = String(payload.user?.id || '');
  const [userName, channelName] = await Promise.all([slackUserName(userId), slackChannelName(channel)]);
  const task = getTask(String(meta.t || ''));
  const tab = task ? getTab(task, String(meta.b || '')) : null;
  if (!task || !tab) {
    await slackUpdateMessage(channel, messageTs, 'That tab is gone. Mention me again and name another.').catch(() => {});
    return;
  }
  if (!slackMayUse(await slackPressScope(userId, relayedFrom), task)) return;
  const label = slackLabelOf(task, tab);
  const old = await slackThreadMessages(channel, threadTs).then((rows) => rows.find((row) => row.ts === messageTs)).catch(() => null);
  const stripped = String(old?.text || '').replace(/\n_Drafted in Supreme[^\n]*$/, '');
  if (stripped) await slackUpdateMessage(channel, messageTs, `${stripped.slice(0, 2_700)}\n_Redrafting, ${userName} asked for a change._`).catch(() => {});
  const whose = meta.l ? ` to ${meta.l}` : '';
  const prompt = `${change}\n\n(A change to the reply${whose} you just drafted. Redraft it and ask me again before sending anything.)`;
  console.info(`[slack] ${userName} asked for an edit in ${label}`);
  await runSlackTurn({ task, tab, prompt, attachments: [], channel, threadTs, ts: messageTs, user: userId, userName, channelName, announce: false, ...(meta.l ? { lead: { name: String(meta.l).replace(/ \(.*\)$/, ''), email: (String(meta.l).match(/\(([^)]+)\)$/) || [])[1] || '' } } : {}) });
}
function startSlackListener() {
  void slackActivity.recover();
  startSlackSocket({ token: slackPrefs().appToken, onMention: handleSlackMention, onAction: handleSlackAction });
}

// A port it cannot take (another service, a smoke on the same port) is a
// reason to stop, not to linger: the uncaught-exception guard above would
// otherwise keep a service alive that answers nothing, and the desktop app
// would wait on it. It exits, and the app reclaims or reports the port.
server.on('error', (err) => {
  console.error(`[service] cannot listen on ${PORT}: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  startSlackListener();
  // A teammate's Mac handing over an ask this Mac's person made in Slack.
  slackRelay.start({ token: slackRelayToken, me: slackRelayMe, onRow: takeRelayedSlack });
  console.log(`conductor  http://localhost:${PORT}   data: ${DATA_DIR}`);
  // The model CLIs keep themselves current without a terminal: first pass a
  // few minutes after boot, then every six hours, never during a run.
  // A daily local copy of the store (lib/backup.mjs), two minutes in.
  backup.start();
  if (process.env.WB_MODEL_USAGE_FIXTURE !== '1') {
    cliUpdates.start(cliUpdateOptions);
    // Section 32: forwarded emails waiting in the cloud, when email is on.
    // On for anyone signed in, unless Settings turns it off.
    emailPickup.start({ enabled: () => emailSettings().enabled !== false, token: () => team.sessionToken(), onEmail: (mail) => emailInbound(mail).catch((err) => console.error('[email] inbound:', err.message)) });
  }
});
