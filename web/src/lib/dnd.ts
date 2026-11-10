import type { DragEvent } from 'react';
import { state } from '../store';
import { moveTab, moveThread, splitFromDrag, openProjectSplit, openThreadSplit, attachTerminalContext } from '../actions';

// Drag/drop: projects split into a new pane; tabs can be split (onto another tab)
// or moved between threads/projects. Ported from the vanilla dragstart/over/drop
// handlers, using React drag events + per-target highlight.

const appEl = () => document.getElementById('app');
const PROJECT_MIME = 'application/x-supreme-project';
const THREAD_MIME = 'application/x-supreme-thread';
const TAB_MIME = 'application/x-supreme-tab';

function transferHas(e: DragEvent, mime: string): boolean {
  return !!e.dataTransfer?.types.includes(mime);
}

function workspaceDrag(e: DragEvent) {
  if (state.drag) return state.drag;
  if (!e.dataTransfer) return null;
  const project = e.dataTransfer.getData(PROJECT_MIME);
  if (project) return { project };
  const thread = e.dataTransfer.getData(THREAD_MIME);
  if (thread) return { thread };
  const tab = e.dataTransfer.getData(TAB_MIME);
  return tab ? { tab } : null;
}

// Connected tabs, board 3: the map's canvas takes a tab from the rail or a
// strip. During dragover only the store knows what is in the air; the
// transfer's own data is readable at the drop.
export function draggedTabKey(e: DragEvent): string | null {
  if (state.drag?.tab) return state.drag.tab;
  if (!e.dataTransfer) return null;
  if (!transferHas(e, TAB_MIME)) return null;
  return e.dataTransfer.getData(TAB_MIME) || null;
}

export function projectDragStart(e: DragEvent, path: string): void {
  state.drag = { project: path };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(PROJECT_MIME, path);
    e.dataTransfer.setData('text/plain', path);
  }
  appEl()?.classList.add('dragging-project');
}

export function threadDragStart(e: DragEvent, threadId: string): void {
  state.drag = { thread: threadId };
  if (e.dataTransfer) {
    // copy = split beside a tab; move = onto another project's row.
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(THREAD_MIME, threadId);
    e.dataTransfer.setData('text/plain', threadId);
  }
  appEl()?.classList.add('dragging-thread');
}

export function tabDragStart(e: DragEvent, key: string): void {
  state.drag = { tab: key };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(TAB_MIME, key);
    e.dataTransfer.setData('text/plain', key);
  }
  appEl()?.classList.add('dragging');
}

const CONTEXT_MIME = 'application/x-supreme-terminal-context';

export function contextDragStart(e: DragEvent, sourceTaskId: string, sourceTabId: string): void {
  state.drag = { context: { sourceTaskId, sourceTabId } };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(CONTEXT_MIME, JSON.stringify({ sourceTaskId, sourceTabId }));
    e.dataTransfer.setData('text/plain', `supreme-context:${sourceTaskId}:${sourceTabId}`);
  }
  appEl()?.classList.add('dragging-context');
}

export function dragEnd(): void {
  state.drag = null;
  appEl()?.classList.remove('dragging');
  appEl()?.classList.remove('dragging-project');
  appEl()?.classList.remove('dragging-thread');
  appEl()?.classList.remove('dragging-context');
  document.querySelectorAll('.drop-hi').forEach((el) => el.classList.remove('drop-hi'));
  document.querySelectorAll('.context-drop-hi').forEach((el) => el.classList.remove('context-drop-hi'));
}

function highlight(e: DragEvent, effect: 'move' | 'copy'): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = effect;
  (e.currentTarget as HTMLElement).classList.add('drop-hi');
}

function unhighlight(e: DragEvent): void {
  (e.currentTarget as HTMLElement).classList.remove('drop-hi');
}

// The large split zone accepts any level of the workspace hierarchy.
export const projectZoneOver = (e: DragEvent) => {
  if (state.drag?.project || state.drag?.thread || transferHas(e, PROJECT_MIME) || transferHas(e, THREAD_MIME)) highlight(e, 'copy');
};
export const projectZoneLeave = unhighlight;
export function projectZoneDrop(e: DragEvent): void {
  const drag = workspaceDrag(e);
  if (!drag) { dragEnd(); return; }
  e.preventDefault();
  const paneIdx = state.activePane;
  dragEnd();
  if (drag.project) void openProjectSplit(drag.project, paneIdx);
  else if (drag.thread) void openThreadSplit(drag.thread, null, paneIdx);
  else if (drag.tab) {
    const [threadId, tabId] = drag.tab.split('::');
    void openThreadSplit(threadId, tabId, paneIdx);
  }
}

// A thread row: accepts a dragged tab → move into that thread.
export const tabTargetOver = (e: DragEvent) => { if (state.drag?.tab || transferHas(e, TAB_MIME)) highlight(e, 'move'); };
export const tabTargetLeave = unhighlight;

export function contextTargetOver(e: DragEvent): void {
  if (!state.drag?.context && !e.dataTransfer?.types.includes(CONTEXT_MIME)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  (e.currentTarget as HTMLElement).classList.add('context-drop-hi');
}

export function contextTargetLeave(e: DragEvent): void {
  const target = e.currentTarget as HTMLElement;
  const next = e.relatedTarget as Node | null;
  if (next && target.contains(next)) return;
  target.classList.remove('context-drop-hi');
}

export function contextTargetDrop(e: DragEvent, targetPaneIdx: number): void {
  if (!state.drag?.context && !transferHas(e, CONTEXT_MIME)) return;
  e.preventDefault();
  e.stopPropagation();
  const local = state.drag?.context;
  let payload = local || null;
  if (!payload && e.dataTransfer) {
    try { payload = JSON.parse(e.dataTransfer.getData(CONTEXT_MIME)); } catch { payload = null; }
  }
  dragEnd();
  if (payload?.sourceTaskId && payload?.sourceTabId) {
    attachTerminalContext(targetPaneIdx, payload.sourceTaskId, payload.sourceTabId);
  }
}

// A visible tab is a split target for projects, threads, and tabs.
export const splitTargetOver = (e: DragEvent) => {
  if (state.drag?.project || state.drag?.thread || state.drag?.tab
    || transferHas(e, PROJECT_MIME) || transferHas(e, THREAD_MIME) || transferHas(e, TAB_MIME)) highlight(e, 'copy');
};
export function threadRowDrop(e: DragEvent, threadId: string): void {
  const drag = workspaceDrag(e);
  if (!drag?.tab) return;
  e.preventDefault();
  const key = drag.tab;
  dragEnd();
  moveTab(key, { toThread: threadId });
}

// A project row: a dragged tab moves into a new thread there; a dragged
// workstream moves in whole (into a shared project, after it says who will
// see it).
export const projectTargetOver = (e: DragEvent) => {
  if (state.drag?.tab || state.drag?.thread || transferHas(e, TAB_MIME) || transferHas(e, THREAD_MIME)) highlight(e, 'move');
};
export function projectRowDrop(e: DragEvent, repo: string): void {
  const drag = workspaceDrag(e);
  if (!drag?.tab && !drag?.thread) return;
  e.preventDefault();
  dragEnd();
  if (drag.tab) moveTab(drag.tab, { toRepo: repo });
  else if (drag.thread) void moveThread(drag.thread, repo);
}

// A tab: accepts a dragged tab → split view (both side by side).
export function tabDrop(e: DragEvent, paneIdx: number, threadId: string, tabId: string): void {
  const drag = workspaceDrag(e);
  if (!drag) return;
  e.preventDefault();
  dragEnd();
  if (drag.tab) {
    splitFromDrag(drag.tab, paneIdx, threadId, tabId);
    return;
  }
  const pane = state.panes[paneIdx];
  if (pane) {
    pane.tabId = tabId;
    const task = state.cache[pane.threadId];
    if (task) task.activeTab = tabId;
  }
  if (drag.thread) void openThreadSplit(drag.thread, null, paneIdx);
  else if (drag.project) void openProjectSplit(drag.project, paneIdx);
}
