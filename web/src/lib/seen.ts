import { api } from '../api';
import { set, state } from '../store';
import { setSharedSeen, sharedSeenAt, tabReturned, tabSeenAt, unreadSince } from './vitality';

const PULL_EVERY_MS = 15_000;
const PUSH_BATCH = 200;

const written = new Map<string, number>();
let pulledAt = 0;
let busy = false;

interface Stamp { threadId: string; tabId: string; at: number }

// What this Mac would tell another device about each tab right now.
export function seenStamps(): Stamp[] {
  const out: Stamp[] = [];
  const floor = unreadSince();
  for (const thread of state.threads) {
    if (thread.archived) continue;
    for (const tab of thread.tabs || []) {
      const back = Date.parse(tab.returnedAt || '');
      if (!Number.isFinite(back)) continue;
      const looked = Math.max(tabSeenAt(thread.id, tab.id), floor);
      const at = tabReturned(thread.id, tab) ? looked : Math.max(looked, back);
      if (Number.isFinite(at) && at > 0) out.push({ threadId: thread.id, tabId: tab.id, at });
    }
  }
  return out;
}

// The smoke drives a sync without waiting out the timers.
(window as unknown as { __supremeSyncSeen?: typeof syncSeen }).__supremeSyncSeen = syncSeen;

export async function syncSeen({ force = false } = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (force || Date.now() - pulledAt >= PULL_EVERY_MS) {
      pulledAt = Date.now();
      const read = await api<{ stamps?: Record<string, number> }>('/api/seen').catch(() => null);
      if (read?.stamps && setSharedSeen(read.stamps)) set();
    }
    const due = seenStamps().filter((stamp) => {
      const key = `${stamp.threadId}:${stamp.tabId}`;
      return stamp.at > (written.get(key) || 0) && stamp.at > sharedSeenAt(stamp.threadId, stamp.tabId);
    });
    for (let at = 0; at < due.length; at += PUSH_BATCH) {
      const batch = due.slice(at, at + PUSH_BATCH);
      const result = await api<{ cloud?: boolean }>('/api/seen', { method: 'POST', body: JSON.stringify({ stamps: batch }) }).catch(() => null);
      if (!result?.cloud) break;
      for (const stamp of batch) written.set(`${stamp.threadId}:${stamp.tabId}`, stamp.at);
    }
  } finally {
    busy = false;
  }
}
