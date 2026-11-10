import { state } from '../store';
import { rowCameBack, rowReturned } from './rail';
import { tabReturnedAt } from './vitality';
import type { SummaryTab, TaskSummary } from '../types';

export interface LandedRow { threadId: string; tabId: string; landedAt: number; thread: TaskSummary; tab: SummaryTab }

export const landedKey = (row: { threadId: string; tabId: string }): string => `${row.threadId}:${row.tabId}`;

function landedAtOf(threadId: string, tab: SummaryTab): number {
  const cached = state.cache[threadId]?.tabs?.find((candidate) => candidate.id === tab.id);
  const last = cached ? [...(cached.messages || [])].reverse().find((message) => !message.hiddenInTranscript) : null;
  const fromCache = last?.role === 'assistant' ? Date.parse(last.ts || '') : NaN;
  const fromRow = Date.parse(tab.returnedAt || tab.landedAt || '');
  return Math.max(Number.isFinite(fromCache) ? fromCache : 0, Number.isFinite(fromRow) ? fromRow : 0);
}

const byKey = (a: LandedRow, b: LandedRow) => a.threadId.localeCompare(b.threadId) || a.tabId.localeCompare(b.tabId);

// Slack-created work stays in its own inbox, including unread answers and
// the recent-history fallback. This is a view filter, never a completion.
const outsideLanded = (thread: TaskSummary) => thread.archived || thread.origin === 'slack' || state.cache[thread.id]?.origin === 'slack';

export function landedRows(): LandedRow[] {
  const rows: LandedRow[] = [];
  for (const thread of state.threads) {
    if (outsideLanded(thread)) continue;
    for (const tab of thread.tabs || []) {
      if (!rowReturned(thread.id, tab)) continue;
      rows.push({ threadId: thread.id, tabId: tab.id, landedAt: landedAtOf(thread.id, tab), thread, tab });
    }
  }
  rows.sort((a, b) => a.landedAt - b.landedAt || byKey(a, b));
  return rows;
}

// Every tab whose last turn came back to you, newest first.
export function recentRows(): LandedRow[] {
  const rows: LandedRow[] = [];
  for (const thread of state.threads) {
    if (outsideLanded(thread)) continue;
    for (const tab of thread.tabs || []) {
      if (!rowCameBack(thread.id, tab)) continue;
      const returnedAt = tabReturnedAt(thread.id, tab);
      rows.push({ threadId: thread.id, tabId: tab.id, landedAt: Math.max(returnedAt, landedAtOf(thread.id, tab)), thread, tab });
    }
  }
  rows.sort((a, b) => b.landedAt - a.landedAt || byKey(a, b));
  return rows;
}

// What the page walks: the waiting rows while there are any, else the
// recents.
export function landedDeck(): { rows: LandedRow[]; recent: boolean } {
  const rows = landedRows();
  if (rows.length) return { rows, recent: false };
  return { rows: recentRows(), recent: true };
}

// Where the page is in the deck: how many are waiting, and the row before
// and after the one on screen. A row on screen that has left the deck
// (read, done, or back at work) still has neighbours, by when it landed:
// in the waiting list time runs forward, in the recents it runs back.
export function landedPlace(): { rows: LandedRow[]; recent: boolean; left: number; at: number; prev: LandedRow | null; next: LandedRow | null } {
  const { rows, recent } = landedDeck();
  const left = recent ? 0 : rows.length;
  const current = state.landedCurrent;
  const at = current ? rows.findIndex((row) => landedKey(row) === current) : -1;
  if (at >= 0) return { rows, recent, left, at, prev: rows[at - 1] || null, next: rows[at + 1] || null };
  const since = state.landedCurrentAt || 0;
  const before = rows.filter((row) => (recent ? row.landedAt > since : row.landedAt < since));
  const after = rows.filter((row) => (recent ? row.landedAt <= since : row.landedAt >= since));
  return { rows, recent, left, at, prev: before[before.length - 1] || null, next: after[0] || (current ? null : rows[0] || null) };
}
