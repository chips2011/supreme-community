import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as supabase from './supabase.mjs';

const EVERY_MS = Math.max(500, Number(process.env.WB_SLACK_RELAY_MS) || 2_000);
// A request older than this is dropped rather than run late.
const STALE_MS = 24 * 60 * 60_000;
const DIR = () => process.env.WB_SLACK_RELAY_DIR || '';
const state = { timer: null, busy: false, lastError: null };

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async put(row) { fs.writeFileSync(path.join(dir, `${row.id}.json.tmp`), JSON.stringify(row)); fs.renameSync(path.join(dir, `${row.id}.json.tmp`), path.join(dir, `${row.id}.json`)); },
    async take(recipient) {
      const out = [];
      for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
        const file = path.join(dir, name);
        let row;
        try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
        if (row.recipient !== recipient) continue;
        try { fs.renameSync(file, `${file}.picked`); } catch { continue; }
        out.push(row);
      }
      return out;
    },
    async picked(id) { return !fs.existsSync(path.join(dir, `${id}.json`)); },
  };
}

function cloudStore(token) {
  return {
    async put(row) {
      await supabase.rest('slack_relay', { method: 'POST', token, body: { id: row.id, recipient: row.recipient, kind: row.kind, payload: row.payload }, prefer: 'return=minimal' });
    },
    async take(recipient) {
      const rows = await supabase.rest(`slack_relay?recipient=eq.${encodeURIComponent(recipient)}&picked_at=is.null&order=created_at.asc&limit=20`, { token }) || [];
      const out = [];
      for (const row of rows) {
        // Stamped first, so a crash mid way never runs the same ask twice.
        const stamped = await supabase.rest(`slack_relay?id=eq.${encodeURIComponent(row.id)}&picked_at=is.null`, { method: 'PATCH', token, body: { picked_at: new Date().toISOString() }, prefer: 'return=representation' }).catch(() => null);
        if (Array.isArray(stamped) && stamped.length) out.push({ id: row.id, sender: row.sender, recipient: row.recipient, kind: row.kind, payload: row.payload, createdAt: row.created_at });
      }
      return out;
    },
    async picked(id) {
      const rows = await supabase.rest(`slack_relay?id=eq.${encodeURIComponent(id)}&select=picked_at`, { token }) || [];
      return !rows.length || !!rows[0].picked_at;
    },
  };
}

function storeFor(token) {
  if (DIR()) return fileStore(DIR());
  if (!token || !supabase.isConfigured()) return null;
  return cloudStore(token);
}

export function available(token) {
  return !!storeFor(token);
}

export async function send({ token, sender, recipient, kind, payload }) {
  const store = storeFor(token);
  if (!store) throw new Error('no relay: not signed in to Supreme');
  const row = { id: randomUUID(), sender, recipient, kind, payload, createdAt: new Date().toISOString() };
  await store.put(row);
  return row.id;
}

export async function wasPicked({ token, id }) {
  const store = storeFor(token);
  return store ? store.picked(id) : true;
}

export async function takeOnce({ token, me, onRow }) {
  const store = storeFor(token);
  if (state.busy || !store || !me) return 0;
  state.busy = true;
  let taken = 0;
  try {
    for (const row of await store.take(me)) {
      if (Date.now() - (Date.parse(row.createdAt || '') || Date.now()) > STALE_MS) continue;
      taken += 1;
      await Promise.resolve(onRow(row)).catch((err) => console.error('[slack] relayed ask failed:', err.message));
    }
    state.lastError = null;
  } catch (err) {
    if (state.lastError !== err.message) console.error('[slack] relay pickup:', err.message);
    state.lastError = err.message;
  } finally { state.busy = false; }
  return taken;
}

export function start({ token, me, onRow }) {
  if (state.timer) return false;
  state.timer = setInterval(() => { takeOnce({ token: token(), me: me(), onRow }).catch(() => {}); }, EVERY_MS);
  state.timer.unref?.();
  return true;
}

export function status() {
  return { lastError: state.lastError };
}
