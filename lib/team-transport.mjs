// Same team (Paper section 19): the only thing that talks to the outside.
// One interface, two implementations: Supabase (PostgREST + Realtime, the real
// one) and a local hub (scripts/team-hub.mjs, JSON over HTTP + SSE) so the
// smoke can boot two servers as two people without touching Supabase. Every
// method returns plain rows in camelCase; nothing here knows about the store.
//
// See docs/same-team.md.
import crypto from 'node:crypto';
import * as sb from './supabase.mjs';

const MEMBER_COLUMNS = 'id,project_id,email,user_id,role,name,accepted_at,created_at';
const QUEUE_COLUMNS = 'id,project_id,task_id,tab_id,user_id,name,prompt,status,created_at,started_at,finished_at,run_id';

export function hubUrl() {
  return String(process.env.SUPREME_TEAM_HUB || '').replace(/\/+$/, '');
}

export function createTransport({ session }) {
  const hub = hubUrl();
  if (hub) return hubTransport({ session, base: hub });
  if (sb.isConfigured() && session?.token) return supabaseTransport({ session });
  return null;
}

function memberRow(r) {
  return {
    id: r.id, projectId: r.project_id, email: String(r.email || '').toLowerCase(), userId: r.user_id || null,
    role: r.role || 'editor', name: r.name || null, acceptedAt: r.accepted_at || null, createdAt: r.created_at || null,
  };
}
function projectRow(r) {
  return { id: r.id, ownerId: r.owner_id, data: r.data || {}, updatedAt: r.updated_at || null };
}
function threadRow(r) {
  return { id: r.id, projectId: r.project_id || null, userId: r.user_id || null, data: r.data, updatedAt: r.updated_at || null };
}
function playRow(r) {
  return { id: r.id, userId: r.user_id, projectId: r.project_id || null, data: r.data, updatedAt: r.updated_at || null };
}
function queueRow(r) {
  return {
    id: r.id, projectId: r.project_id, taskId: r.task_id, tabId: r.tab_id, userId: r.user_id, name: r.name || null,
    prompt: r.prompt, status: r.status, createdAt: r.created_at, startedAt: r.started_at || null,
    finishedAt: r.finished_at || null, runId: r.run_id || null,
  };
}
const inList = (ids) => `in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`;

// ---------------------------------------------------------------------------
// Supabase

function supabaseTransport({ session }) {
  let token = session.token;
  const rest = (path, opts = {}) => sb.rest(path, { ...opts, token });
  let client = null;
  const channels = new Map(); // projectId -> { channel, handlers:Set }
  let lastSendWarnAt = 0; // rate-limits realtime send-failure warnings
  // Circuit breaker: repeated channel failures pause realtime entirely for a
  // while — the 15s polling refresh already covers updates — instead of
  // letting a flapping socket churn the process (the 2026-08-30 meltdown).
  const breaker = channelFailureBreaker();

  async function realtime() {
    if (client) return client;
    const { createClient } = await import('@supabase/supabase-js');
    const { url, anonKey } = sb.config();
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.realtime.setAuth(token);
    return client;
  }

  return {
    kind: 'supabase',
    // A fresh token for the same account: every later call and channel uses it.
    setToken(next) {
      token = next;
      if (client) client.realtime.setAuth(next).catch(() => {});
      // A channel that died on the old token gets its rejoin now, not at the
      // next backoff step.
      for (const entry of channels.values()) {
        if (!entry.channel && !entry.retryTimer && entry.rejoin) void entry.rejoin().catch(() => {});
      }
    },
    async probe() {
      try { await rest('projects?select=id&limit=1'); return true; } catch (err) {
        if (/→ 404/.test(err.message)) return false;
        throw err;
      }
    },
    async memberships() {
      const [projects, members] = await Promise.all([
        rest('projects?select=id,owner_id,data,updated_at'),
        rest(`project_members?select=${MEMBER_COLUMNS}`),
      ]);
      return { projects: (projects || []).map(projectRow), members: (members || []).map(memberRow) };
    },
    async upsertProject({ id, ownerId, data }) {
      await sb.upsert('projects', { id, owner_id: ownerId, data }, { token });
    },
    async deleteProject(id) {
      await rest(`projects?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async addMember({ projectId, email, userId = null, role = 'editor', name = null, invitedBy = null, acceptedAt = null }) {
      const rows = await rest(`project_members?select=${MEMBER_COLUMNS}`, {
        method: 'POST',
        body: [{ project_id: projectId, email: String(email).toLowerCase(), user_id: userId, role, name, invited_by: invitedBy, accepted_at: acceptedAt }],
        prefer: 'return=representation',
      });
      return memberRow(rows[0]);
    },
    async removeMember(id) {
      await rest(`project_members?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async acceptInvites() {
      const rows = await rest('rpc/accept_invites', { method: 'POST', body: {} });
      return (rows || []).map(memberRow);
    },
    async listThreads(projectIds) {
      if (!projectIds.length) return [];
      const rows = await rest(`threads?project_id=${inList(projectIds)}&select=id,project_id,user_id,data,updated_at`);
      return (rows || []).map(threadRow);
    },
    async getThread(id) {
      const rows = await rest(`threads?id=eq.${encodeURIComponent(id)}&select=id,project_id,user_id,data,updated_at`);
      return rows && rows[0] ? threadRow(rows[0]) : null;
    },
    async listThreadHeads(projectIds) {
      if (!projectIds.length) return [];
      const rows = await rest(`threads?project_id=${inList(projectIds)}&select=id,updated_at`);
      return (rows || []).map((r) => ({ id: r.id, updatedAt: r.updated_at || null }));
    },
    async deleteThread(id) {
      await rest(`threads?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async putThread({ id, projectId, userId, data, summary, archived, lastActivity }) {
      const rows = await sb.upsert('threads', {
        id, project_id: projectId, data, summary, archived: !!archived, last_activity: lastActivity || null,
        ...(userId ? { user_id: userId } : {}),
      }, { token, select: 'updated_at' });
      return { updatedAt: rows?.[0]?.updated_at || null };
    },
    async listPlays(projectIds) {
      if (!projectIds.length) return [];
      const rows = await rest(`plays?project_id=${inList(projectIds)}&select=id,user_id,project_id,data,updated_at`);
      return (rows || []).map(playRow);
    },
    async putPlay({ id, userId, projectId, data }) {
      await sb.upsert('plays', { id, project_id: projectId, data, ...(userId ? { user_id: userId } : {}) }, { token });
    },
    async deletePlay(id) {
      await rest(`plays?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async acquireLease({ taskId, projectId, owner, ttl = 30 }) {
      const eff = await rest('rpc/acquire_thread_lease', {
        method: 'POST', body: { p_task: taskId, p_project: projectId, p_owner: owner, p_ttl_seconds: ttl },
      });
      return eff == null ? null : String(eff);
    },
    async releaseLease({ taskId, owner }) {
      await rest('rpc/release_lease', { method: 'POST', body: { p_task: taskId, p_owner: owner } });
    },
    async getLease(taskId) {
      const rows = await rest(`run_lease?task_id=eq.${encodeURIComponent(taskId)}&select=owner,heartbeat,user_id`);
      return rows && rows[0] ? { owner: rows[0].owner, heartbeat: rows[0].heartbeat, userId: rows[0].user_id } : null;
    },
    async listQueue(projectIds) {
      if (!projectIds.length) return [];
      const rows = await rest(`thread_queue?project_id=${inList(projectIds)}&status=in.(queued,running,expired)&select=${QUEUE_COLUMNS}&order=created_at.asc`);
      return (rows || []).map(queueRow);
    },
    async enqueue(row) {
      const rows = await rest(`thread_queue?select=${QUEUE_COLUMNS}`, {
        method: 'POST',
        body: [{ id: row.id, project_id: row.projectId, task_id: row.taskId, tab_id: row.tabId, user_id: row.userId, name: row.name || null, prompt: row.prompt, status: 'queued' }],
        prefer: 'return=representation',
      });
      return queueRow(rows[0]);
    },
    async updateQueue(id, patch, { ifStatus } = {}) {
      const body = {};
      if (patch.status) body.status = patch.status;
      if (patch.startedAt) body.started_at = patch.startedAt;
      if (patch.finishedAt) body.finished_at = patch.finishedAt;
      if (patch.runId) body.run_id = patch.runId;
      const filter = `id=eq.${encodeURIComponent(id)}${ifStatus ? `&status=eq.${encodeURIComponent(ifStatus)}` : ''}`;
      const rows = await rest(`thread_queue?${filter}&select=${QUEUE_COLUMNS}`, { method: 'PATCH', body, prefer: 'return=representation' });
      return rows && rows[0] ? queueRow(rows[0]) : null;
    },
    // The DB-backed live mirror (migration 0009). Callers treat a missing
    // relation as the feature being off.
    async putRunState({ tabId, taskId, projectId, state }) {
      await rest('run_state?on_conflict=tab_id', {
        method: 'POST',
        body: [{ tab_id: tabId, task_id: taskId, project_id: projectId, state, updated_at: new Date().toISOString() }],
        prefer: 'resolution=merge-duplicates',
      });
    },
    async clearRunState(tabId) {
      await rest(`run_state?tab_id=eq.${encodeURIComponent(tabId)}`, { method: 'DELETE' });
    },
    async listRunState(taskId) {
      const rows = await rest(`run_state?task_id=eq.${encodeURIComponent(taskId)}&select=tab_id,task_id,user_id,state,updated_at`);
      return (rows || []).map((row) => ({ tabId: row.tab_id, taskId: row.task_id, userId: row.user_id, state: row.state, updatedAt: row.updated_at }));
    },
    async subscribe(projectId, handler) {
      const rt = await realtime();
      let entry = channels.get(projectId);
      if (!entry) {
        entry = { channel: null, handlers: new Set(), ready: null, retryTimer: null, stableTimer: null, retryMs: 5_000, state: 'new', joining: false, rejoin: null };
        channels.set(projectId, entry);
        // A join that fails, times out, or drops later is torn down and
        // rejoined with backoff. Two hard-won rules from a live meltdown
        // (2026-08-30, a service spun to 100% CPU and wedged): a STALE
        // channel's late events must be ignored completely — each one used to
        // schedule another rejoin, and joins multiplied into a storm — and
        // the backoff only resets after a join stays up for 30s, so a channel
        // that connects and drops instantly cannot hammer the socket.
        const join = async () => {
          if (entry.joining || !channels.has(projectId)) return;
          if (breaker.paused()) {
            if (!entry.retryTimer) {
              entry.retryTimer = setTimeout(() => { entry.retryTimer = null; void join().catch(() => {}); }, Math.max(1_000, breaker.until() - Date.now()));
              entry.retryTimer.unref?.();
            }
            return;
          }
          entry.joining = true;
          entry.retryTimer = null;
          try {
            const previous = entry.channel;
            entry.channel = null;
            if (previous) await rt.removeChannel(previous).catch(() => {});
            // Re-assert the JWT before every new private channel (see relay.mjs).
            await rt.realtime.setAuth(token).catch(() => {});
            const channel = rt.channel(`project:${projectId}`, { config: { private: true, broadcast: { self: false } } });
            entry.channel = channel;
            channel.on('broadcast', { event: '*' }, ({ event, payload }) => {
              if (entry.channel !== channel) return;
              for (const fn of entry.handlers) {
                try { fn(event, payload); } catch (err) { console.error('[team] handler failed:', err.message); }
              }
            });
            entry.ready = new Promise((resolve) => {
              channel.subscribe((state, err) => {
                if (entry.channel !== channel) { resolve(state); return; }
                if (state !== entry.state) {
                  entry.state = state;
                  if (state === 'SUBSCRIBED') console.info(`[team] realtime project:${projectId} connected`);
                  else console.warn(`[team] realtime project:${projectId} ${state}${err?.message ? `: ${err.message}` : ''}`);
                }
                if (state === 'SUBSCRIBED') {
                  if (entry.stableTimer) clearTimeout(entry.stableTimer);
                  entry.stableTimer = setTimeout(() => { entry.retryMs = 5_000; }, 30_000);
                  entry.stableTimer.unref?.();
                  resolve(state);
                }
                if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
                  resolve(state);
                  if (entry.stableTimer) { clearTimeout(entry.stableTimer); entry.stableTimer = null; }
                  const paused = breaker.note();
                  if (paused && entry.state !== 'paused') {
                    entry.state = 'paused';
                    console.warn(`[team] realtime paused for a while after repeated channel failures (project:${projectId}); polling covers updates meanwhile`);
                  }
                  if (!channels.has(projectId) || entry.retryTimer) return;
                  const delay = paused ? Math.max(entry.retryMs, breaker.until() - Date.now()) : entry.retryMs;
                  entry.retryTimer = setTimeout(() => { entry.retryTimer = null; void join().catch(() => {}); }, delay);
                  entry.retryTimer.unref?.();
                  entry.retryMs = Math.min(entry.retryMs * 2, 60_000);
                }
              });
            });
            await entry.ready;
          } finally {
            entry.joining = false;
          }
        };
        entry.rejoin = join;
        await join();
      }
      entry.handlers.add(handler);
      if (entry.ready) await entry.ready;
      return () => {
        entry.handlers.delete(handler);
        if (!entry.handlers.size) {
          channels.delete(projectId);
          if (entry.retryTimer) clearTimeout(entry.retryTimer);
          if (entry.stableTimer) clearTimeout(entry.stableTimer);
          const open = entry.channel;
          entry.channel = null;
          if (open) rt.removeChannel(open).catch(() => {});
        }
      };
    },
    async broadcast(projectId, event, payload) {
      const entry = channels.get(projectId);
      // A channel object that is not SUBSCRIBED cannot deliver — realtime-js
      // quietly falls back to a per-call REST request for every send, which
      // is how a closing channel became a log and CPU storm (E2E 2026-09-01:
      // 4,963 of 5,000 log lines were the same warning). Skip the send; the
      // DB mirror and polling carry the update, and the join loop is already
      // working the channel back to SUBSCRIBED.
      if (!entry?.channel || entry.state !== 'SUBSCRIBED') return false;
      try {
        await entry.channel.send({ type: 'broadcast', event, payload });
        return true;
      } catch (err) {
        if (Date.now() - lastSendWarnAt > 60_000) {
          lastSendWarnAt = Date.now();
          console.warn(`[team] realtime send failed (project:${projectId}): ${err.message}`);
        }
        return false;
      }
    },
    async close() {
      const open = [...channels.values()];
      channels.clear();
      for (const entry of open) {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        try { if (entry.channel) await client?.removeChannel(entry.channel); } catch { /* ignore */ }
      }
      try { await client?.removeAllChannels(); } catch { /* ignore */ }
      client = null;
    },
  };
}

// The pure ledger behind the realtime circuit breaker, exported for tests:
// enough failures inside the window pause everything for pauseMs, and the
// pause re-arms if the flap resumes after it lifts.
export function channelFailureBreaker({ limit = 8, windowMs = 600_000, pauseMs = 1_800_000, now = () => Date.now() } = {}) {
  const failures = [];
  let pausedUntil = 0;
  return {
    paused: () => now() < pausedUntil,
    until: () => pausedUntil,
    note() {
      const at = now();
      failures.push(at);
      while (failures.length && failures[0] < at - windowMs) failures.shift();
      if (failures.length >= limit && at >= pausedUntil) {
        pausedUntil = at + pauseMs;
        failures.length = 0;
      }
      return now() < pausedUntil;
    },
  };
}

// ---------------------------------------------------------------------------
// Hub (tests). Same interface, JSON over HTTP; events over SSE. The bearer is
// the fixture user id; the hub applies the same membership rules as the RLS.

function hubTransport({ session, base }) {
  const userId = session.user.id;
  const clientId = crypto.randomUUID();
  const subs = new Map(); // projectId -> { controller, handlers }

  async function call(op, args = {}) {
    const res = await fetch(`${base}/t/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userId}` },
      body: JSON.stringify({ ...args, clientId }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`hub ${op} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    kind: 'hub',
    setToken() {},
    async probe() { return true; },
    memberships: () => call('memberships'),
    upsertProject: (row) => call('upsertProject', row),
    deleteProject: (id) => call('deleteProject', { id }),
    addMember: (row) => call('addMember', row),
    removeMember: (id) => call('removeMember', { id }),
    acceptInvites: () => call('acceptInvites'),
    listThreads: (projectIds) => call('listThreads', { projectIds }),
    getThread: (id) => call('getThread', { id }),
    listThreadHeads: (projectIds) => call('listThreadHeads', { projectIds }),
    deleteThread: (id) => call('deleteThread', { id }),
    putThread: (row) => call('putThread', row),
    listPlays: (projectIds) => call('listPlays', { projectIds }),
    putPlay: (row) => call('putPlay', row),
    deletePlay: (id) => call('deletePlay', { id }),
    putRunState: (args) => call('putRunState', args),
    clearRunState: (tabId) => call('clearRunState', { tabId }),
    listRunState: (taskId) => call('listRunState', { taskId }),
    acquireLease: (args) => call('acquireLease', args),
    releaseLease: (args) => call('releaseLease', args),
    getLease: (taskId) => call('getLease', { taskId }),
    listQueue: (projectIds) => call('listQueue', { projectIds }),
    enqueue: (row) => call('enqueue', row),
    updateQueue: (id, patch, opts = {}) => call('updateQueue', { id, patch, ifStatus: opts.ifStatus || null }),
    async subscribe(projectId, handler) {
      let entry = subs.get(projectId);
      if (!entry) {
        const controller = new AbortController();
        entry = { controller, handlers: new Set() };
        subs.set(projectId, entry);
        const res = await fetch(`${base}/events/${encodeURIComponent(projectId)}?client=${clientId}`, {
          headers: { Authorization: `Bearer ${userId}` }, signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`hub subscribe → ${res.status}`);
        (async () => {
          try {
            for await (const frame of sseFrames(res.body)) {
              for (const fn of entry.handlers) {
                try { fn(frame.event, frame.payload); } catch (err) { console.error('[team] handler failed:', err.message); }
              }
            }
          } catch { /* aborted */ }
        })();
      }
      entry.handlers.add(handler);
      return () => {
        entry.handlers.delete(handler);
        if (!entry.handlers.size) { subs.delete(projectId); entry.controller.abort(); }
      };
    },
    broadcast: (projectId, event, payload) => call('broadcast', { projectId, event, payload }),
    async close() {
      for (const entry of subs.values()) entry.controller.abort();
      subs.clear();
    },
  };
}

// Parse an SSE body (data: lines carry JSON {event, payload}).
export async function* sseFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const json = t.slice(5).trim();
        if (!json) continue;
        try { yield JSON.parse(json); } catch { /* skip */ }
      }
    }
  }
}
