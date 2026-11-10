import { useEffect, useState } from 'react';
import { LANE_CROSS_MS, LANE_QUIET_MS, laneStates, type Lane, type LaneState } from './orchestrator';
import type { Tab } from '../types';

// Section 27, board 27.5: a lane goes blue only while a message is on the
// wire, and "on the wire" is when this window first sees a new ask or a new
// answer on that lane: one pass of 2.4s, then the lane is what its record
// says (waiting, answered, gone quiet). Two guards keep blue meaning "a
// message is crossing" and never "this window just woke up" (design
// session, 2026-09-12): the first look at a tab paints its lanes straight
// into their resting state, and a message older than a minute lands
// silently. The seen record lives here, not in a component, so the panel,
// the map and the transcript read the same passes whichever renders first,
// and reopening the tab does not replay them.
const HYDRATE_CAP_MS = 60_000;
const seenByTab = new Map<string, Map<string, { askedAt: string | null; answeredAt: string | null }>>();
const passesByTab = new Map<string, Map<string, { kind: 'out' | 'back'; until: number }>>();

export function notePasses(tab: Tab, now = Date.now()): { lanes: Record<string, Lane>; passes: Map<string, { kind: 'out' | 'back'; until: number }> } {
  const lanes = laneStates(tab, now);
  let passes = passesByTab.get(tab.id);
  if (!passes) { passes = new Map(); passesByTab.set(tab.id, passes); }
  let seen = seenByTab.get(tab.id);
  if (!seen) {
    seenByTab.set(tab.id, new Map(Object.entries(lanes).map(([key, lane]) => [key, { askedAt: lane.askedAt, answeredAt: lane.answeredAt }])));
    return { lanes, passes };
  }
  const fresh = (stamp: string | null) => now - (Date.parse(stamp || '') || 0) < HYDRATE_CAP_MS;
  for (const [key, lane] of Object.entries(lanes)) {
    const prior = seen.get(key);
    if (lane.askedAt && lane.askedAt !== (prior?.askedAt || null)) { if (fresh(lane.askedAt)) passes.set(key, { kind: 'out', until: now + LANE_CROSS_MS }); }
    else if (lane.answeredAt && lane.answeredAt !== (prior?.answeredAt || null)) { if (fresh(lane.answeredAt)) passes.set(key, { kind: 'back', until: now + LANE_CROSS_MS }); }
    seen.set(key, { askedAt: lane.askedAt, answeredAt: lane.answeredAt });
  }
  return { lanes, passes };
}

export function laneStateNow(lane: Lane | undefined, pass: { kind: 'out' | 'back'; until: number } | undefined, now: number): LaneState {
  if (pass && pass.until > now) return pass.kind;
  if (!lane) return 'idle';
  return lane.answeredAt ? 'done' : lane.quietAt ? 'quiet' : lane.askedAt ? 'waiting' : 'idle';
}

// Re-render when a pass ends, when a lane goes quiet, and every half minute
// for the counts; a new copy of the tab moves the clock at once.
function useClock(tab: Tab, passes: Map<string, { until: number }>): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [tab]);
  useEffect(() => {
    const at = Date.now();
    let next = at + 30_000;
    for (const pass of passes.values()) if (pass.until > at) next = Math.min(next, pass.until + 20);
    for (const lane of Object.values(laneStates(tab, at))) {
      const asked = Date.parse(lane.askedAt || '') || 0;
      if (asked && !lane.answeredAt && asked + LANE_QUIET_MS > at) next = Math.min(next, asked + LANE_QUIET_MS + 20);
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(50, next - at));
    return () => window.clearTimeout(timer);
  }, [tab, now, passes]);
  return now;
}

export function useLanes(tab: Tab): { now: number; lanes: Record<string, Lane>; states: Record<string, LaneState> } {
  const { lanes, passes } = notePasses(tab);
  const now = useClock(tab, passes);
  const states: Record<string, LaneState> = {};
  for (const [key, lane] of Object.entries(lanes)) states[key] = laneStateNow(lane, passes.get(key), now);
  return { now, lanes, states };
}

// Board 27.4: the reply lands in the thread as the returning pass reaches
// the hub, so the panel and the transcript agree. The ids of inbound tab
// messages still on the wire, to hold back from the transcript.
export function useHeldReplies(tab: Tab): Set<string> {
  const { lanes, passes } = notePasses(tab);
  const now = useClock(tab, passes);
  const held = new Set<string>();
  for (const [key, lane] of Object.entries(lanes)) {
    const pass = passes.get(key);
    if (!pass || pass.kind !== 'back' || pass.until <= now || !lane.answeredAt) continue;
    for (const message of tab.messages || []) {
      if (message.role === 'tab' && message.direction === 'in' && message.from?.threadId && message.from?.tabId && `${message.from.threadId}:${message.from.tabId}` === key && (Date.parse(message.ts || '') || 0) >= (Date.parse(lane.answeredAt) || 0) && message.id) held.add(message.id);
    }
  }
  return held;
}
