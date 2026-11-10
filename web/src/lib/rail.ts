// Section 28, the rail's second pass (Paper page 1, boards 28.1 to 28.6).
// An orchestrator is a card in its own zone above the tree, and the tree
// carries one steady mark: a tab answered and you have not read it. Both
// are read from the list rows, so a workstream that is shut, or was never
// opened on this Mac, still counts.
import { state, set } from '../store';
import { api } from '../api';
import { loadTask, mapCardKey } from '../actions';
import { laneStates } from './orchestrator';
import { tabCameBack, tabReturned, tabUnread } from './vitality';
import type { SummaryLane, SummaryTab, TaskSummary } from '../types';

export interface OrchCard { threadId: string; tabId: string; name: string; out: number; back: number }

// A lane this old is no longer watched in the background; the next list
// refresh (any open, send or rename) still brings its answer in.
const WATCH_LANE_MS = 6 * 60 * 60_000;
const WATCH_SETTLE_MS = 2 * 60_000;

const live = (thread: TaskSummary) => !thread.archived;

// The tabs a workstream shows under its row: live ones, less an
// orchestrator, which sits on its card (board 28.6: the card takes the tab
// and nothing else).
export function treeTabs(thread: TaskSummary): SummaryTab[] {
  return (thread.tabs || []).filter((tab) => !tab.done && tab.type !== 'orchestrator');
}

// A workstream whose only tab was the orchestrator has nothing left to list.
export function inTree(thread: TaskSummary): boolean {
  const tabs = (thread.tabs || []).filter((tab) => !tab.done);
  return !tabs.length || tabs.some((tab) => tab.type !== 'orchestrator');
}

function onScreen(threadId: string, tabId: string): boolean {
  return state.view === 'tab' && state.panes.some((pane) => pane.threadId === threadId && (pane.tabId || state.cache[threadId]?.activeTab) === tabId);
}

export function rowUnread(threadId: string, tab: SummaryTab): boolean {
  return !onScreen(threadId, tab.id) && tabUnread(threadId, tab);
}

// Landed's row test: the dot's, widened to any turn that came back.
export function rowReturned(threadId: string, tab: SummaryTab): boolean {
  return !onScreen(threadId, tab.id) && tabReturned(threadId, tab);
}

// Landed's fallback row: a tab whose last turn came back to you, read or not.
export function rowCameBack(threadId: string, tab: SummaryTab): boolean {
  return !onScreen(threadId, tab.id) && tabCameBack(threadId, tab);
}

export function threadUnread(thread: TaskSummary): number {
  return treeTabs(thread).filter((tab) => rowUnread(thread.id, tab)).length;
}

// An open pane is read back every second or so and the list is not, so the
// orchestrator on screen counts from its own thread; anywhere else the list
// row stands.
function lanesOf(thread: TaskSummary, tab: SummaryTab): SummaryLane[] {
  const cached = state.panes.some((pane) => pane.threadId === thread.id)
    ? state.cache[thread.id]?.tabs?.find((candidate) => candidate.id === tab.id)
    : null;
  if (!cached) return tab.lanes || [];
  return Object.entries(laneStates(cached)).filter(([, lane]) => lane.askedAt).map(([key, lane]) => ({ key, askedAt: lane.askedAt, answeredAt: lane.answeredAt }));
}

function rosterRow(key: string): { thread: TaskSummary; tab: SummaryTab } | null {
  for (const thread of state.threads) {
    if (!live(thread)) continue;
    const tab = (thread.tabs || []).find((candidate) => !candidate.done && mapCardKey(thread.id, candidate.id) === key);
    if (tab) return { thread, tab };
  }
  return null;
}

// One card per orchestrator. "Out" is what it asked and has not heard from;
// "back" is an answer you have not read, which only a new answer or a read
// can move (board 28.3).
export function orchestratorCards(): OrchCard[] {
  const cards: OrchCard[] = [];
  for (const thread of state.threads) {
    if (!live(thread)) continue;
    for (const tab of thread.tabs || []) {
      if (tab.type !== 'orchestrator' || tab.done) continue;
      let out = 0;
      let back = 0;
      for (const lane of lanesOf(thread, tab)) {
        const roster = rosterRow(lane.key);
        if (!roster) continue;
        if (!lane.answeredAt) out += 1;
        else if (rowUnread(roster.thread.id, roster.tab)) back += 1;
      }
      // Alone in its workstream the card is that workstream, which is the
      // name the rail showed until now; a new tab's stock name says nothing.
      const alone = !(thread.tabs || []).some((other) => other.id !== tab.id && !other.done);
      const name = state.cache[thread.id]?.tabs?.find((candidate) => candidate.id === tab.id)?.name ?? tab.name;
      const stock = !name || name === 'Main' || name === 'Untitled';
      cards.push({ threadId: thread.id, tabId: tab.id, name: alone || stock ? thread.title : name, out, back });
    }
  }
  return cards;
}

// What the rail keeps an eye on between list refreshes: each orchestrator
// with something still out, the workstreams it is waiting on, and the
// workstream of a scheduled task that is running or has just run.
export function watchedThreadIds(now = Date.now()): string[] {
  const ids = new Set<string>();
  for (const thread of state.threads) {
    if (!live(thread)) continue;
    for (const tab of thread.tabs || []) {
      if (tab.type !== 'orchestrator' || tab.done) continue;
      for (const lane of lanesOf(thread, tab)) {
        if (now - (Date.parse(lane.askedAt || '') || 0) > WATCH_LANE_MS) continue;
        const roster = rosterRow(lane.key);
        if (!roster) continue;
        // A tab sends its answer mid turn and lands a moment later, so an
        // answered lane is watched until that turn is in.
        const landing = roster.tab.status === 'running' || now - (Date.parse(lane.answeredAt || '') || 0) < WATCH_SETTLE_MS;
        if (lane.answeredAt && !landing) continue;
        ids.add(thread.id);
        ids.add(roster.thread.id);
      }
    }
  }
  // Section 29: a scheduled task's turn starts with nobody looking, often in
  // a workstream that is shut, so its row is read back while the turn is out
  // and until its landing is in. That is what puts the dot on it.
  for (const schedule of state.schedules) {
    const ranAt = Date.parse(schedule.history[0]?.ranAt || '') || 0;
    if (schedule.running || now - ranAt < WATCH_SETTLE_MS) ids.add(schedule.threadId);
  }
  return [...ids];
}

// The whole list reads every workstream on disk, so between refreshes the
// rail asks only for the rows it is waiting on, and only while the window
// is being looked at.
let watching = false;
// Workstreams seen with a turn out on the last look: read back once more
// after the turn ends, so the landing is in too.
let runningBefore = new Set<string>();
export async function refreshRailWatch(): Promise<void> {
  if (watching || document.hidden) return;
  watching = true;
  try {
    // A turn nobody started from this window (a Slack mention, a tab
    // message) never reached the rail until its workstream was opened.
    const running: string[] = (await api('/api/tasks?running=1').catch(() => ({ ids: [] }))).ids || [];
    const ids = [...new Set([...watchedThreadIds(), ...running, ...runningBefore])];
    runningBefore = new Set(running);
    if (!ids.length) return;
    const rows: TaskSummary[] = (await api('/api/tasks?ids=' + ids.map(encodeURIComponent).join(','))).tasks || [];
    let changed = false;
    for (const row of rows) {
      const at = state.threads.findIndex((thread) => thread.id === row.id);
      if (at < 0 || JSON.stringify(state.threads[at]) === JSON.stringify(row)) continue;
      const was = state.threads[at];
      state.threads[at] = row;
      changed = true;
      // A workstream read earlier is judged by its saved copy, not the row,
      // so a turn that started or ended since is read into that copy too.
      if (state.cache[row.id] && (was.status !== row.status || was.lastActivity !== row.lastActivity)) void loadTask(row.id).then(() => set()).catch(() => {});
    }
    if (changed) { state.threads = [...state.threads]; set(); }
  } catch { /* next tick */ } finally { watching = false; }
}
