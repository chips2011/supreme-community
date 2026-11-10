// Fly Machines API client — boot and destroy the on-demand cloud workers.
// Boots a throwaway machine from the pushed worker image with per-user env; the
// machine auto-destroys when the worker process exits (idle/flip-back), so a
// crashed handoff can't bill forever.
//
// Env (desktop side — see the broker note in docs/cloud-worker.md before ships):
//   FLY_API_TOKEN, FLY_APP (default conductor-worker), WORKER_IMAGE (registry ref)
import { execFileSync } from 'node:child_process';

const API = 'https://api.machines.dev/v1';
const KEYCHAIN_SERVICE = 'com.meetsupreme.community.cloud-worker';
let keychainCache = null;

function keychainValue(account) {
  if (process.platform !== 'darwin' || process.env.WB_MODEL_USAGE_FIXTURE === '1') return '';
  try {
    return execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function keychainConfig() {
  if (keychainCache) return keychainCache;
  keychainCache = {
    token: keychainValue('api-token'),
    app: keychainValue('fly-app'),
    image: keychainValue('worker-image'),
    region: keychainValue('fly-region'),
  };
  return keychainCache;
}

function cfg() {
  const saved = keychainConfig();
  return {
    token: process.env.FLY_API_TOKEN || saved.token || '',
    app: process.env.FLY_APP || saved.app || '',
    image: process.env.WORKER_IMAGE || saved.image || '',
    region: process.env.FLY_REGION || saved.region || 'sjc',
  };
}

export function isConfigured() {
  const c = cfg();
  return !!(c.token && c.app && c.image);
}

async function api(path, { method = 'GET', body } = {}) {
  const c = cfg();
  const res = await fetch(`${API}/apps/${c.app}${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const error = new Error(`fly ${method} ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
    error.status = res.status;
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Boot a worker for one user session. Returns { id, ... }. `env` carries the
// Supabase session (WB_SESSION_TOKEN/WB_USER_ID/WB_TASK) + Supabase keys.
export async function bootWorker({ env, memoryMb = 512 }) {
  const c = cfg();
  return api('/machines', {
    method: 'POST',
    body: {
      region: c.region,
      config: {
        image: c.image,
        env,
        auto_destroy: true,                 // machine self-destructs when worker.mjs exits
        restart: { policy: 'no' },          // never resurrect a finished worker
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: memoryMb },
      },
    },
  });
}

// Run the handoff steps that must succeed after a Machine boots. If credential
// transfer or local state persistence fails, tear the Machine down immediately
// instead of leaving a paid stray behind.
export async function bootWorkerForHandoff(options, handoff, runtime = {}) {
  const boot = runtime.bootWorker || bootWorker;
  const destroy = runtime.destroyWorker || destroyWorker;
  const machine = await boot(options);
  try {
    return await handoff(machine);
  } catch (error) {
    try {
      await destroy(machine.id);
    } catch (cleanupError) {
      throw new Error(
        `${error.message}; failed to destroy cloud worker ${machine.id}: ${cleanupError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function destroyWorker(machineId) {
  return api(`/machines/${encodeURIComponent(machineId)}?force=true`, { method: 'DELETE' });
}

// Normal flip-back is graceful: SIGTERM gives worker.mjs time to flush the
// final transcript, release its execution lease, and scrub credentials. The
// Machine has auto_destroy enabled, so exiting removes it. A worker that
// already self-destroyed on idle is an idempotent success.
export async function stopWorker(machineId) {
  try {
    return await api(`/machines/${encodeURIComponent(machineId)}/stop`, {
      method: 'POST',
      body: { signal: 'SIGTERM', timeout: '60s' },
    });
  } catch (error) {
    if (error.status === 404) return { ok: true, missing: true };
    throw error;
  }
}

export async function listWorkers() {
  return api('/machines');
}
