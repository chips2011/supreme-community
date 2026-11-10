// Local-first cloud sync. The local ~/.workbench store stays the working source
// of truth (fast, offline-tolerant); this mirrors changes up to Supabase and
// pulls them down when a user signs in on a new machine.
//
// Design: coarse-grained, whole-document, last-writer-wins. Each thread is one
// row; repos/settings are single blobs; evals are append-only. This maps 1:1
// onto the existing file-per-thread / whole-file-blob store, so no store call
// site had to change — sync just listens to store `changes` events.
//
// Inert unless Supabase is configured AND a user session is attached. With no
// session, every store write still fires an event; we simply ignore it.

import { createHash } from 'node:crypto';
import * as sb from './supabase.mjs';
import * as team from './team.mjs';
import {
  changes, listTasks, getTask, saveTask, listRepos, saveRepos,
  getSettings, saveSettings, listEvals, taskSummary, normalizeProjectIdentities,
  normalizeTaskProjectIdentity,
} from './store.mjs';

let session = null;      // { token, user: { id, ... } }
let applying = false;    // true while writing pulled remote data locally (suppress re-push)
let ready = false;       // hydrate finished — safe to push
const pending = new Map(); // dedupe key -> { kind, data } (latest wins)
let flushTimer = null;
let evalSeq = 0; // append-only rows must never coalesce in the pending map
const FLUSH_MS = 800;
let flushFailures = 0;   // pushes in a row that failed; sets the retry wait
let hydrateTimer = null; // a pull that failed tries again, later
let hydrateFailures = 0;

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function status() {
  const expiresAt = session ? sb.tokenExpiry(session.token) : null;
  const expired = !!session && expiresAt != null && expiresAt <= Date.now();
  return {
    configured: sb.isConfigured(),
    // A token object alone is not a sign-in: once it has expired every cloud
    // call fails until the renderer hands over a fresh one.
    signedIn: !!session && !expired,
    expired,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    user: session ? { id: session.user?.id, email: session.user?.email } : null,
    ready,
  };
}

function expiredNow() {
  return !!session && sb.tokenExpired(session.token);
}

export function active() {
  return !!(session && sb.isConfigured());
}

// Called when the frontend hands over a Supabase session after login.
export async function attachSession(next) {
  if (!sb.isConfigured()) return status();
  // The same account with a fresh token (Supabase rotates them hourly): swap
  // it in and carry on. A re-hydrate here would pull every thread again and
  // could clobber work in flight for nothing.
  if (session && next?.token && next.user?.id && session.user?.id === next.user.id && ready) {
    session = next;
    if (pending.size) scheduleFlush();
    return status();
  }
  session = next && next.token ? next : null;
  ready = false;
  pending.clear();
  if (hydrateTimer) { clearTimeout(hydrateTimer); hydrateTimer = null; }
  if (session) {
    try {
      await hydrate();
      hydrateFailures = 0;
    } catch (err) {
      // Local writes still go up meanwhile (each is newer than the cloud's
      // copy by construction); what this Mac has not pulled it pulls on
      // the retry, 30s on, then doubling to ten minutes.
      hydrateFailures += 1;
      console.error('[sync] hydrate failed:', err.message);
      scheduleHydrateRetry();
    }
    ready = true;
  }
  return status();
}

function scheduleHydrateRetry() {
  if (hydrateTimer) return;
  const delay = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(hydrateFailures - 1, 5));
  hydrateTimer = setTimeout(async () => {
    hydrateTimer = null;
    if (!active() || expiredNow()) { if (active()) scheduleHydrateRetry(); return; }
    try {
      await hydrate();
      hydrateFailures = 0;
      console.info('[sync] hydrate caught up');
    } catch (err) {
      hydrateFailures += 1;
      console.error('[sync] hydrate retry failed:', err.message);
      scheduleHydrateRetry();
    }
  }, delay);
  hydrateTimer.unref?.();
}

export function clearSession() {
  session = null;
  ready = false;
  pending.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (hydrateTimer) { clearTimeout(hydrateTimer); hydrateTimer = null; }
  flushFailures = 0;
  hydrateFailures = 0;
}

// ---------------------------------------------------------------------------
// Pull: bring this account's cloud data into the local store. First sign-in on
// a machine: cloud wins for anything it has; then we seed the cloud with any
// local-only items (first machine that ever ran seeds the account).

async function hydrate() {
  const token = session.token;
  const userId = session.user?.id;
  if (!userId) return;

  let reposNeedPush = false;
  applying = true;
  try {
    // Whole-file blobs: repos + settings.
    const docs = await sb.rest('user_docs?select=key,data', { token });
    const byKey = Object.fromEntries((docs || []).map((d) => [d.key, d.data]));
    if (byKey.settings && typeof byKey.settings === 'object') saveSettings(byKey.settings);
    if (Array.isArray(byKey.repos)) {
      const normalized = normalizeProjectIdentities(byKey.repos);
      saveRepos(normalized.repos);
      reposNeedPush = normalized.changed;
    } else {
      // A pre-sync local store can also contain path-only projects. Normalize
      // before seeding the account so the first cloud copy is portable.
      const normalized = normalizeProjectIdentities(listRepos());
      if (normalized.changed) saveRepos(normalized.repos);
      reposNeedPush = true;
    }

    // Threads: the heads first (id and updated_at, a few KB for the whole
    // account), then only the rows the cloud has newer than this Mac, one
    // at a time. The pull used to take every row whole in one request,
    // 30MB and more against a 15s limit, and failed on most restarts of
    // 2026-10-10/11 ("hydrate failed: The operation was aborted due to
    // timeout"), after which nothing was pulled at all.
    const headSelect = team.enabled() ? 'id,updated_at,project_id' : 'id,updated_at';
    const heads = await sb.rest(`threads?select=${headSelect}`, { token, timeoutMs: 30_000 });
    const cloudIds = new Set();
    const localWins = [];
    const normalizedCloud = [];
    const projects = listRepos();
    const localAt = new Map(listTasks().map((summary) => [summary.id, timestamp(summary.updatedAt)]));
    for (const head of heads || []) {
      if (!head || !head.id) continue;
      cloudIds.add(head.id);
      // A thread in a shared project merges through Same team (lib/team.mjs
      // pullAll and refresh): two people may have written it, so
      // last-writer-wins is not enough, and it is pulled there.
      if (team.isShared(head.project_id)) continue;
      const cloudAt = timestamp(head.updated_at);
      const haveAt = localAt.get(head.id);
      // A service restart can reconcile an interrupted local run before the
      // browser reattaches its session. Keep that newer local transcript and
      // mirror it back up instead of reviving the older cloud-side activeRun.
      if (haveAt != null && haveAt > cloudAt) { const local = getTask(head.id); if (local) localWins.push(local); continue; }
      if (haveAt != null && haveAt === cloudAt) continue;
      const rows = await sb.rest(`threads?select=id,data,updated_at&id=eq.${encodeURIComponent(head.id)}`, { token, timeoutMs: 120_000 });
      const r = rows && rows[0];
      if (!r || !r.data) continue;
      if (team.isShared(r.data?.projectId)) { try { team.absorbThread(r); } catch (err) { console.error('[sync] absorb failed:', err.message); } continue; }
      const normalized = normalizeTaskProjectIdentity(r.data, projects);
      saveTask(normalized.task);
      if (normalized.changed) normalizedCloud.push(normalized.task);
    }

    applying = false; // subsequent local-only pushes are real writes

    for (const local of localWins) await pushThread(local);
    for (const normalized of normalizedCloud) await pushThread(normalized);

    // Seed cloud with local items it doesn't have yet.
    if (!byKey.settings) await pushSettings(getSettings());
    if (reposNeedPush) await pushRepos(listRepos());
    for (const t of listTasks()) {
      if (!cloudIds.has(t.id)) {
        if (team.isShared(t.projectId)) continue; // Same team seeds these itself
        const full = getTask(t.id);
        if (full) await pushThread(full);
      }
    }
    // Evals are append-only and valuable — seed the cloud only if empty, to
    // avoid duplicating on every sign-in. After that they're push-on-write.
    const evalCount = await sb.rest('evals?select=id&limit=1', { token });
    if (!evalCount || evalCount.length === 0) {
      for (const rec of listEvals()) await pushEval(rec);
    }
  } finally {
    applying = false;
  }
}

// ---------------------------------------------------------------------------
// Push: debounced mirror of local writes up to the cloud.

changes.on('change', (evt) => {
  if (!active() || applying || !ready) return;
  if (!evt || !evt.kind) return;
  // Shared threads mirror through Same team, which merges before it writes.
  if (evt.kind === 'thread' && team.isSharedTask(evt.data)) return;
  if (evt.kind === 'thread' && (evt.data?.tabs || []).some((tab) => tab.activeRun || tab.status === 'running')) {
    pending.delete(`thread:${evt.data.id}`);
    return;
  }
  if (evt.kind === 'thread-delete' && team.isSharedTaskId(evt.data?.id)) return;
  const key = evt.kind === 'thread'
    ? `thread:${evt.data?.id}`
    : evt.kind === 'thread-delete'
      ? `thread:${evt.data?.id}` // a later delete supersedes a pending upsert
      : evt.kind === 'eval'
        ? `eval:${evalSeq++}` // append-only — never coalesce
        : evt.kind; // repos / settings coalesce to one
  pending.set(key, evt);
  scheduleFlush();
});

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((err) => console.error('[sync] flush failed:', err.message));
  }, FLUSH_MS);
}

async function flush() {
  if (!active()) { pending.clear(); return; }
  // Nothing goes up on an expired token; hold the batch for the fresh one.
  if (expiredNow()) {
    if (!flushTimer) { flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 5_000); flushTimer.unref?.(); }
    return;
  }
  const batch = [...pending.entries()];
  pending.clear();
  let failed = 0;
  for (const [key, evt] of batch) {
    try {
      if (evt.kind === 'thread') await pushThread(evt.data);
      else if (evt.kind === 'thread-delete') await deleteThread(evt.data.id);
      else if (evt.kind === 'repos') await pushRepos(evt.data);
      else if (evt.kind === 'settings') await pushSettings(evt.data);
      else if (evt.kind === 'eval') await pushEval(evt.data);
    } catch (err) {
      failed += 1;
      console.error(`[sync] push ${evt.kind} failed:`, err.message);
      // Back in the queue, unless a newer write for the same key arrived
      // while this one was going. It used to be dropped here, and a
      // workstream whose last push failed stayed stale in the cloud until
      // the next time it happened to change.
      if (!pending.has(key)) pending.set(key, evt);
    }
  }
  if (!failed) { flushFailures = 0; return; }
  flushFailures += 1;
  const delay = Math.min(5 * 60_000, FLUSH_MS * 2 ** Math.min(flushFailures + 1, 9));
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, delay);
    flushTimer.unref?.();
  }
}

// Push everything pending immediately, skipping the debounce. Handoff points
// (cloud handoff, worker lease changes) must not leave state waiting in the
// 800ms window while another machine takes over. Never throws — per-item push
// failures are logged inside flush(), same as the debounced path.
export async function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flush();
}

// ---------------------------------------------------------------------------
// Row writers (RLS-scoped by the user's token; user_id must equal auth.uid()).

function uid() { return session?.user?.id; }

// What was last sent for each thread, so a save that changed nothing the
// cloud keeps (a touch, a reconcile) costs no upload.
const pushedHashes = new Map();

// The cloud copy never carries a run in flight: it is this Mac's, and a
// hydrate that restored it would show a phantom working indicator. Provider
// sessions stay (they are machine-local, but a hydrate on this same Mac
// must not lose them).
function cloudCopy(t) {
  return {
    ...t,
    tabs: (t.tabs || []).map((tab) => {
      const { activeRun: _activeRun, ...rest } = tab;
      if (rest.status === 'running') rest.status = 'idle';
      return rest;
    }),
    ...(t.status === 'running' ? { status: 'idle' } : {}),
  };
}

async function pushThread(t) {
  if (!t || !t.id) return;
  const data = cloudCopy(t);
  const { updatedAt: _updatedAt, ...comparable } = data;
  const hash = createHash('sha1').update(JSON.stringify(comparable)).digest('hex');
  if (pushedHashes.get(t.id) === hash) return;
  const s = taskSummary(data);
  await sb.upsert('threads', {
    id: t.id,
    user_id: uid(),
    // The project column exists once migration 0007 is applied (Same team).
    ...(team.enabled() && t.projectId ? { project_id: t.projectId } : {}),
    data,
    summary: s,
    archived: !!data.archived,
    last_activity: data.lastActivity || data.updatedAt || null,
  }, { token: session.token });
  pushedHashes.set(t.id, hash);
}

async function deleteThread(id) {
  if (!id) return;
  await sb.rest(`threads?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', token: session.token });
}

async function pushRepos(repos) {
  await sb.upsert('user_docs', { user_id: uid(), key: 'repos', data: repos || [] }, { token: session.token });
}

async function pushSettings(settings) {
  await sb.upsert('user_docs', { user_id: uid(), key: 'settings', data: settings || {} }, { token: session.token });
}

async function pushEval(record) {
  await sb.rest('evals', {
    method: 'POST',
    token: session.token,
    body: [{ user_id: uid(), record }],
    prefer: 'return=minimal',
  });
}
