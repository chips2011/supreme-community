// Section 34, Landed on the phone (2026-10-05). When this person last read
// each tab, kept in Supabase (tab_seen, migration 0014) so their phone and
// their other Macs share one Landed list. The window keeps its own looks in
// localStorage as before (web/src/lib/vitality.ts); it posts the stamps that
// matter here and reads back the ones made elsewhere. Best effort: signed
// out, or before 0014 is applied, Landed simply stays per device.
import * as sb from './supabase.mjs';

const PULL_EVERY_MS = Number(process.env.WB_SEEN_PULL_MS) || 15_000;
// A project without 0014 is asked again now and then, not on every poll.
const MISSING_RETRY_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let stamps = new Map(); // `${threadId}:${tabId}` -> ms
let owner = null; // the user the cached stamps belong to
let pulledAt = 0;
let pulling = null;
let missingUntil = 0;

export function resetSeen() {
  stamps = new Map();
  owner = null;
  pulledAt = 0;
  pulling = null;
  missingUntil = 0;
}

function usable(session, now) {
  return !!session?.token && sb.isConfigured() && now >= missingUntil;
}

function forUser(session) {
  const id = session?.userId || null;
  if (id !== owner) {
    stamps = new Map();
    owner = id;
    pulledAt = 0;
  }
}

function keep(threadId, tabId, at) {
  const key = `${threadId}:${tabId}`;
  if (at > (stamps.get(key) || 0)) stamps.set(key, at);
}

function tableMissing(err) {
  return /tab_seen|mark_seen/.test(err.message) && /PGRST20[25]|42P01|42883|does not exist|Could not find/.test(err.message);
}

async function pull(session) {
  try {
    const rows = await sb.rest('tab_seen?select=thread_id,tab_id,seen_at&order=seen_at.desc&limit=5000', { token: session.token });
    for (const row of rows || []) {
      const at = Date.parse(row.seen_at || '');
      if (row.thread_id && row.tab_id && Number.isFinite(at)) keep(row.thread_id, row.tab_id, at);
    }
  } catch (err) {
    if (tableMissing(err)) missingUntil = Date.now() + MISSING_RETRY_MS;
    else console.warn('[seen] read failed:', err.message);
  }
  pulledAt = Date.now();
}

// Every stamp made on any of this person's devices, read back at most every
// fifteen seconds however often the window asks.
export async function readSeen(session, { now = Date.now() } = {}) {
  if (!usable(session, now)) return {};
  forUser(session);
  if (now - pulledAt >= PULL_EVERY_MS) {
    pulling ||= pull(session).finally(() => { pulling = null; });
    await pulling;
  }
  return Object.fromEntries(stamps);
}

// [{ threadId, tabId, at }] where `at` is ms or an ISO time. Kept here at
// once, so the next read already has them, then written to the cloud.
export async function markSeen(session, list, { now = Date.now() } = {}) {
  const clean = [];
  for (const item of Array.isArray(list) ? list : []) {
    const threadId = String(item?.threadId || '');
    const tabId = String(item?.tabId || '');
    const at = typeof item?.at === 'number' ? item.at : Date.parse(String(item?.at || ''));
    if (!UUID.test(threadId) || !tabId || tabId.length > 200 || !Number.isFinite(at) || at <= 0) continue;
    clean.push({ threadId, tabId, at: Math.min(at, now + 60_000) });
  }
  if (!clean.length || !usable(session, now)) return { saved: 0, cloud: false };
  forUser(session);
  for (const item of clean) keep(item.threadId, item.tabId, item.at);
  try {
    const saved = await sb.rest('rpc/mark_seen', {
      method: 'POST',
      token: session.token,
      body: { p_stamps: clean.map((item) => ({ thread_id: item.threadId, tab_id: item.tabId, seen_at: new Date(item.at).toISOString() })) },
    });
    return { saved: Number(saved) || 0, cloud: true };
  } catch (err) {
    if (tableMissing(err)) missingUntil = Date.now() + MISSING_RETRY_MS;
    else console.warn('[seen] write failed:', err.message);
    return { saved: 0, cloud: false, error: err.message };
  }
}
