import { state } from '../store';
import { api } from '../api';
import { persistThreadLayouts } from './prefs';
import type { LayoutRecord } from '../types';

// Split-pane layout persistence. Each root thread remembers the panes it was
// last opened with; layouts are mirrored to the server (PATCH /api/settings
// threadLayout) with last-writer-wins by updatedAt, so they follow the user
// across browsers. Ported 1:1 from the vanilla app.

export function syncThreadLayout(root: string | null, layout: LayoutRecord | null, updatedAt?: number): void {
  if (!root) return;
  const payload = layout
    ? { ...layout, updatedAt: Number(layout.updatedAt || updatedAt || Date.now()) }
    : null;
  api('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ threadLayout: { root, layout: payload, updatedAt: Number(updatedAt || Date.now()) } }),
  }).catch(() => {});
}

export function mergeThreadLayouts(remoteLayouts: unknown): void {
  const local = state.threadLayouts || {};
  const remote = remoteLayouts && typeof remoteLayouts === 'object' && !Array.isArray(remoteLayouts)
    ? (remoteLayouts as Record<string, LayoutRecord>) : {};
  const merged: Record<string, LayoutRecord> = {};
  for (const root of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const localLayout = local[root];
    const remoteLayout = remote[root];
    const localAt = Number((localLayout || {}).updatedAt || 0);
    const remoteAt = Number((remoteLayout || {}).updatedAt || 0);
    const winner = remoteAt >= localAt ? remoteLayout : localLayout;
    if (winner && !winner.deleted && Array.isArray(winner.panes) && winner.panes.length) merged[root] = winner;
    if (localLayout && localAt > remoteAt) syncThreadLayout(root, localLayout, localAt);
  }
  state.threadLayouts = merged;
  persistThreadLayouts();
}

export function saveCurrentLayout(): void {
  const { layoutRoot, panes } = state;
  if (!layoutRoot || !panes.length || !panes.some((pane) => pane.threadId === layoutRoot)) return;
  const nextPanes = panes.map((pane) => {
    const width = Number(pane.width);
    return {
      threadId: pane.threadId,
      tabId: pane.tabId || null,
      ...(Number.isFinite(width) && width > 0 ? { width: Math.round(width * 10000) / 10000 } : {}),
    };
  });
  const previous = state.threadLayouts[layoutRoot];
  if (previous && JSON.stringify(previous.panes) === JSON.stringify(nextPanes)) return;
  state.threadLayouts[layoutRoot] = { panes: nextPanes, updatedAt: Date.now() };
  persistThreadLayouts();
  syncThreadLayout(layoutRoot, state.threadLayouts[layoutRoot]);
}

export function forgetThreadInLayouts(threadId: string): void {
  let changed = false;
  const remoteChanges: { root: string; layout: LayoutRecord | null; updatedAt: number }[] = [];
  for (const [root, layout] of Object.entries(state.threadLayouts)) {
    if (root === threadId) {
      const updatedAt = Date.now();
      delete state.threadLayouts[root];
      remoteChanges.push({ root, layout: null, updatedAt });
      changed = true;
      continue;
    }
    const panes = Array.isArray(layout && layout.panes) ? layout.panes.filter((pane) => pane.threadId !== threadId) : [];
    if (!panes.length || !panes.some((pane) => pane.threadId === root)) {
      const updatedAt = Date.now();
      delete state.threadLayouts[root];
      remoteChanges.push({ root, layout: null, updatedAt });
      changed = true;
    } else if (panes.length !== (layout.panes || []).length) {
      state.threadLayouts[root] = { ...layout, panes, updatedAt: Date.now() };
      remoteChanges.push({ root, layout: state.threadLayouts[root], updatedAt: state.threadLayouts[root].updatedAt });
      changed = true;
    }
  }
  if (changed) {
    persistThreadLayouts();
    remoteChanges.forEach((change) => syncThreadLayout(change.root, change.layout, change.updatedAt));
  }
}

export function rebaseLayoutRoot(): void {
  if (!state.panes.length) { state.layoutRoot = null; return; }
  if (!state.layoutRoot || !state.panes.some((pane) => pane.threadId === state.layoutRoot)) {
    state.layoutRoot = state.panes[0].threadId;
  }
}
