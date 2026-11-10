import { meId, pendingConfirmation, state } from '../store';
import type { Message, SummaryTab, Tab, Task, TaskSummary } from '../types';

// Paper 16.5 to 16.10: completion and sleep. Three states off one token set.
// Working is the only thing that moves; awake is green and still; asleep is
// anything untouched for over a day. Touched means ran, opened or wrote to,
// not merely visible on screen. Nothing here archives, moves or hides.

// The number to tune. A starting point, per the brief.
export const SLEEP_AFTER_MS = 24 * 60 * 60 * 1000;

// What a tab or workstream is doing right now. Sleep is a separate axis
// (`tabAsleep`, `threadAsleep`) because a tab that is waiting on the user
// still sleeps around its pending action.
export type Vitality = 'working' | 'waiting' | 'awake' | 'failed' | 'quiet';

// Opened and selected happen on this Mac only, so they live in localStorage
// beside the other per-browser prefs; runs and messages carry server times.
const TOUCHES_KEY = 'wb_touches_v1';
// Section 28: an unread dot never decays, so the looks that clear it are
// kept far longer than a day of sleep ever needed.
const TOUCHES_KEPT = 3000;
let touches: Record<string, number> = {};
try {
  const parsed = JSON.parse(localStorage.getItem(TOUCHES_KEY) || '{}');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) touches[key] = value;
    }
  }
} catch { /* ignore */ }

function persistTouches(): void {
  try {
    const entries = Object.entries(touches).sort((a, b) => b[1] - a[1]).slice(0, TOUCHES_KEPT);
    touches = Object.fromEntries(entries);
    localStorage.setItem(TOUCHES_KEY, JSON.stringify(touches));
  } catch { /* ignore */ }
}

// Stamp a workstream, and one of its tabs, as touched right now.
export function touch(threadId: string, tabId?: string | null): void {
  const now = Date.now();
  touches[`t:${threadId}`] = now;
  if (tabId) touches[`b:${threadId}:${tabId}`] = now;
  persistTouches();
}

// Stamp a tab as the one put on screen: opened or selected here. A send
// touches the tab it runs (a handoff runs a sibling you never went to), so
// being on a tab is its own stamp.
export function view(threadId: string, tabId?: string | null): void {
  if (!tabId) return;
  touches[`v:${threadId}:${tabId}`] = Date.now();
  persistTouches();
}

// Test hook for the motion demo: pretend a workstream was last touched then.
export function backdateTouch(threadId: string, at: number, tabIds: string[] = []): void {
  touches[`t:${threadId}`] = at;
  for (const tabId of tabIds) touches[`b:${threadId}:${tabId}`] = at;
  persistTouches();
}

function latest(...values: (number | string | null | undefined)[]): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const at = typeof value === 'number' ? value : value ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && at > best) best = at;
  }
  return best;
}

export function isAsleep(touchedAt: number, now = Date.now()): boolean {
  return Number.isFinite(touchedAt) && now - touchedAt > SLEEP_AFTER_MS;
}

// The rail asks this of every tab on every paint, so it walks back from the
// end rather than filtering the whole transcript.
function lastVisible(tab: Tab): Message | undefined {
  const messages = tab.messages || [];
  for (let at = messages.length - 1; at >= 0; at -= 1) if (!messages[at].hiddenInTranscript) return messages[at];
  return undefined;
}

function visibleMessages(tab: Tab): Message[] {
  return (tab.messages || []).filter((message) => !message.hiddenInTranscript);
}

// A draft the model left behind without sending is the user's to approve.
function leftADraft(message: Message): boolean {
  const connectors = message.connectors || [];
  const touchesOutside = message.outsideTouches || [];
  const drafted = connectors.some((item) => item.action === 'draft') || touchesOutside.some((item) => item.action === 'draft');
  const sent = connectors.some((item) => item.action === 'send') || touchesOutside.some((item) => item.action === 'send');
  return drafted && !sent;
}

export function tabTouchedAt(task: Task, tab: Tab): number {
  const visible = visibleMessages(tab);
  const last = visible[visible.length - 1];
  return latest(
    touches[`b:${task.id}:${tab.id}`],
    last?.ts,
    tab.activeRun?.startedAt,
    visible.length ? null : task.lastActivity || task.createdAt,
  );
}

export function tabVitality(task: Task, tab: Tab): Vitality {
  const stream = state.streams[`${task.id}::${tab.id}`];
  if (stream?.landed) return stream.landed.green ? 'awake' : 'waiting';
  // Working means a live stream here or a run the server reports. The bare
  // `status: running` marker is set locally at send time and can outlive the
  // run when the read-back at the end fails, so on its own it is not proof.
  if (stream || tab.activeRun) return 'working';
  if (tab.type === 'duel') return 'quiet';
  if (pendingConfirmation(tab)) return 'waiting';
  const visible = visibleMessages(tab);
  const last = visible[visible.length - 1];
  if (!last || last.role !== 'assistant') return 'quiet';
  if (last.ok === false) return 'failed';
  if (last.stopped) return 'quiet';
  if (leftADraft(last)) return 'waiting';
  return 'awake';
}

export function tabAsleep(task: Task, tab: Tab, now = Date.now()): boolean {
  if (tabVitality(task, tab) === 'working') return false;
  return isAsleep(tabTouchedAt(task, tab), now);
}

// Looked at is not touched: a tab on screen while its turn lands, or on
// screen when you come back to the window, is looked at without that
// counting against sleep (touched means ran, opened or wrote to).
export function markSeen(threadId: string, tabId: string): void {
  touches[`s:${threadId}:${tabId}`] = Date.now();
  persistTouches();
}

// Section 34, Landed on the phone (2026-10-05): looks made on this person's
// phone or another Mac, by `thread:tab`, read back through the service
// (lib/seen.ts). Completing a tab on the phone is reading it here too.
let sharedSeen: Record<string, number> = {};

export function setSharedSeen(next: Record<string, number>): boolean {
  let changed = false;
  const merged = { ...sharedSeen };
  for (const [key, at] of Object.entries(next)) {
    if (typeof at === 'number' && Number.isFinite(at) && at > (merged[key] || 0)) { merged[key] = at; changed = true; }
  }
  if (changed) sharedSeen = merged;
  return changed;
}

export function sharedSeenAt(threadId: string, tabId: string): number {
  return sharedSeen[`${threadId}:${tabId}`] ?? Number.NEGATIVE_INFINITY;
}

// When this Mac last opened, selected, sent on or looked at a tab, or this
// person read it on another device; never, for one nobody has.
export function tabSeenAt(threadId: string, tabId: string): number {
  return latest(touches[`b:${threadId}:${tabId}`], touches[`s:${threadId}:${tabId}`], sharedSeen[`${threadId}:${tabId}`]);
}

const UNREAD_FROM_KEY = 'wb_unread_from_v1';
let unreadFrom = Date.now() - SLEEP_AFTER_MS;
try {
  const stored = Number(localStorage.getItem(UNREAD_FROM_KEY));
  if (Number.isFinite(stored) && stored > 0) unreadFrom = stored;
  else localStorage.setItem(UNREAD_FROM_KEY, String(unreadFrom));
} catch { /* ignore */ }

// Where this Mac's unread line was drawn, for the stamps it shares.
export function unreadSince(): number {
  return unreadFrom;
}

export function answeredAnotherTab(messages: Message[], answer: Message): boolean {
  const end = messages.indexOf(answer);
  if (end < 0) return false;
  let at = end - 1;
  while (at >= 0 && (messages[at].role !== 'user' || messages[at].note)) at -= 1;
  if (at < 0) return false;
  const prompt = messages[at];
  if (!prompt.hiddenInTranscript || !prompt.tabMessages) return false;
  return messages.slice(at + 1, end).some((message) => message.role === 'tab' && message.direction === 'out' && !!message.replyTo);
}

function stayedOn(threadId: string, tabId: string, landedAt: number): boolean {
  // The last tab put on screen before the landing is this one, and no
  // other tab's stamp ties with it.
  const here = `${threadId}:${tabId}`;
  let latestAt = Number.NEGATIVE_INFINITY;
  let latestHere = false;
  let tied = false;
  for (const [key, at] of Object.entries(touches)) {
    if (at > landedAt) continue;
    const [kind, thread, tab] = key.split(':');
    if ((kind !== 'v' && kind !== 's') || !tab) continue;
    const isHere = `${thread}:${tab}` === here;
    if (at > latestAt) { latestAt = at; latestHere = isHere; tied = false; }
    else if (at === latestAt && isHere !== latestHere) tied = true;
  }
  return latestHere && !tied;
}

function turnOwner(threadId: string): (id: string | undefined) => boolean {
  const my = meId();
  const shared = !!(state.cache[threadId]?.shared || state.threads.find((thread) => thread.id === threadId)?.shared);
  return (id) => (id ? !!my && id === my : !shared);
}

// The list row says when a tab landed for a workstream that is not loaded;
// a loaded one is read directly, and the later of the two stands (the list
// can be behind an open pane, a cached thread behind the list). On a shared
// workstream a turn a teammate's Mac ran is theirs to read, the way its
// confirmation is theirs to give, so it never dots this rail.
export function tabUnread(threadId: string, row: SummaryTab): boolean {
  if (row.done || row.type === 'duel') return false;
  const mine = turnOwner(threadId);
  const task = state.cache[threadId];
  const tab = task?.tabs?.find((candidate) => candidate.id === row.id);
  // The list row can be behind what this window just did: a tab marked
  // done here, or sent back to work here, is not waiting to be read.
  if (tab && (tab.done || tab.activeRun || state.streams[`${threadId}::${tab.id}`])) return false;
  let loadedAt: number | null = null;
  if (task && tab && !tab.done && tabVitality(task, tab) === 'awake') {
    const last = lastVisible(tab);
    if (last && mine(last.ranBy?.id) && !answeredAnotherTab(tab.messages || [], last)) loadedAt = Date.parse(last.ts || '');
  }
  const landedAt = latest(loadedAt, mine(row.landedBy) ? row.landedAt : null);
  if (!Number.isFinite(landedAt) || landedAt <= Math.max(tabSeenAt(threadId, row.id), unreadFrom)) return false;
  return !stayedOn(threadId, row.id, landedAt);
}

export function tabReturned(threadId: string, row: SummaryTab): boolean {
  if (row.done || row.type === 'duel') return false;
  const mine = turnOwner(threadId);
  const task = state.cache[threadId];
  const tab = task?.tabs?.find((candidate) => candidate.id === row.id);
  if (tab && (tab.done || tab.activeRun || state.streams[`${threadId}::${tab.id}`])) return false;
  let loadedAt: number | null = null;
  if (task && tab) {
    const last = lastVisible(tab);
    if (last && last.role === 'assistant' && mine(last.ranBy?.id) && !answeredAnotherTab(tab.messages || [], last)) loadedAt = Date.parse(last.ts || '');
  }
  const returnedAt = latest(loadedAt, mine(row.returnedBy) ? row.returnedAt : null);
  if (!Number.isFinite(returnedAt) || returnedAt <= Math.max(tabSeenAt(threadId, row.id), unreadFrom)) return false;
  return !stayedOn(threadId, row.id, returnedAt);
}

export function tabReturnedAt(threadId: string, row: SummaryTab): number {
  if (row.done || row.type === 'duel') return NaN;
  const mine = turnOwner(threadId);
  const task = state.cache[threadId];
  const tab = task?.tabs?.find((candidate) => candidate.id === row.id);
  const stream = tab ? state.streams[`${threadId}::${tab.id}`] : null;
  if (tab && (tab.done || (stream ? !stream.landed : !!tab.activeRun))) return NaN;
  let loadedAt: number | null = null;
  if (task && tab) {
    const last = lastVisible(tab);
    if (last && last.role === 'assistant' && mine(last.ranBy?.id) && !answeredAnotherTab(tab.messages || [], last)) loadedAt = Date.parse(last.ts || '');
  }
  const returnedAt = latest(loadedAt, mine(row.returnedBy) ? row.returnedAt : null);
  return Number.isFinite(returnedAt) && returnedAt > 0 ? returnedAt : NaN;
}

export function tabCameBack(threadId: string, row: SummaryTab): boolean {
  return Number.isFinite(tabReturnedAt(threadId, row));
}

// lastActivity moves on runs and steers (the list falls back to updatedAt when
// a workstream has never run). Background saves also bump updatedAt, so it is
// not a touch on its own.
export function threadTouchedAt(summary: TaskSummary): number {
  const task = state.cache[summary.id];
  const tabs = task ? (task.tabs || []).map((tab) => tabTouchedAt(task, tab)) : [];
  return latest(touches[`t:${summary.id}`], summary.lastActivity || summary.createdAt, ...tabs);
}

// The turn ended with the ball in the user's court: a confirmation to give,
// or a draft left unsent. Such a turn never reads green (Paper 16.6).
export function turnWaiting(message: Message | null | undefined): boolean {
  return !!message && message.role === 'assistant' && (!!message.confirmation || leftADraft(message));
}

// The workstream rollup. With the full task cached this reads every tab;
// otherwise the list summary's status stands in.
export function threadVitality(summary: TaskSummary): Vitality {
  const task = state.cache[summary.id];
  const streaming = Object.values(state.streams).some((stream) => stream.threadId === summary.id && !stream.landed);
  if (streaming) return 'working';
  if (task) {
    const states = (task.tabs || []).map((tab) => tabVitality(task, tab));
    if (states.includes('working')) return 'working';
    if (states.includes('waiting')) return 'waiting';
    if (states.includes('awake')) return 'awake';
    if (states.includes('failed')) return 'failed';
    return 'quiet';
  }
  if (summary.status === 'running') return 'working';
  if (Number(summary.needsConfirmationCount || 0) > 0) return 'waiting';
  if (summary.status === 'done') return 'awake';
  if (summary.status === 'error') return 'failed';
  return 'quiet';
}

export function threadAsleep(summary: TaskSummary, now = Date.now()): boolean {
  if (threadVitality(summary) === 'working') return false;
  return isAsleep(threadTouchedAt(summary), now);
}

// Sleep rolls up: every workstream asleep means the project is asleep.
export function projectAsleep(threads: TaskSummary[], now = Date.now()): boolean {
  return threads.length > 0 && threads.every((thread) => threadAsleep(thread, now));
}
