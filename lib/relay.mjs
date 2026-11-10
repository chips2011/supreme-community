// Phase A relay: remote control through Supabase, no tunnel. See docs/relay.md.
//
// The desktop backend joins the account's Realtime channel and advertises
// presence. The phone (another client on the same account) sends commands over
// broadcast; we replay each against THIS server's own HTTP routes on localhost
// — so every bit of run/cancel logic is reused untouched — and stream the
// results back over a per-command broadcast channel. When the phone is offline
// the command sits in the `commands` table and we drain it on connect (wake).
//
// Inert unless Supabase is configured and a user session is attached.

import os from 'node:os';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import * as sb from './supabase.mjs';
import * as credhandoff from './credhandoff.mjs';

const RUNNER_KIND = process.env.WB_RUNNER_KIND === 'cloud' ? 'cloud' : 'desktop';
const RUNNER_TASK = RUNNER_KIND === 'cloud' ? (process.env.WB_TASK || null) : null;
const RUNNER_ID = process.env.WB_RUNNER_ID || `${RUNNER_KIND}-${crypto.randomUUID()}`;
const MACHINE = os.hostname().replace(/\.local$/, '');

let client = null;
let control = null;      // the command + heartbeat channel
let connected = false;   // true only after Realtime confirms SUBSCRIBED
let session = null;      // { token, user, port }
let heartbeat = null;    // interval broadcasting online-ness
let queueTimer = null;   // retries commands persisted during runner transitions
let draining = false;
let attachSeq = 0;       // a later attachSession supersedes an earlier one mid-flight
const HEARTBEAT_MS = Number(process.env.WB_RELAY_HEARTBEAT_MS || 10_000);
const QUEUE_DRAIN_MS = Number(process.env.WB_RELAY_DRAIN_MS || 15_000);
// Tests swap the Supabase client for a fake; production never sets this.
const makeClient = (url, key, opts) => (globalThis.__supremeRelayClientFactory || createClient)(url, key, opts);

function stopTimers() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
}
function startTimers() {
  stopTimers();
  sendHeartbeat();
  heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
  drainQueue().catch((err) => console.error('[relay] drain failed:', err.message));
  queueTimer = setInterval(() => {
    drainQueue().catch((err) => console.error('[relay] drain failed:', err.message));
  }, QUEUE_DRAIN_MS);
}

export function status() {
  return {
    configured: sb.isConfigured(),
    connected,
    runnerId: RUNNER_ID,
    runnerKind: RUNNER_KIND,
    taskId: RUNNER_TASK,
    machine: MACHINE,
    user: session ? session.user?.id : null,
  };
}

export async function attachSession(next) {
  if (!sb.isConfigured() || !next?.token || !next?.user?.id) return status();
  const attempt = ++attachSeq;
  await clearSession();
  // The hourly token renewal and a sign-in can overlap; the later attach owns
  // the session and an earlier one still mid-await must not join a channel.
  if (attempt !== attachSeq) return status();
  session = next;
  const { url, anonKey } = sb.config();

  const rt = makeClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.token}` } },
  });
  client = rt;
  // Authorize Realtime with the user's JWT so channel access is per-account.
  // MUST await — otherwise the channel join races ahead as the `anon` role and
  // private-channel RLS (which targets `authenticated`) rejects every topic.
  await rt.realtime.setAuth(session.token);
  if (attempt !== attachSeq) {
    try { await rt.removeAllChannels(); } catch { /* ignore */ }
    return status();
  }

  const userId = session.user.id;
  const chan = rt.channel(`control:${userId}`, {
    // private: enforced by RLS on realtime.messages (migration 0003) — only this
    // account can join/send on control:<its own id>.
    config: { private: true, broadcast: { self: false } },
  });
  control = chan;
  chan.on('broadcast', { event: 'command' }, ({ payload }) => {
    if (control !== chan) return;
    // Fire and forget — never block the socket callback on a long run.
    handleBroadcastCommand(payload).catch((err) => console.error('[relay] command failed:', err.message));
  });

  await new Promise((resolve) => {
    chan.subscribe((state) => {
      // A channel a later attach tore down still delivers its last states;
      // they must not touch the live channel's timers or flag.
      if (control !== chan) { resolve(); return; }
      if (state === 'SUBSCRIBED') {
        connected = true;
        // Online signal is a broadcast heartbeat (Realtime Presence writes are
        // dropped by realtime.messages RLS on private channels; broadcast is the
        // authorized path). The phone treats "no heartbeat for >30s" as asleep.
        startTimers();
        resolve();
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
        connected = false;
        stopTimers();
        resolve();
      } else if (state === 'CLOSED') {
        connected = false;
        stopTimers();
      }
    });
  });
  return status();
}

export async function clearSession() {
  stopTimers();
  try { if (control) { await client.removeChannel(control); } } catch { /* ignore */ }
  try { if (client) await client.removeAllChannels(); } catch { /* ignore */ }
  control = null;
  connected = false;
  client = null;
  session = null;
}

// Current session (token + user) for the handoff endpoints. Not exposed over any
// API — internal to the backend.
export function sessionInfo() {
  return session ? { token: session.token, userId: session.user?.id } : null;
}

// Desktop side of the credential handoff: wait for the cloud worker to announce
// its public key on the private handoff:{userId} channel, encrypt the local
// creds to it, and send. Resolves once sent.
export async function sendCreds(creds, timeoutMs = 60_000, { requireWorkspaceVersion = 0 } = {}) {
  if (!client || !session) throw new Error('relay not attached');
  // Re-assert the JWT before opening this SECOND private channel. supabase-js
  // authorizes the socket on the first channel join but does not carry the token
  // to subsequent private-channel joins, so without this the handoff topic is
  // authorized as `anon` and RLS rejects it (CHANNEL_ERROR: Unauthorized).
  await client.realtime.setAuth(session.token);
  const chan = client.channel(`handoff:${session.user.id}`, { config: { private: true, broadcast: { self: false } } });
  let sent = false;
  let workerRunnerId = null;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cloud worker did not become ready in time')), timeoutMs);
      chan.on('broadcast', { event: 'worker-pubkey' }, async ({ payload }) => {
        if (sent || !payload?.pubkey) return;
        sent = true;
        workerRunnerId = payload.runnerId || null;
        try {
          const envelope = credhandoff.encrypt(payload.pubkey, creds);
          await chan.send({ type: 'broadcast', event: 'creds', payload: { envelope } });
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      chan.on('broadcast', { event: 'worker-ready' }, ({ payload }) => {
        if (!sent) return;
        if (workerRunnerId && payload?.runnerId !== workerRunnerId) return;
        if (requireWorkspaceVersion && payload?.workspaceVersion !== requireWorkspaceVersion) {
          clearTimeout(timer);
          reject(new Error('the cloud worker image is too old to preserve workspace files'));
          return;
        }
        clearTimeout(timer);
        resolve();
      });
      chan.subscribe((s) => {
        if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(`handoff channel ${s}`)); }
      });
    });
  } finally {
    try { await client?.removeChannel(chan); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Command execution: replay against this server's own localhost routes.

const base = () => `http://127.0.0.1:${session.port}`;

async function acceptsCommand(cmd) {
  if (RUNNER_TASK && cmd?.type === 'run' && cmd.taskId !== RUNNER_TASK) return false;
  if (typeof session?.acceptCommand !== 'function') return true;
  return (await session.acceptCommand(cmd)) !== false;
}

// Live run broadcasts are first persisted with cmdId as the row id, then
// atomically claimed. This makes a phone command durable during a desktop to
// cloud transition and ensures that two connected runners cannot execute the
// same command twice. Older phone builds need no protocol change.
async function handleBroadcastCommand(cmd) {
  if (!cmd || !cmd.type) return;
  if (cmd.type !== 'run') {
    if (!(await acceptsCommand(cmd))) return;
    return handleCommand(cmd);
  }
  const cmdId = /^[0-9a-f-]{36}$/i.test(String(cmd.cmdId || ''))
    ? String(cmd.cmdId).toLowerCase()
    : crypto.randomUUID();
  const row = { id: cmdId, user_id: session.user.id, payload: { ...cmd, cmdId }, status: 'queued' };
  const { error } = await client.from('commands').insert(row);
  if (error && error.code !== '23505') throw error;
  if (!(await acceptsCommand(row.payload))) return;
  const claimed = await claimCommand(row.id);
  if (claimed) await executeClaimed(claimed);
}

async function claimCommand(id) {
  const { data, error } = await client
    .from('commands')
    .update({ status: 'claimed', claimed_by: RUNNER_ID, claimed_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'queued').select();
  if (error) throw error;
  return data?.[0] || null;
}

async function executeClaimed(row) {
  try {
    const result = await handleCommand({ ...row.payload, cmdId: row.payload?.cmdId || row.id });
    const ok = result?.ok !== false;
    await client.from('commands').update({
      status: ok ? 'done' : 'failed',
      result: result || { ok: true },
    }).eq('id', row.id);
  } catch (err) {
    await client.from('commands').update({ status: 'failed', result: { ok: false, error: err.message } }).eq('id', row.id);
    throw err;
  }
}

async function handleCommand(cmd) {
  if (!cmd || !cmd.type) return;
  const cmdId = cmd.cmdId || crypto.randomUUID();
  switch (cmd.type) {
    case 'run': return runCommand(cmd, cmdId);
    case 'cancel': {
      await fetch(`${base()}/api/runs/${encodeURIComponent(cmd.runId)}/cancel`, { method: 'POST' }).catch(() => {});
      return ack({ cmdId, ok: true });
    }
    case 'snapshot': {
      const snap = await fetch(`${base()}/api/remote`).then((r) => r.json()).catch(() => null);
      return sendControl('snapshot-result', { cmdId, snapshot: snap });
    }
    default:
      return ack({ cmdId, ok: false, error: `unknown command ${cmd.type}` });
  }
}

// Start a turn and relay its SSE frames onto run:{userId}:{cmdId}. The phone
// subscribes to that channel (keyed by the cmdId it chose) before sending, so
// no early frames are missed.
async function runCommand(cmd, cmdId) {
  const userId = session.user.id;
  // Re-assert the JWT before this second private channel (see sendCreds).
  await client.realtime.setAuth(session.token);
  const out = client.channel(`run:${userId}:${cmdId}`, { config: { private: true, broadcast: { self: false } } });
  await new Promise((res) => out.subscribe((s) => (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR') && res()));
  const emit = (frame) => out.send({ type: 'broadcast', event: 'event', payload: frame }).catch(() => {});

  try {
    const res = await fetch(`${base()}/api/tasks/${cmd.taskId}/tabs/${cmd.tabId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: cmd.prompt, model: cmd.model, effort: cmd.effort }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      const error = `run ${res.status} ${detail}`.trim();
      await ack({ cmdId, ok: false, error });
      await emit({ type: 'error', message: error, at: new Date().toISOString() });
      return { ok: false, error };
    }
    let runId = null;
    for await (const frame of sseFrames(res.body)) {
      runId = runId || frame.runId || frame.run?.id || (frame.type === 'start' ? frame.id : null);
      emit(frame);
    }
    await ack({ cmdId, ok: true, runId });
    return { ok: true, runId };
  } catch (err) {
    await ack({ cmdId, ok: false, error: err.message });
    await emit({ type: 'error', message: err.message, at: new Date().toISOString() });
    return { ok: false, error: err.message };
  } finally {
    setTimeout(() => { try { client?.removeChannel(out); } catch { /* ignore */ } }, 2000);
  }
}

// Parse an SSE body (data: only, no event: lines) into JSON frames.
async function* sseFrames(body) {
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
        try { yield JSON.parse(json); } catch { /* skip malformed */ }
      }
    }
  }
}

function sendControl(event, payload) {
  // Never send on a channel that is not joined: supabase-js would fall back
  // to a REST POST per call, which is the egress this file used to burn.
  if (!connected || !control) return Promise.resolve();
  return control.send({ type: 'broadcast', event, payload }).catch(() => {});
}
function sendHeartbeat() {
  return sendControl('heartbeat', {
    machine: MACHINE,
    state: 'online',
    runnerId: RUNNER_ID,
    runnerKind: RUNNER_KIND,
    taskId: RUNNER_TASK,
    at: new Date().toISOString(),
  });
}
function ack(payload) {
  return sendControl('ack', payload);
}

// ---------------------------------------------------------------------------
// Offline queue: commands the phone left while the Mac was asleep.

async function drainQueue() {
  if (!client || !session || draining) return;
  draining = true;
  try {
    const { data: rows, error } = await client
      .from('commands').select('*').eq('status', 'queued').order('created_at', { ascending: true });
    if (error) throw error;
    for (const row of rows || []) {
      const command = { ...row.payload, cmdId: row.payload?.cmdId || row.id };
      if (!(await acceptsCommand(command))) continue;
      const claimed = await claimCommand(row.id);
      if (claimed) await executeClaimed(claimed);
    }
  } finally {
    draining = false;
  }
}
