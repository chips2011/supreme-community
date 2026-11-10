import { state, type QueuedPrompt } from '../store';
import type { LayoutRecord } from '../types';

// localStorage prefs — user's last effort/model/project and per-thread split
// layouts. Server settings are the source of truth on boot; localStorage is the
// per-browser fallback. Ported from the vanilla app.

export function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem('wb_prefs') || '{}');
    if (p.effort) state.effort = p.effort;
    if (p.homeModel) state.homeModel = p.homeModel;
    if (p.homeProject) state.homeProject = p.homeProject;
    // Motion is Supreme's product language, not a user preference. Ignore the
    // retired setting so an older saved "off" choice cannot survive an update.
    state.motion = { road: true, ground: true, edges: true };
  } catch { /* ignore */ }
  try {
    const layouts = JSON.parse(localStorage.getItem('wb_thread_layouts_v1') || '{}');
    if (layouts && typeof layouts === 'object' && !Array.isArray(layouts)) {
      state.threadLayouts = layouts as Record<string, LayoutRecord>;
    }
  } catch { /* ignore */ }
}

export function savePrefs(): void {
  try {
    localStorage.setItem('wb_prefs', JSON.stringify({
      effort: state.effort, homeModel: state.homeModel, homeProject: state.homeProject,
    }));
  } catch { /* ignore */ }
}

export function persistThreadLayouts(): void {
  try { localStorage.setItem('wb_thread_layouts_v1', JSON.stringify(state.threadLayouts)); } catch { /* ignore */ }
}

function blockedStorageKey(): string | null {
  if (state.authConfigured) return state.user?.id ? `wb_blocked_prompts_v1:${state.user.id}` : null;
  const account = state.user?.id || state.onboarding.email;
  return account ? `wb_blocked_prompts_v1:${account}` : 'wb_blocked_prompts_v1:local';
}

let loadedBlockedAccount: string | null = null;
export function clearBlockedPrompts(): void {
  for (const [key, items] of Object.entries(state.queuedPrompts)) {
    const remaining = items.filter((item) => !item.error);
    if (remaining.length) state.queuedPrompts[key] = remaining;
    else delete state.queuedPrompts[key];
  }
  loadedBlockedAccount = null;
}

// Failed starts survive an app reload, but never become automatic sends.
// Account namespacing keeps another person's messages out of this session.
export function loadBlockedPrompts(): void {
  const storageKey = blockedStorageKey();
  if (!storageKey) return;
  if (loadedBlockedAccount !== storageKey) clearBlockedPrompts();
  loadedBlockedAccount = storageKey;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const [key, value] of Object.entries(saved)) {
      if (!Array.isArray(value)) continue;
      const blocked = value.filter((item): item is QueuedPrompt => item && typeof item.id === 'string'
        && typeof item.prompt === 'string' && typeof item.error === 'string' && !!item.error);
      const existing = state.queuedPrompts[key] || [];
      state.queuedPrompts[key] = [...blocked.filter((item) => !existing.some((other) => other.id === item.id)), ...existing];
    }
  } catch { /* keep the in-memory messages if storage is unavailable */ }
}

export function saveBlockedPrompts(): void {
  const storageKey = blockedStorageKey();
  if (!storageKey) return;
  try {
    const blocked = Object.fromEntries(Object.entries(state.queuedPrompts)
      .map(([key, items]) => [key, items.filter((item) => !!item.error)] as const)
      .filter(([, items]) => items.length));
    localStorage.setItem(storageKey, JSON.stringify(blocked));
  } catch { /* the visible message remains available for retry */ }
}
