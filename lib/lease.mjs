// Execution lease client (Phase B). Wraps the atomic acquire/release DB
// functions (migration 0004) so a runner — desktop or cloud worker — can claim a
// task and be sure it's the only one running it. See docs/cloud-worker.md.
import * as sb from './supabase.mjs';

const TTL_SECONDS = 30; // a lease older than this (no heartbeat) is stealable

// Try to acquire/renew. Returns the effective owner string; compare with your
// own owner id (use held()) to decide whether you may run.
export async function acquire(taskId, owner, token, ttl = TTL_SECONDS) {
  const eff = await sb.rest('rpc/acquire_lease', {
    method: 'POST', token,
    body: { p_task: taskId, p_owner: owner, p_ttl_seconds: ttl },
  });
  return typeof eff === 'string' ? eff : (eff == null ? null : String(eff));
}

export async function release(taskId, owner, token) {
  await sb.rest('rpc/release_lease', {
    method: 'POST', token,
    body: { p_task: taskId, p_owner: owner },
  });
}

export function held(effectiveOwner, owner) {
  return effectiveOwner === owner;
}
