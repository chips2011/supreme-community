// Same team (Paper section 19). A project shared by email; everything in it
// travels; two people can type into one thread. Nothing runs in the cloud:
// every turn runs on the Mac of whoever sent it. See docs/same-team.md.
//
// Only the Mac holding a thread's lease writes its transcript. Anyone else's
// message queues (a durable row both sides see) until the turn lands, and is
// then run by its own sender's Mac. Runtime state never travels through the
// stored thread; the other person's live run arrives as broadcast frames and
// is mirrored in memory for the transcript view.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  changes, listTasks, getTask, saveTask, deleteTask, listRepos, saveRepos, taskSummary, DATA_DIR, newId, getSettings, saveSettings,
  normalizeTaskProjectIdentity, stableProjectId,
} from './store.mjs';
import { createManagedProject, createWorktree } from './git.mjs';
import { loadPlays, savePlays } from './plays.mjs';
import { createTransport, hubUrl } from './team-transport.mjs';
import * as relay from './relay.mjs';
import { tokenExpiry, tokenExpired } from './supabase.mjs';
import { setConfirmationViewer } from './confirmation.mjs';

const PRESENCE_MS = 5_000;
const TICK_MS = 3_000;
const REFRESH_MS = 15_000;
const PUSH_DEBOUNCE_MS = 800;
const FRAME_FLUSH_MS = 300;
const LEASE_TTL_S = 30;
const LEASE_RENEW_MS = 10_000;
const TYPING_TTL_MS = 6_000;
const ONLINE_MS = 15_000;
const QUEUE_EXPIRE_MS = 15 * 60_000;
const RUNNING_ROW_STALE_MS = 2 * 60_000;
const MIRROR_STALE_MS = 90_000;
const QUEUE_DIR = path.join(DATA_DIR, 'team-queue');
// A queue id names a file in that folder. Ids this Mac made are UUIDs; one
// read from a teammate's row is checked the same way before it becomes a
// path (`../tasks/<id>` would otherwise have named a workstream file).
function queueFile(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('bad queue id');
  return path.join(QUEUE_DIR, `${id}.json`);
}
const MACHINE = os.hostname().replace(/\.local$/, '');

const s = {
  session: null,
  transport: null,
  enabled: false,
  port: 0,
  attachedAt: 0,
  projects: new Map(),   // projectId -> { id, ownerId, data, updatedAt }
  members: new Map(),    // projectId -> [member rows]
  queue: new Map(),      // queue row id -> row
  mirrors: new Map(),    // `${taskId}::${tabId}` -> remote run mirror
  typing: new Map(),     // `${taskId}::${tabId}` -> Map<userId, { name, at }>
  presence: new Map(),   // userId -> { name, runnerId, machine, at }
  subs: new Map(),       // projectId -> unsubscribe
  timers: [],
  applying: false,
  pendingPush: new Map(),// taskId -> timer
  pushing: new Set(),    // taskIds mid-push
  running: new Map(),    // runId -> { taskId, tabId, queueId, frames, flushTimer, renew }
  claimed: new Set(),    // queue ids this Mac has started
  sharedTaskIds: new Set(),
  playHashes: new Map(), // playId -> last pushed JSON
  playRows: new Map(),   // playId -> { userId }
  projectHashes: new Map(), // projectId -> last pushed data JSON
  lastHeads: new Map(),  // taskId -> updatedAt seen
  pushRetries: new Map(), // taskId -> pushes in a row that failed
  justAccepted: [],
  localizeErrors: new Map(), // projectId -> last error setting it up locally
};

const log = (...args) => console.log('[team]', ...args);
const warn = (...args) => console.error('[team]', ...args);

// The DB-backed run mirror must never fail silently: a missing run_state
// relation (migration 0009 unapplied) once hid behind .catch(() => {}) on
// every write and read, so live mirroring was simply dead with nothing in the
// logs. One loud line a minute names the problem without becoming a storm.
let lastRunStateWarnAt = 0;
function warnRunState(err) {
  if (Date.now() - lastRunStateWarnAt < 60_000) return;
  lastRunStateWarnAt = Date.now();
  warn(`run mirror could not reach the database (is migration 0009 applied?): ${err.message}`);
}
const key = (taskId, tabId) => `${taskId}::${tabId}`;
const later = (a, b) => ((Date.parse(a || '') || 0) >= (Date.parse(b || '') || 0) ? a : b) || a || b || null;

// ---------------------------------------------------------------------------
// Who am I

export function hubMode() { return !!hubUrl(); }
export function enabled() { return s.enabled; }
export function me() {
  const user = s.session?.user;
  if (!user) return null;
  const meta = user.user_metadata || {};
  const settingsName = String(getSettings().userName || '').trim();
  const name = settingsName || String(meta.name || meta.full_name || '').trim() || String(user.email || '').split('@')[0] || 'You';
  return { id: user.id, email: String(user.email || '').toLowerCase(), name };
}
export function runnerId() { return relay.status().runnerId; }
// Section 32: the email pickup reads this person's own rows with it.
export function sessionToken() { return s.session?.token && !expiredNow() ? s.session.token : null; }

export function status() {
  const expiresAt = s.session ? tokenExpiry(s.session.token) : null;
  return {
    enabled: s.enabled,
    kind: s.transport?.kind || null,
    user: me(),
    projects: [...s.projects.keys()],
    machine: MACHINE,
    // The renderer renews the token when this says so; until then every
    // cloud call would fail, so the app says so instead of pretending.
    expired: expiredNow(),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    // Projects that could not be set up on this Mac yet (git missing), with
    // the reason; the refresh loop keeps trying.
    waiting: [...s.localizeErrors.entries()].map(([projectId, error]) => ({ projectId, name: s.projects.get(projectId)?.data?.name || null, error })),
  };
}

function expiredNow() {
  return !!s.session && tokenExpired(s.session.token);
}

const EXPIRED_MESSAGE = 'Your sign-in expired and is being renewed. Try again in a few seconds.';
const SHARED_UNAVAILABLE_MESSAGE = 'Shared work is unavailable right now. Your message has not started. Try again.';
let expiredLogged = false;
function assertFresh() {
  if (expiredNow()) throw new Error(EXPIRED_MESSAGE);
}
export function friendlyError(err) {
  return /jwt expired|jwt|401|unauthorized/i.test(String(err?.message || '')) ? EXPIRED_MESSAGE : (err?.message || 'Something went wrong.');
}
export function isExpiryError(err) {
  return friendlyError(err) === EXPIRED_MESSAGE;
}

function blockedRun(err) {
  const expired = expiredNow() || isExpiryError(err);
  return {
    error: expired ? EXPIRED_MESSAGE : SHARED_UNAVAILABLE_MESSAGE,
    status: expired ? 409 : 503,
    code: expired ? 'SHARED_SIGNIN_EXPIRED' : 'SHARED_SERVICE_UNAVAILABLE',
  };
}

// The same account with a fresh token: swap it in everywhere, nothing else
// moves (channels stay joined, a run in flight keeps its lease and frames).
export function refreshToken({ token, user }) {
  if (!s.session || !token || user?.id !== s.session.user?.id) return false;
  s.session = { ...s.session, token, user: user || s.session.user };
  s.transport?.setToken?.(token);
  expiredLogged = false;
  return true;
}

// ---------------------------------------------------------------------------
// Session

export async function attachSession({ token, user, port }) {
  if (s.enabled && refreshToken({ token, user })) return status();
  await clearSession();
  s.session = { token, user };
  setConfirmationViewer(user?.id || null);
  s.port = port;
  s.attachedAt = Date.now();
  const transport = createTransport({ session: s.session });
  if (!transport) return status();
  try {
    if (!(await transport.probe())) { log('cloud has no Same team tables yet, staying local'); return status(); }
  } catch (err) {
    warn('probe failed:', err.message);
    return status();
  }
  s.transport = transport;
  s.enabled = true;
  try {
    s.justAccepted = (await transport.acceptInvites()).map((row) => row.projectId);
  } catch (err) { warn('accept invites:', err.message); s.justAccepted = []; }
  // A failed first read (offline for a moment, git still installing on a new
  // Mac) must not switch Same team off for the session: the refresh loop
  // tries again every 15 s.
  try {
    await refreshMemberships();
  } catch (err) {
    warn('memberships (will retry):', err.message);
  }
  return status();
}

// Second stage, after the per-user sync has hydrated: pull everything shared
// with me, seed the cloud with my own shared threads, join the channels.
export async function start() {
  if (!s.enabled || s.timers.length) return;
  try { await pullAll(); } catch (err) { warn('pull:', err.message); }
  try { await pushLocalShared(); } catch (err) { warn('seed:', err.message); }
  for (const projectId of s.projects.keys()) await subscribeProject(projectId);
  // The owner learns right away that the invite was opened.
  for (const projectId of new Set(s.justAccepted || [])) await broadcast(projectId, 'members', { projectId }).catch(() => {});
  s.justAccepted = [];
  s.timers.push(setInterval(() => sendPresence().catch(() => {}), PRESENCE_MS));
  s.timers.push(setInterval(() => tick().catch((err) => warn('tick:', err.message)), TICK_MS));
  s.timers.push(setInterval(() => refresh().catch((err) => warn('refresh:', err.message)), REFRESH_MS));
  for (const timer of s.timers) timer.unref?.();
  await sendPresence().catch(() => {});
}

export async function clearSession() {
  for (const timer of s.timers) clearInterval(timer);
  s.timers = [];
  for (const [, unsubscribe] of s.subs) { try { unsubscribe(); } catch { /* ignore */ } }
  s.subs.clear();
  for (const entry of s.running.values()) { if (entry.renew) clearInterval(entry.renew); if (entry.flushTimer) clearTimeout(entry.flushTimer); }
  s.running.clear();
  for (const timer of s.pendingPush.values()) clearTimeout(timer);
  s.pendingPush.clear();
  try { await s.transport?.close(); } catch { /* ignore */ }
  s.transport = null;
  s.session = null;
  s.enabled = false;
  s.projects.clear();
  s.members.clear();
  s.queue.clear();
  s.mirrors.clear();
  s.typing.clear();
  s.presence.clear();
  s.sharedTaskIds.clear();
  s.playRows.clear();
  s.playHashes.clear();
  s.projectHashes.clear();
  s.lastHeads.clear();
  s.pushRetries.clear();
}

// ---------------------------------------------------------------------------
// Membership

export function isShared(projectId) { return !!projectId && s.projects.has(projectId); }
export function isSharedTask(task) { return !!task && isShared(task.projectId); }
export function isSharedTaskId(taskId) { return s.sharedTaskIds.has(taskId); }
function roleIn(projectId) {
  const mine = me();
  if (!mine) return null;
  const project = s.projects.get(projectId);
  if (!project) return null;
  if (project.ownerId === mine.id) return 'owner';
  return (s.members.get(projectId) || []).some((m) => m.userId === mine.id) ? 'editor' : null;
}
function online(userId) {
  const seen = s.presence.get(userId);
  return !!seen && Date.now() - seen.at < ONLINE_MS;
}
function nameOf(userId, fallback = 'A teammate') {
  const mine = me();
  if (mine && userId === mine.id) return mine.name;
  for (const rows of s.members.values()) {
    const row = rows.find((m) => m.userId === userId);
    if (row) return row.name || row.email.split('@')[0];
  }
  return s.presence.get(userId)?.name || fallback;
}

export function sharedInfo(projectId) {
  if (!isShared(projectId)) return null;
  const mine = me();
  const project = s.projects.get(projectId);
  const rows = s.members.get(projectId) || [];
  return {
    projectId,
    role: roleIn(projectId),
    ownerId: project.ownerId,
    ownerName: nameOf(project.ownerId),
    members: rows.map((m) => ({
      id: m.id,
      email: m.email,
      userId: m.userId,
      role: m.role,
      name: m.name || (m.userId ? nameOf(m.userId, m.email.split('@')[0]) : m.email.split('@')[0]),
      accepted: !!m.acceptedAt,
      me: !!mine && m.userId === mine.id,
      online: !!m.userId && online(m.userId),
    })),
  };
}

async function refreshMemberships() {
  const { projects, members } = await s.transport.memberships();
  const mine = me();
  const seen = new Set();
  s.members.clear();
  for (const row of members) {
    if (!s.members.has(row.projectId)) s.members.set(row.projectId, []);
    s.members.get(row.projectId).push(row);
  }
  for (const project of projects) {
    // A project I am invited to but have not accepted (should not happen after
    // acceptInvites, but a stale row must not become a rail entry).
    const memberOfIt = project.ownerId === mine.id || (s.members.get(project.id) || []).some((m) => m.userId === mine.id);
    if (!memberOfIt) continue;
    seen.add(project.id);
    s.projects.set(project.id, project);
    // One project that cannot be set up locally yet (no git on this Mac
    // until the Command Line Tools finish installing) must not take the
    // others with it, and it is retried on every refresh.
    try {
      await localizeProject(project);
      s.localizeErrors.delete(project.id);
    } catch (err) {
      if (s.localizeErrors.get(project.id) !== err.message) warn(`could not set up ${project.data?.name || project.id.slice(0, 8)} on this Mac yet (will retry):`, err.message);
      s.localizeErrors.set(project.id, err.message);
    }
  }
  for (const id of [...s.projects.keys()]) {
    if (seen.has(id)) continue;
    s.projects.delete(id);
    s.members.delete(id);
    const unsubscribe = s.subs.get(id);
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } s.subs.delete(id); }
    markLocalProject(id, null);
  }
  for (const summary of listTasks()) if (isShared(summary.projectId)) s.sharedTaskIds.add(summary.id);
}

// The local record of a shared project: members get a managed backing repo on
// this Mac; owners keep theirs. Name and context notes follow the owner.
async function localizeProject(project) {
  const repos = listRepos();
  const mine = me();
  let record = repos.find((r) => r.id === project.id);
  const data = project.data || {};
  const role = project.ownerId === mine.id ? 'owner' : 'editor';
  if (!record) {
    const root = await createManagedProject({ name: data.name || 'Shared project', id: project.id });
    record = { id: project.id, path: root, name: data.name || 'Shared project', base: data.base || 'main', hasRemote: false, managed: true };
    repos.push(record);
  }
  let changed = false;
  if (role === 'editor') {
    if (data.name && record.name !== data.name) { record.name = data.name; changed = true; }
    const blocks = Array.isArray(data.contextBlocks) ? data.contextBlocks : [];
    if (JSON.stringify(record.contextBlocks || []) !== JSON.stringify(blocks)) { record.contextBlocks = blocks; changed = true; }
    if (record.archived) { record.archived = false; changed = true; }
    if (typeof data.slackBotToken === 'string' && data.slackBotToken) adoptSlackToken(data.slackBotToken);
    const prefixes = Array.isArray(data.emailAliases) ? data.emailAliases.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean) : [];
    if (JSON.stringify(record.emailAliases || []) !== JSON.stringify(prefixes)) { if (prefixes.length) record.emailAliases = prefixes; else delete record.emailAliases; changed = true; }
  }
  const shared = { role, ownerId: project.ownerId };
  if (JSON.stringify(record.shared || null) !== JSON.stringify(shared)) { record.shared = shared; changed = true; }
  if (changed || !repos.includes(record)) {
    s.applying = true;
    try { saveRepos(repos); } finally { s.applying = false; }
  }
  if (role === 'owner') s.projectHashes.set(project.id, JSON.stringify(projectData(record)));
}

function markLocalProject(projectId, shared) {
  const repos = listRepos();
  const record = repos.find((r) => r.id === projectId);
  if (!record) return;
  if (shared) record.shared = shared; else delete record.shared;
  s.applying = true;
  try { saveRepos(repos); } finally { s.applying = false; }
}

function projectData(record) {
  const slack = getSettings().slack;
  const token = slack && typeof slack === 'object' && typeof slack.botToken === 'string' ? slack.botToken : '';
  const aliases = getSettings().email?.aliases && typeof getSettings().email.aliases === 'object' ? getSettings().email.aliases : {};
  const emailAliases = Object.entries(aliases).filter(([, name]) => String(name || '').trim().toLowerCase() === String(record.name || '').trim().toLowerCase()).map(([prefix]) => prefix).sort();
  return {
    name: record.name,
    base: record.base || 'main',
    contextBlocks: Array.isArray(record.contextBlocks) ? record.contextBlocks : [],
    ...(token ? { slackBotToken: token } : {}),
    ...(emailAliases.length ? { emailAliases } : {}),
  };
}
// Settings changed something a shared project carries (its email prefixes).
export function pushOwnedProjectsNow() {
  return pushOwnedProjects(listRepos()).catch((err) => warn('project push:', err.message));
}

// A token that came with a project is adopted only when this Mac has none, or
// its own came from a project too; a token its owner set by hand or by
// OAuth is never overwritten.
function adoptSlackToken(token) {
  const settings = getSettings();
  const slack = settings.slack && typeof settings.slack === 'object' ? settings.slack : {};
  if (slack.botToken === token) return;
  if (slack.botToken && slack.source && slack.source !== 'project') return;
  settings.slack = { ...slack, botToken: token, source: 'project' };
  saveSettings(settings);
  log('adopted the Slack bot token shared with a project');
}

// After the owner connects Slack (or pastes a token): push it into every
// project this account owns, right away rather than at the next repo change.
export async function shareSlackToken() {
  if (!s.enabled) return;
  await pushOwnedProjects(listRepos());
}

export function decorateProjects(repos) {
  return (repos || []).map((record) => {
    const info = record?.id ? sharedInfo(record.id) : null;
    return info ? { ...record, shared: info } : record;
  });
}

// Owner: share a project with an email. Idempotent per email.
export async function shareProject({ project, email }) {
  if (!s.enabled) throw new Error('Sign in to share a project.');
  assertFresh();
  const mine = me();
  const clean = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(clean)) throw new Error('Enter a valid email address.');
  if (clean === mine.email) throw new Error('That is you.');
  const repos = listRepos();
  const record = repos.find((r) => r.path === project.path || (project.id && r.id === project.id));
  if (!record) throw new Error('No such project.');
  if (!record.id) { record.id = stableProjectId(record); saveRepos(repos); }
  const existing = s.projects.get(record.id);
  if (existing && existing.ownerId !== mine.id) throw new Error('Only the owner can share this project.');
  const data = projectData(record);
  if (!existing) {
    await s.transport.upsertProject({ id: record.id, ownerId: mine.id, data });
    await s.transport.addMember({ projectId: record.id, email: mine.email, userId: mine.id, role: 'owner', name: mine.name, acceptedAt: new Date().toISOString() });
    await refreshMemberships();
    // Everything in the project goes as a set: its threads and its plays go
    // up before the invite, so the email counts what is really there.
    for (const summary of listTasks()) {
      if (summary.projectId !== record.id) continue;
      const task = getTask(summary.id);
      if (task) await pushThreadNow(task);
    }
    await pushSharedPlays({ force: true });
    await subscribeProject(record.id);
  }
  let member;
  try {
    member = await s.transport.addMember({ projectId: record.id, email: clean, role: 'editor', invitedBy: mine.id });
  } catch (err) {
    if (!/duplicate|409/.test(err.message)) throw err;
    member = null;
  }
  await refreshMemberships();
  await broadcast(record.id, 'members', { projectId: record.id });
  return { member, shared: sharedInfo(record.id) };
}

export async function removeMember({ projectId, memberId }) {
  if (!s.enabled) throw new Error('Sign in first.');
  assertFresh();
  if (roleIn(projectId) !== 'owner') throw new Error('Only the owner can change who is in.');
  const row = (s.members.get(projectId) || []).find((m) => m.id === memberId);
  if (!row) throw new Error('No such person.');
  if (row.role === 'owner') throw new Error('The owner stays.');
  await s.transport.removeMember(memberId);
  await refreshMemberships();
  await broadcast(projectId, 'members', { projectId });
  return sharedInfo(projectId);
}

export async function deleteProject(projectId, { taskIds = [] } = {}) {
  if (!s.enabled || !isShared(projectId)) return false;
  assertFresh();
  if (roleIn(projectId) !== 'owner') throw new Error('Only the owner can delete a shared project. Ask them to take you off it.');
  for (const taskId of taskIds) {
    if (!s.sharedTaskIds.has(taskId)) continue;
    s.sharedTaskIds.delete(taskId);
    await s.transport.deleteThread(taskId).catch((err) => warn('thread delete on project delete:', err.message));
  }
  await broadcast(projectId, 'project', { projectId, deleted: true }).catch(() => {});
  await s.transport.deleteProject(projectId);
  s.projects.delete(projectId);
  s.members.delete(projectId);
  s.projectHashes.delete(projectId);
  const unsubscribe = s.subs.get(projectId);
  if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } s.subs.delete(projectId); }
  return true;
}

// ---------------------------------------------------------------------------
// Merging a shared thread. Task and tab metadata come from the writer; each
// tab's transcript comes from whichever side landed a turn later. Runtime
// state (activeRun, status running) never survives a merge: the live run
// travels over the broadcast instead.
// folds ride with the transcript they were made against, so one fold
// serves both Macs (the cold-start fold, 2026-09-12).
const TRANSCRIPT_KEYS = ['messages', 'summary', 'briefingHash', 'compaction', 'folds', 'handoffs', 'duels', 'turnAt', 'status'];
const MACHINE_KEYS = ['repo', 'worktreePath', 'cwd', 'branch', 'base', 'diffStat', 'prUrl', 'cloudHandoff', 'lastWorkspaceHandoff', 'pinned', 'traffic', 'privateGone'];

function isOrchestratorTab(tab) {
  return tab?.type === 'orchestrator';
}
function ownPrivateTab(tab, myId) {
  if (tab?.privateTo) return !!myId && tab.privateTo === myId;
  const ran = tab?.sessions && Object.keys(tab.sessions).length > 0;
  return !!ran || !(tab?.messages || []).some((message) => message.role === 'assistant');
}
function privateIdsOf(...tasks) {
  const ids = new Set();
  for (const task of tasks) {
    for (const id of task?.privateTabs || []) ids.add(id);
    for (const tab of [...(task?.tabs || []), ...(task?.archivedTabs || [])]) if (isOrchestratorTab(tab)) ids.add(tab.id);
  }
  return ids;
}

function tabTurn(tab) {
  const stamped = Date.parse(tab?.turnAt || '');
  if (Number.isFinite(stamped)) return stamped;
  const messages = tab?.messages || [];
  const last = messages[messages.length - 1];
  return Date.parse(last?.ts || '') || 0;
}
function newerTranscript(a, b) {
  const ta = tabTurn(a);
  const tb = tabTurn(b);
  if (ta !== tb) return ta > tb ? a : b;
  return (a?.messages?.length || 0) >= (b?.messages?.length || 0) ? a : b;
}
function stripTab(tab) {
  const { activeRun: _activeRun, sessions: _sessions, tabmailHold: _hold, tabmailOut: _out, ...rest } = tab;
  if (rest.status === 'running') rest.status = 'idle';
  return rest;
}
function mergeTab(metaTab, otherTab) {
  if (!otherTab) return stripTab(metaTab);
  const src = newerTranscript(metaTab, otherTab);
  const out = { ...metaTab };
  for (const k of TRANSCRIPT_KEYS) {
    if (src[k] !== undefined) out[k] = src[k]; else delete out[k];
  }
  return stripTab(out);
}
export function stripRuntime(task) {
  if (!task) return task;
  const out = { ...task };
  const privateIds = privateIdsOf(task);
  out.tabs = (task.tabs || []).filter((tab) => !privateIds.has(tab.id)).map(stripTab);
  if (task.archivedTabs) out.archivedTabs = task.archivedTabs.filter((tab) => !privateIds.has(tab.id));
  if (privateIds.size) out.privateTabs = [...privateIds].slice(-200); else delete out.privateTabs;
  if (privateIds.has(out.activeTab)) out.activeTab = out.tabs[0]?.id;
  if (out.status === 'running') out.status = 'idle';
  // The star never leaves the Mac that set it, nor does an orchestrator's traffic.
  delete out.pinned;
  delete out.traffic;
  delete out.privateGone;
  return out;
}
// A teammate's orchestrators off this Mac's copy; this Mac's own stay, stamped.
function withOwnPrivateTabs(task, privateIds, myId) {
  if (!task || !privateIds.size) return task;
  const keep = (tab) => {
    if (!privateIds.has(tab.id)) return tab;
    if (!ownPrivateTab(tab, myId)) return null;
    return !tab.privateTo && myId ? { ...tab, privateTo: myId } : tab;
  };
  const out = { ...task, tabs: (task.tabs || []).map(keep).filter(Boolean) };
  if (task.archivedTabs) out.archivedTabs = task.archivedTabs.map(keep).filter(Boolean);
  return out;
}

// base is always this Mac's copy (its machine fields stay); incoming is the
// cloud's. writer says whose metadata wins: 'base' when pushing a local
// change, 'incoming' when absorbing what the other person pushed.
export function mergeSharedThread(base, incoming, { writer = 'incoming', keepLocalTabs = [], myId = me()?.id || null } = {}) {
  if (!base) return stripRuntime(incoming);
  if (!incoming) return stripRuntime(base);
  // base is this Mac's copy: its own orchestrators ride through the union
  // below; the cloud copy never carries one, and a teammate's leaves here.
  const privateIds = privateIdsOf(base, incoming);
  const privateOrder = (base.tabs || []).map((tab, index) => [tab.id, index]).filter(([id]) => privateIds.has(id));
  base = withOwnPrivateTabs(base, privateIds, myId);
  incoming = { ...incoming, tabs: (incoming.tabs || []).filter((tab) => !privateIds.has(tab.id)), ...(incoming.archivedTabs ? { archivedTabs: incoming.archivedTabs.filter((tab) => !privateIds.has(tab.id)) } : {}) };
  const meta = writer === 'incoming' ? incoming : base;
  const other = writer === 'incoming' ? base : incoming;
  const out = { ...meta };
  for (const k of MACHINE_KEYS) {
    if (base[k] !== undefined) out[k] = base[k]; else delete out[k];
  }
  const baseTabs = new Map((base.tabs || []).map((t) => [t.id, t]));
  const otherTabs = new Map((other.tabs || []).map((t) => [t.id, t]));
  const metaArchived = new Set((meta.archivedTabs || []).map((t) => t.id));
  // Permanent deletion must win over the union: without a tombstone, a tab
  // deleted on one Mac came straight back from the other copy's lists.
  const deletedTabs = new Map();
  for (const row of [...(base.deletedTabs || []), ...(incoming.deletedTabs || [])]) {
    if (row?.id && !deletedTabs.has(row.id)) deletedTabs.set(row.id, { id: row.id, at: row.at || null });
  }
  const tabs = (meta.tabs || []).filter((tab) => !deletedTabs.has(tab.id)).map((tab) => {
    if (keepLocalTabs.includes(tab.id) && baseTabs.has(tab.id)) return baseTabs.get(tab.id);
    return mergeTab(tab, otherTabs.get(tab.id));
  });
  for (const tab of other.tabs || []) {
    if (tabs.some((t) => t.id === tab.id) || metaArchived.has(tab.id) || deletedTabs.has(tab.id)) continue;
    tabs.push(keepLocalTabs.includes(tab.id) && baseTabs.has(tab.id) ? baseTabs.get(tab.id) : stripTab(tab));
  }
  // Each merged tab keeps this Mac's own provider sessions and nobody else's:
  // mergeTab strips them, and only the local copy can put its own back.
  out.tabs = tabs.map((tab) => {
    const local = baseTabs.get(tab.id);
    if (!local?.sessions) { const { sessions: _sessions, ...rest } = tab; return rest; }
    return { ...tab, sessions: local.sessions };
  });
  // An own orchestrator keeps its place in this Mac's tab row.
  for (const [id, index] of privateOrder) {
    const at = out.tabs.findIndex((tab) => tab.id === id);
    if (at < 0 || at === index) continue;
    const [tab] = out.tabs.splice(at, 1);
    out.tabs.splice(Math.min(index, out.tabs.length), 0, tab);
  }
  if (privateIds.size) out.privateTabs = [...privateIds].slice(-200); else delete out.privateTabs;
  const archived = [...(meta.archivedTabs || [])].filter((tab) => !deletedTabs.has(tab.id));
  for (const tab of other.archivedTabs || []) {
    if (archived.some((t) => t.id === tab.id) || tabs.some((t) => t.id === tab.id) || deletedTabs.has(tab.id)) continue;
    archived.push(stripTab(tab));
  }
  if (archived.length) out.archivedTabs = archived; else delete out.archivedTabs;
  if (deletedTabs.size) out.deletedTabs = [...deletedTabs.values()].slice(-200); else delete out.deletedTabs;
  out.activeTab = tabs.some((t) => t.id === meta.activeTab) ? meta.activeTab : tabs[0]?.id;
  out.updatedAt = later(base.updatedAt, incoming.updatedAt);
  out.lastActivity = later(base.lastActivity, incoming.lastActivity);
  delete out.activeRun;
  if (out.status === 'running') out.status = tabs.some((t) => t.status === 'running') ? 'running' : 'idle';
  return out;
}

// ---------------------------------------------------------------------------
// Threads: push (merge first) and absorb.

function liveLocalTabs(taskId) {
  return [...s.running.values()].filter((r) => r.taskId === taskId).map((r) => r.tabId);
}

async function pushThreadNow(task) {
  if (!s.enabled || !task?.id) return null;
  const mine = me();
  s.pushing.add(task.id);
  try {
    const cloud = await s.transport.getThread(task.id);
    const local = getTask(task.id) || task;
    const merged = mergeSharedThread(local, cloud?.data || null, { writer: 'base', keepLocalTabs: liveLocalTabs(task.id) });
    const stripped = stripRuntime(merged);
    // Supabase validates the whole upsert payload against NOT NULL, so the
    // row's user_id must always travel: the creator's on an existing row,
    // never this Mac's (which would move the row to whoever last wrote it).
    const written = await s.transport.putThread({
      id: task.id,
      projectId: task.projectId,
      userId: (cloud && cloud.userId) || local.createdBy?.id || mine.id,
      data: stripped,
      summary: taskSummary(stripped),
      archived: !!stripped.archived,
      lastActivity: stripped.lastActivity || stripped.updatedAt || null,
    });
    s.sharedTaskIds.add(task.id);
    // The cloud's stamp for what just went up: the next refresh sees the
    // same head and leaves the row alone instead of pulling our own 4MB
    // back down.
    if (written?.updatedAt) s.lastHeads.set(task.id, written.updatedAt);
    const now = getTask(task.id);
    // The cloud had a later turn in another tab: take it locally too.
    if (cloud && now) {
      const keep = liveLocalTabs(task.id);
      const fresh = mergeSharedThread(now, cloud.data, { writer: 'base', keepLocalTabs: keep });
      if (JSON.stringify(withoutRuntime(now)) !== JSON.stringify(withoutRuntime(fresh))) {
        const next = { ...fresh };
        next.tabs = fresh.tabs.map((tab) => (keep.includes(tab.id) ? (now.tabs || []).find((t) => t.id === tab.id) || tab : tab));
        if (keep.length) next.status = now.status;
        applyLocally(() => saveTask(next));
      }
    }
    // What went up predates that turn, and may have reached the cloud after
    // the turn's own push did. Send it again once things settle.
    if (now && JSON.stringify(withoutRuntime(now)) !== JSON.stringify(withoutRuntime(local))) pushThread(getTask(task.id) || now);
    return stripped;
  } finally {
    s.pushing.delete(task.id);
  }
}
function withoutRuntime(task) {
  const out = stripRuntime(task);
  delete out.updatedAt;
  return out;
}

export function pushThread(task) {
  if (!s.enabled || !task?.id || s.applying) return;
  if (!isSharedTask(task)) return;
  // A run in flight on this Mac pushes once, when it lands.
  if (liveLocalTabs(task.id).length) return;
  if (s.pendingPush.has(task.id)) clearTimeout(s.pendingPush.get(task.id));
  s.pendingPush.set(task.id, setTimeout(() => {
    s.pendingPush.delete(task.id);
    const fresh = getTask(task.id);
    if (!fresh) return;
    pushThreadNow(fresh)
      .then(() => { s.pushRetries.delete(task.id); return broadcast(fresh.projectId, 'thread', { taskId: fresh.id, updatedAt: fresh.updatedAt }).catch((err) => warn('broadcast after push:', err.message)); })
      .catch((err) => {
        // Again later, doubling from a few seconds to five minutes. A push
        // that failed used to be forgotten, and the cloud copy stayed stale
        // until the workstream happened to be saved again.
        const tries = (s.pushRetries.get(task.id) || 0) + 1;
        s.pushRetries.set(task.id, tries);
        const delay = Math.min(5 * 60_000, PUSH_DEBOUNCE_MS * 2 ** Math.min(tries + 1, 9));
        warn(`push failed (try ${tries}, again in ${Math.round(delay / 1000)}s):`, err.message);
        if (s.pendingPush.has(task.id)) return;
        s.pendingPush.set(task.id, setTimeout(() => {
          s.pendingPush.delete(task.id);
          const again = getTask(task.id);
          if (again) pushThread(again);
        }, delay));
      });
  }, PUSH_DEBOUNCE_MS));
}

// A workstream that just moved into a shared project (dragged onto it in the
// rail). It goes up now rather than on the debounce, so the reply can say it
// is really there, and the people in that project hear about it at once.
export async function adoptThread(task) {
  if (!s.enabled || !task?.id || !isSharedTask(task)) return null;
  if (s.pendingPush.has(task.id)) { clearTimeout(s.pendingPush.get(task.id)); s.pendingPush.delete(task.id); }
  const pushed = await pushThreadNow(task);
  await broadcast(task.projectId, 'thread', { taskId: task.id, updatedAt: task.updatedAt });
  return pushed;
}

function applyLocally(fn) {
  s.applying = true;
  try { return fn(); } finally { s.applying = false; }
}

export function absorbThread(row) {
  if (!row?.data?.id) return null;
  const incoming = row.data;
  if (!isShared(incoming.projectId)) return null;
  const local = getTask(incoming.id);
  const keep = liveLocalTabs(incoming.id);
  let merged = mergeSharedThread(local, incoming, { writer: 'incoming', keepLocalTabs: keep });
  if (keep.length && local) merged.status = local.status;
  // A workstream that held only a teammate's orchestrators leaves this Mac's list.
  if (!(merged.tabs || []).length && !(merged.archivedTabs || []).length && (merged.privateTabs || []).length) merged.privateGone = true;
  else delete merged.privateGone;
  merged = normalizeTaskProjectIdentity(merged, listRepos()).task;
  const localProject = listRepos().find((r) => r.id === merged.projectId);
  if (localProject && !local) {
    // First copy on this Mac: the paths inside are the other Mac's. Bind the
    // record to the local project; a workspace is made when a turn runs here.
    merged.repo = localProject.path;
    merged.repoName = localProject.name;
    delete merged.worktreePath;
    delete merged.cwd;
  }
  if (local && JSON.stringify(withoutRuntime(local)) === JSON.stringify(withoutRuntime(merged))) {
    s.sharedTaskIds.add(merged.id);
    if (row.updatedAt) s.lastHeads.set(merged.id, row.updatedAt);
    return local;
  }
  applyLocally(() => saveTask(merged));
  s.sharedTaskIds.add(merged.id);
  s.lastHeads.set(merged.id, row.updatedAt || merged.updatedAt);
  for (const tab of merged.tabs || []) {
    const mirror = s.mirrors.get(key(merged.id, tab.id));
    if (mirror && mirror.finished) s.mirrors.delete(key(merged.id, tab.id));
  }
  return merged;
}

export async function pullThread(taskId) {
  if (!s.enabled) return null;
  const row = await s.transport.getThread(taskId);
  if (!row) return null;
  return absorbThread(row);
}

async function pullAll() {
  // Only projects with a local record can take threads; the rest wait for
  // the next refresh to set them up.
  const ids = [...s.projects.keys()].filter((id) => !s.localizeErrors.has(id));
  if (!ids.length) return;
  // Heads first, then one row at a time: a thread this Mac has at the
  // head's stamp is left alone. Every shared thread used to come down
  // whole in one request at each start (and each respawn), which is 30MB
  // against a 15s limit on this Mac.
  const heads = await s.transport.listThreadHeads(ids);
  const have = new Map(listTasks().map((summary) => [summary.id, summary]));
  for (const head of heads) {
    if (have.has(head.id) && head.updatedAt && s.lastHeads.get(head.id) === head.updatedAt) continue;
    const row = await s.transport.getThread(head.id);
    if (!row) continue;
    try { absorbThread(row); } catch (err) { warn('absorb failed:', err.message); }
    if (head.updatedAt) s.lastHeads.set(head.id, head.updatedAt);
  }
  await pullPlays(ids);
  await refreshQueue();
}

// My shared threads the cloud does not have yet (a project shared before this
// Mac signed in, or created offline).
async function pushLocalShared() {
  const ids = [...s.projects.keys()];
  if (!ids.length) return;
  const cloudIds = new Set((await s.transport.listThreadHeads(ids)).map((r) => r.id));
  for (const summary of listTasks()) {
    if (!isShared(summary.projectId) || cloudIds.has(summary.id)) continue;
    const task = getTask(summary.id);
    if (task) await pushThreadNow(task);
  }
}

function quietWhileExpired() {
  if (!expiredNow()) return false;
  if (!expiredLogged) { log('sign-in token expired, waiting for the renderer to renew it'); expiredLogged = true; }
  return true;
}

async function refresh() {
  if (!s.enabled || quietWhileExpired()) return;
  // An invite that arrives while the app is open is accepted here, not only
  // at sign-in; the owner hears about it the same way as at sign-in.
  let accepted = [];
  try { accepted = await s.transport.acceptInvites(); } catch (err) { warn('accept invites:', err.message); }
  await refreshMemberships();
  const ids = [...s.projects.keys()];
  for (const id of ids) if (!s.subs.has(id)) await subscribeProject(id);
  for (const projectId of new Set((accepted || []).map((row) => row.projectId))) {
    if (s.projects.has(projectId)) await broadcast(projectId, 'members', { projectId }).catch(() => {});
  }
  if (!ids.length) return;
  // A project set up on this refresh (git arrived) has no heads recorded
  // yet, so its threads are pulled whole by the loop below.
  const ready = ids.filter((id) => !s.localizeErrors.has(id));
  const heads = ready.length ? await s.transport.listThreadHeads(ready) : [];
  for (const head of heads) {
    if (s.lastHeads.get(head.id) === head.updatedAt) continue;
    if (liveLocalTabs(head.id).length || s.pushing.has(head.id)) continue;
    const row = await s.transport.getThread(head.id);
    if (row) absorbThread(row);
    s.lastHeads.set(head.id, head.updatedAt);
  }
  await pullPlays(ids);
  await refreshQueue();
  // A mirror nobody has fed for a while and whose lease is gone is a run that
  // died on the other Mac.
  for (const [k, mirror] of s.mirrors) {
    if (Date.now() - mirror.at < MIRROR_STALE_MS) continue;
    const mirrorTabId = String(k).split('::')[1] || '';
    const lease = (mirrorTabId ? await s.transport.getLease(mirrorTabId).catch(() => null) : null)
      || await s.transport.getLease(mirror.taskId).catch(() => null);
    if (!lease || Date.parse(lease.heartbeat) < Date.now() - LEASE_TTL_S * 1000) s.mirrors.delete(k);
  }
}

// Store change listeners: shared threads and plays mirror up from here.
changes.on('change', (evt) => {
  if (!s.enabled || s.applying || !evt?.kind) return;
  if (evt.kind === 'thread') pushThread(evt.data);
  else if (evt.kind === 'thread-delete') {
    const id = evt.data?.id;
    if (!id || !s.sharedTaskIds.has(id)) return;
    s.sharedTaskIds.delete(id);
    s.transport.deleteThread(id).catch((err) => warn('delete failed:', err.message));
    for (const pid of s.projects.keys()) broadcast(pid, 'thread-deleted', { taskId: id }).catch(() => {});
  } else if (evt.kind === 'repos') pushOwnedProjects(evt.data).catch((err) => warn('project push:', err.message));
  else if (evt.kind === 'plays') pushSharedPlays().catch((err) => warn('plays push:', err.message));
});

async function pushOwnedProjects(repos) {
  if (!s.enabled) return;
  const mine = me();
  for (const record of repos || []) {
    const project = record?.id ? s.projects.get(record.id) : null;
    if (!project || project.ownerId !== mine.id) continue;
    const data = projectData(record);
    const hash = JSON.stringify(data);
    if (s.projectHashes.get(record.id) === hash) continue;
    s.projectHashes.set(record.id, hash);
    await s.transport.upsertProject({ id: record.id, ownerId: mine.id, data });
    project.data = data;
    await broadcast(record.id, 'project', { projectId: record.id });
  }
}

// ---------------------------------------------------------------------------
// Plays travel with the project.

async function pushSharedPlays({ force = false } = {}) {
  if (!s.enabled) return;
  const mine = me();
  let touched = new Set();
  for (const play of loadPlays()) {
    if (!isShared(play.projectId)) continue;
    const hash = JSON.stringify(play);
    if (!force && s.playHashes.get(play.id) === hash) continue;
    const known = s.playRows.get(play.id);
    await s.transport.putPlay({ id: play.id, userId: known?.userId || play.createdBy?.id || mine.id, projectId: play.projectId, data: play });
    s.playHashes.set(play.id, hash);
    if (!known) s.playRows.set(play.id, { userId: mine.id });
    touched.add(play.projectId);
  }
  for (const projectId of touched) await broadcast(projectId, 'plays', { projectId });
}

async function pullPlays(projectIds) {
  const rows = await s.transport.listPlays(projectIds);
  const plays = loadPlays();
  let changed = false;
  for (const row of rows) {
    s.playRows.set(row.id, { userId: row.userId });
    const hash = JSON.stringify(row.data);
    const index = plays.findIndex((p) => p.id === row.id);
    if (index >= 0) {
      const local = plays[index];
      if (JSON.stringify(local) === hash) { s.playHashes.set(row.id, hash); continue; }
      if (Date.parse(local.updatedAt || '') > Date.parse(row.data?.updatedAt || '')) continue; // mine is newer, it will push
      plays[index] = row.data;
    } else plays.push(row.data);
    s.playHashes.set(row.id, hash);
    changed = true;
  }
  if (changed) applyLocally(() => savePlays(plays));
}

// ---------------------------------------------------------------------------
// Channels: presence, typing, thread updates, queue, the other person's run.

async function subscribeProject(projectId) {
  if (!s.enabled || s.subs.has(projectId)) return;
  try {
    const unsubscribe = await s.transport.subscribe(projectId, (event, payload) => {
      onEvent(projectId, event, payload || {}).catch((err) => warn(`event ${event}:`, err.message));
    });
    s.subs.set(projectId, unsubscribe);
  } catch (err) {
    warn(`subscribe ${projectId.slice(0, 8)}:`, err.message);
  }
}

async function broadcast(projectId, event, payload) {
  if (!s.enabled || !projectId) return;
  const mine = me();
  await s.transport.broadcast(projectId, event, { ...payload, from: mine?.id || null, at: new Date().toISOString() });
}

async function sendPresence() {
  const mine = me();
  if (!mine || quietWhileExpired()) return;
  for (const projectId of s.projects.keys()) {
    await broadcast(projectId, 'presence', { user: mine, runnerId: runnerId(), machine: MACHINE, viewing: s.myViewing || null });
  }
}

export async function viewing({ taskId, tabId }) {
  if (!s.enabled) return;
  s.myViewing = taskId ? { taskId: String(taskId), tabId: tabId ? String(tabId) : null } : null;
  const task = taskId ? getTask(taskId) : null;
  if (task && isSharedTask(task)) {
    await broadcast(task.projectId, 'presence', { user: me(), runnerId: runnerId(), machine: MACHINE, viewing: s.myViewing }).catch(() => {});
  }
}

function viewersFor(taskId) {
  const mine = me();
  const viewers = [];
  for (const [id, row] of s.presence) {
    if (mine && id === mine.id) continue;
    if (!row.viewing || row.viewing.taskId !== taskId) continue;
    if (Date.now() - row.at > 20_000) continue;
    viewers.push({ id, name: row.name || nameOf(id), tabId: row.viewing.tabId || null });
  }
  return viewers;
}

async function onEvent(projectId, event, payload) {
  const mine = me();
  if (payload.from && payload.from === mine?.id) return;
  switch (event) {
    case 'presence': {
      if (payload.user?.id) s.presence.set(payload.user.id, { name: payload.user.name, runnerId: payload.runnerId, machine: payload.machine, viewing: payload.viewing || null, at: Date.now() });
      return;
    }
    case 'typing': {
      const k = key(payload.taskId, payload.tabId);
      if (!s.typing.has(k)) s.typing.set(k, new Map());
      if (payload.active === false) s.typing.get(k).delete(payload.userId);
      else s.typing.get(k).set(payload.userId, { name: payload.name || nameOf(payload.userId), at: Date.now() });
      return;
    }
    case 'thread': {
      if (!payload.taskId || liveLocalTabs(payload.taskId).length || s.pushing.has(payload.taskId)) return;
      const row = await s.transport.getThread(payload.taskId);
      if (row) absorbThread(row);
      return;
    }
    case 'thread-deleted': {
      if (payload.taskId && getTask(payload.taskId)) applyLocally(() => deleteTask(payload.taskId));
      s.sharedTaskIds.delete(payload.taskId);
      return;
    }
    case 'members':
    case 'project': {
      await refreshMemberships();
      for (const id of s.projects.keys()) if (!s.subs.has(id)) await subscribeProject(id);
      return;
    }
    case 'plays': {
      await pullPlays([projectId]);
      return;
    }
    case 'queue': {
      await refreshQueue();
      return;
    }
    case 'run': {
      applyRunFrames(payload);
      return;
    }
    default:
  }
}

// The other person's live run, mirrored for the transcript view only.
function applyRunFrames(payload) {
  const { taskId, tabId, runId, user, frames = [] } = payload;
  if (!taskId || !tabId || !runId) return;
  const k = key(taskId, tabId);
  let mirror = s.mirrors.get(k);
  if (!mirror || mirror.runId !== runId) {
    mirror = emptyMirror({ runId, taskId, tabId, user: user || null, machine: payload.machine || null, startedAt: payload.startedAt });
    s.mirrors.set(k, mirror);
    s.typing.get(k)?.delete(user?.id);
  }
  mirror.at = Date.now();
  if (payload.activity) {
    mirror.computer = payload.activity.computer ? { ...payload.activity.computer, hasPreview: false, previewSeq: null } : null;
    mirror.connectors = Array.isArray(payload.activity.connectors) ? payload.activity.connectors : [];
  }
  for (const frame of frames) {
    mirror.seq += 1;
    reduceFrame(mirror, frame);
  }
  reduceFrameTail(mirror);
}

function emptyMirror({ runId, taskId, tabId, user = null, machine = null, startedAt = null }) {
  return {
    runId, taskId, tabId, user, machine,
    startedAt: startedAt || new Date().toISOString(), model: null, requestedModel: null, prompts: [], hiddenPrompt: false,
    play: null, effort: null, text: '', draftText: '', workNotes: [], tools: [], statusText: '', error: null, steers: [], seq: 0, finished: false, at: Date.now(),
    computer: null, connectors: [], interims: [],
  };
}

function reduceFrame(mirror, frame) {
  switch (frame.type) {
      case 'start':
        mirror.model = frame.model || mirror.model;
        mirror.requestedModel = frame.requestedModel || frame.model || mirror.requestedModel;
        mirror.prompts = frame.prompts || mirror.prompts;
        mirror.hiddenPrompt = !!frame.hiddenPrompt;
        mirror.play = frame.play || null;
        mirror.effort = frame.effort || null;
        break;
      case 'delta': mirror.text += frame.text || ''; mirror.draftText = ''; break;
      case 'candidate-delta': mirror.draftText += frame.text || ''; break;
      case 'candidate-reset': mirror.draftText = ''; break;
      case 'progress': { const note = String(frame.text || '').trim(); if (note) mirror.workNotes.push(note); mirror.draftText = ''; break; }
      case 'interim': mirror.interims.push({ id: frame.steerId || null, text: String(frame.text || ''), at: frame.at }); mirror.draftText = ''; break;
      case 'tool': {
        const label = { name: frame.name, kind: frame.kind };
        mirror.tools = [...mirror.tools.filter((t) => !(t.name === label.name && t.kind === label.kind)), label].slice(-3);
        break;
      }
      case 'status': mirror.statusText = frame.text || ''; break;
      case 'steer': mirror.steers.push({ id: frame.id || newId(), prompt: frame.prompt || '', at: frame.at }); break;
      case 'error': mirror.error = frame.message || 'The run failed.'; break;
      case 'stopped': mirror.stopped = true; break;
      case 'saved':
      case 'run-finished': mirror.finished = true; break;
      default:
  }
}

function reduceFrameTail(mirror) {
  if (mirror.workNotes.length > 50) mirror.workNotes = mirror.workNotes.slice(-50);
}

function mirrorPublic(mirror) {
  const prompt = mirror.prompts[0] || '';
  return {
    id: mirror.runId,
    taskId: mirror.taskId,
    tabId: mirror.tabId,
    model: mirror.model,
    requestedModel: mirror.requestedModel || mirror.model,
    recommendation: null,
    handoff: null,
    terminalContexts: [],
    attachments: [],
    steers: mirror.steers,
    prompt,
    prompts: mirror.prompts,
    hiddenPrompt: mirror.hiddenPrompt,
    play: mirror.play,
    effort: mirror.effort,
    startedAt: mirror.startedAt,
    text: mirror.text,
    draftText: mirror.draftText,
    workNotes: mirror.workNotes,
    tools: mirror.tools,
    statusText: mirror.statusText,
    error: mirror.error,
    computer: mirror.computer || null,
    connectors: mirror.connectors || [],
    interims: mirror.interims || [],
    seq: mirror.seq,
    active: true,
    updatedAt: new Date(mirror.at).toISOString(),
    remote: { userId: mirror.user?.id || null, name: mirror.user?.name || nameOf(mirror.user?.id), machine: mirror.machine || null },
  };
}

// ---------------------------------------------------------------------------
// The run gate: pull the latest copy, make sure there is a workspace on this
// Mac, take the lease or queue.

async function ensureLocalWorkspace(task) {
  if (task.worktreePath && fs.existsSync(task.worktreePath)) return task;
  const project = listRepos().find((r) => r.id === task.projectId);
  if (!project) return task;
  const root = await createManagedProject({ name: project.name, id: project.id });
  let wt;
  try {
    wt = await createWorktree({ repo: root, title: task.title, base: project.base || 'main', id: task.id });
  } catch (err) {
    warn('workspace:', err.message);
    return task;
  }
  const fresh = getTask(task.id) || task;
  fresh.repo = project.path;
  fresh.repoName = project.name;
  fresh.base = wt.base;
  fresh.branch = wt.branch;
  fresh.worktreePath = wt.worktreePath;
  fresh.cwd = wt.worktreePath;
  applyLocally(() => saveTask(fresh));
  return fresh;
}

export async function beforeRun({ task, tab, body }) {
  if (!s.enabled || !isSharedTask(task)) return { ok: true, task };
  if (expiredNow()) return blockedRun();
  const mine = me();
  const queueId = body?.queueId ? String(body.queueId) : null;
  try {
    const row = await s.transport.getThread(task.id);
    if (row) absorbThread(row);
  } catch (err) {
    warn('pull before run:', err.message);
    return blockedRun(err);
  }
  let fresh = getTask(task.id) || task;
  fresh = await ensureLocalWorkspace(fresh);
  const owner = runnerId();
  // The decisive lock is per TAB: the lease table's key is any uuid, so a
  // tab id leases through the same RPC with no migration. This never depends
  // on realtime mirrors (which the breaker can pause), which is how a 0.1.39
  // Mac still queued behind a teammate working a different tab. The thread
  // lease is still taken opportunistically so older Macs — which only look
  // at the thread — keep queueing behind us; we no longer look at it.
  let effective;
  try {
    effective = await s.transport.acquireLease({ taskId: tab.id, projectId: task.projectId, owner, ttl: LEASE_TTL_S });
  } catch (err) {
    warn('tab lease:', err.message);
    return blockedRun(err);
  }
  // No confirmed owner is not evidence that a teammate owns the tab.
  if (!effective) return blockedRun();
  if (effective === owner) {
    s.transport.acquireLease({ taskId: task.id, projectId: task.projectId, owner, ttl: LEASE_TTL_S }).catch(() => {});
  }
  if (effective !== owner) {
    if (queueId) {
      await s.transport.updateQueue(queueId, { status: 'queued' }).catch(() => {});
      s.claimed.delete(queueId);
      return { error: 'that thread is running on another Mac right now' };
    }
    const prompts = Array.isArray(body.prompts) ? body.prompts : [body.prompt];
    const prompt = prompts.map((p) => String(p || '').trim()).filter(Boolean).join('\n\n');
    const id = newId();
    fs.mkdirSync(QUEUE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(QUEUE_DIR, `${id}.json`), JSON.stringify({ taskId: task.id, tabId: tab.id, body }));
    let queued;
    try {
      queued = await s.transport.enqueue({ id, projectId: task.projectId, taskId: task.id, tabId: tab.id, userId: mine.id, name: mine.name, prompt });
    } catch (err) {
      warn('queue write:', err.message);
      return blockedRun(err);
    }
    s.queue.set(queued.id, queued);
    // Once the row is durable, a failed notification must not look like a
    // failed send and invite the person to submit the same message again.
    await broadcast(task.projectId, 'queue', { taskId: task.id }).catch((err) => warn('queue broadcast:', err.message));
    return { queued: queueForClient(queued) };
  }
  return { ok: true, task: fresh, queueId };
}

// Called once the run object exists. Frames for the other Mac are batched.
export function startRun({ runId, taskId, tabId, queueId = null, activity = null }) {
  const projectId = getTask(taskId)?.projectId;
  if (!s.enabled || !isShared(projectId)) return;
  s.sharedTaskIds.add(taskId);
  // The project id rides on the entry: the frame flush (up to several times
  // a second) and the lease renewal used to re-read and re-parse the whole
  // workstream, 4MB on a long one, just to find it.
  const entry = { runId, taskId, tabId, projectId, queueId, activity, frames: [], flushTimer: null, renew: null, startedAt: new Date().toISOString(), lastStateAt: 0 };
  entry.self = emptyMirror({ runId, taskId, tabId, user: me(), machine: MACHINE, startedAt: entry.startedAt });
  entry.renew = setInterval(() => {
    s.transport.acquireLease({ taskId: tabId, projectId: entry.projectId, owner: runnerId(), ttl: LEASE_TTL_S }).catch(() => {});
    s.transport.acquireLease({ taskId, projectId: entry.projectId, owner: runnerId(), ttl: LEASE_TTL_S }).catch(() => {});
  }, LEASE_RENEW_MS);
  entry.renew.unref?.();
  s.running.set(runId, entry);
  // The sender's message reaches the other side now, not when the run lands.
  // Their view otherwise stays on the previous turn for the whole run — an
  // old confirmation card left up is exactly what a teammate would answer
  // wrongly.
  const task = getTask(taskId);
  if (task) {
    pushThreadNow(task)
      .then(() => broadcast(task.projectId, 'thread', { taskId, updatedAt: getTask(taskId)?.updatedAt }))
      .catch((err) => warn('push at run start:', err.message));
  }
}

export function onRunEvent(runId, event) {
  const entry = s.running.get(runId);
  if (!entry || !event?.type) return;
  const last = entry.frames[entry.frames.length - 1];
  if (event.type === 'delta' && last?.type === 'delta') last.text = (last.text || '') + (event.text || '');
  else if (event.type === 'candidate-delta' && last?.type === 'candidate-delta') last.text = (last.text || '') + (event.text || '');
  else entry.frames.push(compactFrame(event));
  if (entry.self) { entry.self.seq += 1; reduceFrame(entry.self, compactFrame(event)); reduceFrameTail(entry.self); }
  const important = ['start', 'tool', 'computer', 'connector', 'progress', 'status', 'steer', 'interim', 'stopped', 'error', 'saved', 'run-finished'].includes(event.type);
  if (important) flushFrames(entry);
  else if (!entry.flushTimer) entry.flushTimer = setTimeout(() => flushFrames(entry), FRAME_FLUSH_MS);
}
function compactFrame(event) {
  const { previewDataUrl: _p, detail: _d, ...rest } = event;
  return rest;
}
function flushFrames(entry) {
  if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
  if (!entry.frames.length) return;
  const frames = entry.frames.splice(0, entry.frames.length);
  const task = { projectId: entry.projectId };
  const mine = me();
  // The step trace, as the card draws it. Never a screenshot: the other
  // person watches the steps, Peek stays with whoever's Chrome it is.
  let activity = null;
  try {
    const snapshot = typeof entry.activity === 'function' ? entry.activity() : null;
    if (snapshot) {
      activity = {
        computer: snapshot.computer ? { ...snapshot.computer, hasPreview: false, previewSeq: null } : null,
        connectors: Array.isArray(snapshot.connectors) ? snapshot.connectors : [],
      };
    }
  } catch { /* the frames still go */ }
  broadcast(task?.projectId, 'run', {
    taskId: entry.taskId, tabId: entry.tabId, runId: entry.runId, user: mine, machine: MACHINE, startedAt: entry.startedAt, frames, activity,
  }).catch(() => {});
  // The DB-backed mirror (migration 0009): broadcast is the fast path, this
  // row is the truth a viewer's polling can always reach when the socket
  // flaps. Throttled, tail-trimmed, gone at landing.
  if (entry.self && task?.projectId && s.transport?.putRunState && Date.now() - entry.lastStateAt > 2_500) {
    entry.lastStateAt = Date.now();
    const state = {
      ...entry.self,
      text: String(entry.self.text || '').slice(-4_000),
      draftText: String(entry.self.draftText || '').slice(-1_500),
      workNotes: (entry.self.workNotes || []).slice(-8),
      interims: (entry.self.interims || []).slice(-4),
      computer: activity?.computer || entry.self.computer,
      connectors: activity?.connectors || entry.self.connectors,
      at: undefined,
    };
    s.transport.putRunState({ tabId: entry.tabId, taskId: entry.taskId, projectId: task.projectId, state }).catch(warnRunState);
  }
}

export async function afterRun({ runId }) {
  const entry = s.running.get(runId);
  if (!entry) return;
  if (entry.renew) clearInterval(entry.renew);
  flushFrames(entry);
  s.running.delete(runId);
  const task = getTask(entry.taskId);
  try {
    if (task) await pushThreadNow(task);
  } catch (err) { warn('push after run:', err.message); }
  if (s.transport?.clearRunState) await s.transport.clearRunState(entry.tabId).catch(warnRunState);
  try { await s.transport.releaseLease({ taskId: entry.tabId, owner: runnerId() }); } catch { /* ignore */ }
  try { await s.transport.releaseLease({ taskId: entry.taskId, owner: runnerId() }); } catch { /* ignore */ }
  if (entry.queueId) {
    await s.transport.updateQueue(entry.queueId, { status: 'done', finishedAt: new Date().toISOString() }).catch(() => {});
    s.queue.delete(entry.queueId);
    s.claimed.delete(entry.queueId);
    try { fs.unlinkSync(queueFile(entry.queueId)); } catch { /* ignore */ }
  }
  if (task?.projectId) {
    await broadcast(task.projectId, 'thread', { taskId: task.id, updatedAt: task.updatedAt }).catch(() => {});
    await broadcast(task.projectId, 'queue', { taskId: task.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The queue.

async function refreshQueue() {
  const ids = [...s.projects.keys()];
  if (!ids.length) { s.queue.clear(); return; }
  const rows = await s.transport.listQueue(ids);
  s.queue.clear();
  for (const row of rows) s.queue.set(row.id, row);
}

function queueForClient(row) {
  const mine = me();
  return {
    id: row.id,
    userId: row.userId,
    name: row.name || nameOf(row.userId),
    prompt: row.prompt,
    status: row.status,
    createdAt: row.createdAt,
    mine: !!mine && row.userId === mine.id,
    online: !!mine && row.userId === mine.id ? true : online(row.userId),
  };
}

function queueRowsFor(taskId, tabId) {
  return [...s.queue.values()]
    .filter((row) => row.taskId === taskId && row.tabId === tabId && row.status !== 'done')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(queueForClient);
}

function readLocalBody(id) {
  try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, `${id}.json`), 'utf8')); } catch { return null; }
}

function senderStaleAt(row) {
  const seen = s.presence.get(row.userId)?.at || 0;
  return Math.max(seen, Date.parse(row.createdAt) || 0, s.attachedAt);
}

let tickInFlight = false;
async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try { await tickOnce(); } finally { tickInFlight = false; }
}

async function tickOnce() {
  if (!s.enabled || quietWhileExpired()) return;
  const mine = me();
  // The DB-backed live mirror: read the one task being looked at. Fresh
  // broadcast mirrors win; polled rows fill in when the socket cannot.
  const watchId = s.myViewing?.taskId || null;
  const watchTask = watchId ? getTask(watchId) : null;
  if (watchTask && isSharedTask(watchTask) && s.transport?.listRunState) {
    const rows = await s.transport.listRunState(watchTask.id).catch((err) => { warnRunState(err); return []; });
    const seen = new Set();
    for (const row of rows || []) {
      if (!row?.state || row.state.machine === MACHINE) continue;
      const k = key(row.taskId, row.tabId);
      seen.add(k);
      if (Date.parse(row.updatedAt || 0) < Date.now() - 12_000) continue;
      const existing = s.mirrors.get(k);
      if (existing && !existing.viaPoll && Date.now() - existing.at < 6_000) continue;
      s.mirrors.set(k, { ...row.state, taskId: row.taskId, tabId: row.tabId, finished: false, at: Date.now(), viaPoll: true, seq: (existing?.seq || 0) + 1 });
    }
    for (const [k, mirror] of s.mirrors) {
      if (mirror.viaPoll && mirror.taskId === watchTask.id && !seen.has(k)) mirror.finished = true;
    }
  }
  for (const [k, entries] of s.typing) {
    for (const [userId, item] of entries) if (Date.now() - item.at > TYPING_TTL_MS) entries.delete(userId);
    if (!entries.size) s.typing.delete(k);
  }
  const byTask = new Map();
  for (const row of s.queue.values()) {
    if (!['queued', 'running'].includes(row.status)) continue;
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
    byTask.get(row.taskId).push(row);
  }
  for (const [taskId, rows] of byTask) {
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const running = rows.find((row) => row.status === 'running');
    if (running) {
      const stale = Date.parse(running.startedAt || running.createdAt) < Date.now() - RUNNING_ROW_STALE_MS;
      const live = liveLocalTabs(taskId).includes(running.tabId) || await leaseLive(running.tabId) || await leaseLive(taskId);
      if (stale && !live && !s.claimed.has(running.id)) {
        const updated = await s.transport.updateQueue(running.id, { status: 'failed', finishedAt: new Date().toISOString() }, { ifStatus: 'running' });
        if (updated) s.queue.delete(running.id);
      }
      continue;
    }
    const head = rows.find((row) => row.status === 'queued');
    if (!head) continue;
    // A queued row waits only for ITS tab's lane to free; a run in a sibling
    // tab no longer holds everyone's messages hostage.
    if (liveLocalTabs(taskId).includes(head.tabId) || await leaseLive(head.tabId)) continue;
    if (head.userId === mine.id) {
      if (s.claimed.has(head.id)) continue;
      const body = readLocalBody(head.id);
      if (!body) {
        const updated = await s.transport.updateQueue(head.id, { status: 'failed', finishedAt: new Date().toISOString() }, { ifStatus: 'queued' });
        if (updated) s.queue.delete(head.id);
        continue;
      }
      let claimed;
      try {
        claimed = await s.transport.updateQueue(head.id, { status: 'running', startedAt: new Date().toISOString() }, { ifStatus: 'queued' });
      } catch (err) {
        warn('queue claim:', err.message);
        continue;
      }
      if (!claimed) { s.queue.delete(head.id); continue; }
      s.claimed.add(head.id);
      s.queue.set(head.id, claimed);
      runQueued(head.id, body).catch((err) => warn('queued run:', err.message));
      continue;
    }
    if (Date.now() - senderStaleAt(head) > QUEUE_EXPIRE_MS) {
      const expired = await s.transport.updateQueue(head.id, { status: 'expired', finishedAt: new Date().toISOString() }, { ifStatus: 'queued' }).catch(() => null);
      if (expired) { s.queue.set(head.id, expired); await broadcast(expired.projectId, 'queue', { taskId }).catch(() => {}); }
    }
  }
}

async function leaseLive(taskId) {
  // A failed read cannot prove a lease is free. Let the tick pause rather
  // than claim work or mark a teammate's running request failed.
  const lease = await s.transport.getLease(taskId);
  if (!lease) return false;
  return Date.parse(lease.heartbeat) >= Date.now() - LEASE_TTL_S * 1000;
}

async function runQueued(id, body) {
  const res = await fetch(`http://127.0.0.1:${s.port}/api/tasks/${encodeURIComponent(body.taskId)}/tabs/${encodeURIComponent(body.tabId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body.body, queueId: id }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    warn(`queued run ${id.slice(0, 8)} → ${res.status} ${detail.slice(0, 120)}`);
    await s.transport.updateQueue(id, { status: 'queued' }).catch(() => {});
    s.claimed.delete(id);
    return;
  }
  // Drain the SSE stream; the turn's own finish path settles the row.
  try { for await (const _chunk of res.body) { /* drain */ } } catch { /* ignore */ }
}

// The sender takes an expired message back (its text returns to the composer).
export async function ackQueue(id) {
  const row = s.queue.get(id);
  const local = readLocalBody(id);
  if (row) await s.transport.updateQueue(id, { status: 'done', finishedAt: new Date().toISOString() }).catch(() => {});
  s.queue.delete(id);
  try { fs.unlinkSync(queueFile(id)); } catch { /* ignore */ }
  if (row?.projectId) await broadcast(row.projectId, 'queue', { taskId: row.taskId }).catch(() => {});
  return local?.body || null;
}

// The sender withdraws a queued message before it goes.
export async function withdrawQueue(id) {
  const mine = me();
  const row = s.queue.get(id);
  if (!row) return null;
  if (row.userId !== mine.id) throw new Error('Only the sender can take a message back.');
  const done = await s.transport.updateQueue(id, { status: 'done', finishedAt: new Date().toISOString() }, { ifStatus: 'queued' }).catch(() => null);
  if (!done) return null;
  const local = readLocalBody(id);
  s.queue.delete(id);
  try { fs.unlinkSync(queueFile(id)); } catch { /* ignore */ }
  await broadcast(row.projectId, 'queue', { taskId: row.taskId }).catch(() => {});
  return local?.body || null;
}

// ---------------------------------------------------------------------------
// Typing, and what the client sees.

export async function typing({ task, tab, active }) {
  if (!s.enabled || !isSharedTask(task)) return;
  const mine = me();
  await broadcast(task.projectId, 'typing', { taskId: task.id, tabId: tab.id, userId: mine.id, name: mine.name, active: active !== false });
}

export function decorateTask(out) {
  if (!out || !s.enabled || !isShared(out.projectId)) return out;
  out.shared = sharedInfo(out.projectId);
  const viewers = viewersFor(out.id);
  if (viewers.length) out.viewers = viewers;
  for (const tab of out.tabs || []) {
    const k = key(out.id, tab.id);
    const mirror = s.mirrors.get(k);
    if (mirror && !mirror.finished && !tab.activeRun) {
      tab.activeRun = mirrorPublic(mirror);
      tab.status = 'running';
    }
    const queue = queueRowsFor(out.id, tab.id);
    if (queue.length) tab.queue = queue;
    const typers = [...(s.typing.get(k) || []).entries()].filter(([, item]) => Date.now() - item.at < TYPING_TTL_MS).map(([userId, item]) => ({ userId, name: item.name }));
    if (typers.length) tab.typing = typers;
  }
  return out;
}

export function decorateSummaries(rows) {
  if (!s.enabled) return rows;
  return (rows || []).map((row) => {
    if (!isShared(row.projectId)) return row;
    const remote = [...s.mirrors.values()].find((m) => m.taskId === row.id && !m.finished);
    const viewers = viewersFor(row.id);
    return {
      ...row,
      shared: { projectId: row.projectId },
      ...(remote ? { status: 'running', remoteRun: { name: remote.user?.name || nameOf(remote.user?.id) } } : {}),
      ...(viewers.length ? { viewers } : {}),
    };
  });
}

export function stampCreatedBy(task) {
  const mine = me();
  if (!mine || !task || task.createdBy) return task;
  task.createdBy = { id: mine.id, name: mine.name };
  return task;
}
