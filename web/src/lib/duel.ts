import { state } from '../store';
import { EFFORT_NAMES } from '../constants';
import type { Tab, DuelPhase } from '../types';

// Pure duel helpers, shared by actions and components.

export function duelPhase(tab: Tab | null | undefined): DuelPhase | null {
  const d = tab && tab.duel;
  if (!d) return null;
  if (d.choice) return 'picked';
  if (d.phase) return d.phase;
  return d.a && d.b ? 'results' : 'setup';
}

export function duelEffortIndex(tab: Tab | null | undefined): number {
  if (!tab) return 2;
  if (state.duelEffort[tab.id] != null) return state.duelEffort[tab.id];
  const idx = EFFORT_NAMES.indexOf((tab.duel && tab.duel.effort) || 'High');
  return idx < 0 ? 2 : idx;
}
