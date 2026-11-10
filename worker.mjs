// Cloud worker runtime (Phase B). A headless, ephemeral instance of the normal
// backend that runs the agent AS the user while their laptop is off. It reuses
// server.mjs wholesale: it boots it, signs in with the user's Supabase session
// (which attaches the relay + sync), takes the execution lease as `cloud-<id>`,
// and lets the phone drive it over the relay exactly like a desktop. It exits —
// releasing the lease — on idle timeout or SIGTERM (Fly machine teardown).
//
// Env:
//   SUPABASE_URL / SUPABASE_ANON_KEY  (via .env)     required
//   WB_SESSION_TOKEN                                   required — user access token
//   WB_USER_ID                                         required — user id
//   WB_TASK                                            required — task to guard with the lease
//   WORKBENCH_HOME                                     worker data dir (ephemeral)
//   WB_PORT            default 4780
//   WB_IDLE_MS         default 300000 (5 min of no active runs -> flip back)
//
// Model credentials must already be present in this process's HOME (injected by
// the credential handoff, lib/credhandoff.mjs) before any run is commanded.
import './lib/env.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import * as lease from './lib/lease.mjs';
import * as sb from './lib/supabase.mjs';
import * as credhandoff from './lib/credhandoff.mjs';
import * as workspaceHandoff from './lib/workspace-handoff.mjs';
import { getTask } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.WB_SESSION_TOKEN;
const USER_ID = process.env.WB_USER_ID;
const TASK = process.env.WB_TASK;
const PORT = Number(process.env.WB_PORT || 4780);
const IDLE_MS = Number(process.env.WB_IDLE_MS || 300_000);
const MAX_LIFETIME_MS = Number(process.env.WB_MAX_LIFETIME_MS || 6 * 60 * 60 * 1000); // hard cap: never bill forever
const DO_HANDOFF = process.env.WB_HANDOFF === '1'; // receive encrypted creds before running
const DO_WORKSPACE_HANDOFF = process.env.WB_WORKSPACE_HANDOFF === '1';
const OWNER = `cloud-${randomUUID().slice(0, 8)}`;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[worker]', ...a);

if (!TOKEN || !USER_ID || !TASK) {
  console.error('worker requires WB_SESSION_TOKEN, WB_USER_ID, WB_TASK');
  process.exit(1);
}

let server = null;
let heartbeatTimer = null;
let idleTimer = null;
let lastActive = Date.now();
let shuttingDown = false;
let handoffResources = null;
let workspaceReady = false;

async function main() {
  fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  // 1. Boot the normal backend headlessly.
  server = spawn('node', ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      WB_RUNNER_KIND: 'cloud',
      WB_RUNNER_ID: OWNER,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  server.on('exit', (code) => { if (!shuttingDown) { log('server exited', code); process.exit(code || 1); } });

  // 2. Wait for it to answer.
  for (let i = 0; i < 40; i++) {
    if (await ping()) break;
    await sleep(250);
    if (i === 39) throw new Error('backend did not come up');
  }

  // 2b. Receive the user's model credentials over the encrypted handoff channel
  // (cloud flow only) and write them into HOME before any run is commanded.
  if (DO_HANDOFF) {
    handoffResources = await receiveCredentials();
    log('credentials received + written');
  }

  // Hard lifetime cap — belt-and-suspenders against a stuck worker billing forever.
  setTimeout(() => { log('max lifetime reached — shutting down'); shutdown(0); }, MAX_LIFETIME_MS);

  // 3. Take the lease before joining the phone command channel. This removes
  // the window where a booting worker could accept a command before it owns
  // the handed-off task.
  let owned = false;
  for (let i = 0; i < 12 && !owned; i++) {
    const eff = await lease.acquire(TASK, OWNER, TOKEN);
    owned = lease.held(eff, OWNER);
    if (!owned) { log(`lease held by ${eff}; waiting…`); await sleep(2500); }
  }
  if (!owned) throw new Error('could not acquire lease (desktop still active?)');
  log(`lease acquired as ${OWNER}`);

  // 4. Sign in, hydrate the thread, and attach the phone relay.
  const r = await fetch(`${base}/api/auth/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: TOKEN, user: { id: USER_ID } }),
  });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status} ${await r.text().catch(() => '')}`);
  for (let i = 0; i < 60; i++) {
    const status = await fetch(`${base}/api/auth/status`).then((x) => x.json()).catch(() => null);
    if (status?.relay?.connected) break;
    if (i === 59) throw new Error('relay did not connect');
    await sleep(250);
  }
  log('signed in; relay attached');
  if (DO_WORKSPACE_HANDOFF) {
    const task = getTask(TASK);
    if (!task) throw new Error('handed-off thread did not hydrate');
    const workspace = await workspaceHandoff.hydrateCloudWorkspace({ task, token: TOKEN, userId: USER_ID });
    workspaceReady = true;
    log(`workspace restored (${workspace})`);
  }
  if (handoffResources) {
    const readyState = await fetch(`${base}/api/handoff/worker-ready`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: process.env.FLY_MACHINE_ID || '' }),
    });
    if (!readyState.ok) throw new Error(`could not persist worker state: ${readyState.status}`);
    await signalReady(handoffResources);
    handoffResources = null;
  }

  // 5. Keep the lease alive + watch for idle.
  heartbeatTimer = setInterval(() => {
    lease.acquire(TASK, OWNER, TOKEN).catch((e) => log('heartbeat failed:', e.message));
  }, 10_000);
  idleTimer = setInterval(checkIdle, 15_000);
  log(`running. idle flip-back after ${Math.round(IDLE_MS / 1000)}s of no active runs.`);
}

async function ping() {
  try { const r = await fetch(`${base}/api/status`); return r.ok; } catch { return false; }
}

// Receive the user's model credentials over the encrypted handoff channel: we
// publish our public key on the private handoff:{userId} channel; the desktop
// encrypts the creds to it and sends them back. Only our in-RAM private key can
// open them. Written to HOME so the CLIs find them; destroyed with the machine.
async function receiveCredentials() {
  const { url, anonKey } = sb.config();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await client.realtime.setAuth(TOKEN);
  const kp = credhandoff.newKeypair();
  const chan = client.channel(`handoff:${USER_ID}`, { config: { private: true, broadcast: { self: false } } });
  let announceTimer = null;
  try {
    const creds = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handoff timed out')), 90_000);
      chan.on('broadcast', { event: 'creds' }, ({ payload }) => {
        try { const c = credhandoff.decrypt(kp.privateKey, payload.envelope); clearTimeout(timer); resolve(c); }
        catch (e) { clearTimeout(timer); reject(e); }
      });
      chan.subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          // Re-announce our pubkey periodically until the creds arrive — the
          // desktop may only subscribe after the machine has finished booting.
          const announce = () => chan.send({ type: 'broadcast', event: 'worker-pubkey', payload: { runnerId: OWNER, pubkey: kp.publicKeyB64 } });
          announce();
          announceTimer = setInterval(announce, 2000);
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          reject(new Error(`handoff channel ${s}`));
        }
      });
    });
    credhandoff.writeCreds(creds, process.env.HOME);
    if (announceTimer) clearInterval(announceTimer);
    return { client, chan };
  } catch (error) {
    if (announceTimer) clearInterval(announceTimer);
    try { await client.removeChannel(chan); } catch { /* ignore */ }
    throw error;
  }
}

async function signalReady({ client, chan }) {
  try {
    for (let i = 0; i < 3; i++) {
      await chan.send({
        type: 'broadcast',
        event: 'worker-ready',
        payload: { runnerId: OWNER, taskId: TASK, workspaceVersion: workspaceReady ? 1 : 0 },
      });
      await sleep(250);
    }
  } finally {
    try { await client.removeChannel(chan); } catch { /* ignore */ }
  }
}

async function checkIdle() {
  try {
    const snap = await fetch(`${base}/api/remote`).then((x) => x.json());
    if ((snap.activeCount || 0) > 0) lastActive = Date.now();
    else if (Date.now() - lastActive > IDLE_MS) { log('idle — flipping back'); await shutdown(0); }
  } catch { /* transient */ }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  clearInterval(idleTimer);
  if (handoffResources) {
    try { await handoffResources.client.removeChannel(handoffResources.chan); } catch { /* ignore */ }
    handoffResources = null;
  }
  let workspaceError = '';
  if (workspaceReady) {
    let snapshot = null;
    for (let attempt = 1; attempt <= 3 && !snapshot; attempt += 1) {
      try {
        const task = getTask(TASK);
        if (!task) throw new Error('handed-off thread is missing');
        snapshot = await workspaceHandoff.captureCloudWorkspace({ task, token: TOKEN, userId: USER_ID });
        const receipt = await fetch(`${base}/api/handoff/worker-workspace`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot }),
        });
        if (!receipt.ok) throw new Error(`workspace receipt failed: ${receipt.status}`);
        workspaceError = '';
        log(`workspace returned (${snapshot.fileCount} files)`);
      } catch (error) {
        workspaceError = error.message || 'workspace return failed';
        snapshot = null;
        if (attempt < 3) await sleep(attempt * 750);
      }
    }
  }
  try { await lease.release(TASK, OWNER, TOKEN); log('lease released'); } catch { /* ignore */ }
  try {
    await fetch(`${base}/api/handoff/worker-stopping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceError }),
    });
  } catch { /* ignore */ }
  try { await fetch(`${base}/api/auth/signout`, { method: 'POST' }); } catch { /* ignore */ }
  try { credhandoff.purgeCreds(process.env.HOME); } catch { /* ignore */ }
  try { server?.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(300);
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

main().catch((err) => { console.error('[worker] fatal:', err.message); shutdown(1); });
