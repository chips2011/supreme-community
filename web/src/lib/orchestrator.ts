// Section 27, the orchestrator (Paper page 1, boards 27.1 to 27.8). The
// roster is the orchestrator's own workstream map less its own card; a lane
// is what the orchestrator's tab messages say about each roster tab; traffic
// is one stream of two kinds of event, messages and what the orchestrator
// wrote to its map. Nothing here is stored: it is all read from the task,
// so the panel, the map and the transcript cannot disagree (lib/tabmap.mjs
// laneStates is the same reading, server side).
import type { MapCard, Message, Task, TaskSummary, Tab, TrafficEvent } from '../types';
import { mapCardKey } from '../actions';

export const LANE_QUIET_MS = 10 * 60_000;
export const LANE_CROSS_MS = 2_400;

export interface Lane { askedAt: string | null; answeredAt: string | null; quietAt: string | null; last: string | null }

export function laneStates(tab: Tab | null | undefined, now = Date.now(), quietAfterMs = LANE_QUIET_MS): Record<string, Lane> {
  const lanes: Record<string, Lane> = {};
  for (const message of tab?.messages || []) {
    if (!message || message.role !== 'tab') continue;
    const address = message.direction === 'out' ? message.to : message.from;
    if (!address?.threadId || !address?.tabId) continue;
    const key = mapCardKey(address.threadId, address.tabId);
    const lane = lanes[key] || (lanes[key] = { askedAt: null, answeredAt: null, quietAt: null, last: null });
    const at = Date.parse(message.ts || '') || 0;
    if (message.direction === 'out') { lane.askedAt = message.ts || null; lane.answeredAt = null; }
    else if (lane.askedAt && !lane.answeredAt && at >= (Date.parse(lane.askedAt) || 0)) lane.answeredAt = message.ts || null;
    lane.last = message.ts || lane.last;
  }
  for (const lane of Object.values(lanes)) {
    const asked = Date.parse(lane.askedAt || '') || 0;
    lane.quietAt = lane.askedAt && !lane.answeredAt && now - asked > quietAfterMs ? new Date(asked + quietAfterMs).toISOString() : null;
  }
  return lanes;
}

export type LaneState = 'idle' | 'out' | 'waiting' | 'back' | 'done' | 'quiet';

// The state a lane is in right now. Blue (out, back) only while a message
// is on the wire: one pass out from the moment it is sent, one pass back
// from the moment the answer lands, nothing in between (board 27.5).
export function laneState(lane: Lane | undefined, now = Date.now()): LaneState {
  if (!lane || !lane.askedAt) return 'idle';
  if (lane.answeredAt) return now - (Date.parse(lane.answeredAt) || 0) < LANE_CROSS_MS ? 'back' : 'done';
  if (lane.quietAt) return 'quiet';
  return now - (Date.parse(lane.askedAt) || 0) < LANE_CROSS_MS ? 'out' : 'waiting';
}

export function clockTime(value: string | undefined): string {
  const at = Date.parse(value || '');
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`;
}

export function minutesOut(since: string | null | undefined, now = Date.now()): number {
  return Math.max(0, Math.round((now - (Date.parse(since || '') || now)) / 60_000));
}

export function outWords(since: string | null | undefined, now = Date.now()): string {
  const minutes = minutesOut(since, now);
  if (minutes < 60) return `out ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `out ${hours}h`;
}

export function orchestratorOf(task: Task | TaskSummary | null | undefined): { id: string; name: string } | null {
  const tab = (task?.tabs || []).find((candidate) => candidate.type === 'orchestrator');
  return tab ? { id: tab.id, name: tab.name || 'Untitled' } : null;
}

// The roster as the panel and the map draw it: every card on the map but
// the hub's own, in the map's own order.
export function rosterOf(task: Task, hubTabId: string): MapCard[] {
  const own = mapCardKey(task.id, hubTabId);
  return Object.values(task.map?.cards || {}).filter((card) => card.key !== own);
}

const gist = (value: string | undefined, max = 72) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\s,;:]+$/, '')}…` : text;
};

export interface TrafficRow {
  id: string;
  at: string;
  kind: 'asked' | 'back' | 'answering' | 'quiet' | 'wrote' | 'folded';
  text: string;
  event?: TrafficEvent;
  tabIds?: string[];
}

// One stream, newest first: the orchestrator's sends grouped per turn, each
// answer as it landed, a roster tab that is answering right now, lanes that
// went quiet, what the orchestrator wrote to its map (with the undo), and
// the folds. `runningTabs` says which roster tabs are mid turn.
export function trafficRows(task: Task, hub: Tab, { now = Date.now(), runningTabs = new Set<string>() }: { now?: number; runningTabs?: Set<string> } = {}): TrafficRow[] {
  const rows: TrafficRow[] = [];
  const messages = hub.messages || [];
  const nameOf = (message: Message) => (message.direction === 'out' ? message.to?.name : message.from?.name) || 'a tab';
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'tab') continue;
    if (message.direction === 'out') {
      // Sends that left in the same turn read as one row.
      const group = [message];
      while (index + 1 < messages.length && messages[index + 1].role === 'tab' && messages[index + 1].direction === 'out' && Math.abs((Date.parse(messages[index + 1].ts || '') || 0) - (Date.parse(message.ts || '') || 0)) < 5 * 60_000) { index += 1; group.push(messages[index]); }
      const names = group.map(nameOf);
      rows.push({ id: `asked-${message.id || index}`, at: message.ts || '', kind: 'asked', text: group.length === 1 ? `Asked ${names[0]}, ${gist(message.content)}` : `Asked ${group.length} tabs, ${gist(message.content)}`, tabIds: group.map((row) => row.to?.tabId || '').filter(Boolean) });
      continue;
    }
    rows.push({ id: `back-${message.id || index}`, at: message.ts || '', kind: 'back', text: `${nameOf(message)} back, ${gist(message.content)}`, tabIds: message.from?.tabId ? [message.from.tabId] : [] });
  }
  const lanes = laneStates(hub, now);
  for (const card of rosterOf(task, hub.id)) {
    const lane = lanes[card.key];
    if (!lane?.askedAt || lane.answeredAt) continue;
    if (lane.quietAt) rows.push({ id: `quiet-${card.key}`, at: lane.quietAt, kind: 'quiet', text: `${card.name} has not answered, ${minutesOut(lane.askedAt, now)} minutes out`, tabIds: [card.tabId] });
    else if (runningTabs.has(card.tabId)) rows.push({ id: `answering-${card.key}`, at: new Date(now).toISOString(), kind: 'answering', text: `${card.name} is answering`, tabIds: [card.tabId] });
  }
  for (const event of task.traffic || []) rows.push({ id: `wrote-${event.id}`, at: event.at, kind: 'wrote', text: event.text, event, tabIds: [event.tab.tabId] });
  for (const fold of hub.folds || []) rows.push({ id: `fold-${fold.id}`, at: fold.at, kind: 'folded', text: `Folded ${fold.foldedNow || fold.count} earlier ${(fold.foldedNow || fold.count) === 1 ? 'message' : 'messages'}` });
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

// Events since the start of today, the count on the tucked-away rail.
export function sinceMidnight(rows: TrafficRow[], now = Date.now()): TrafficRow[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return rows.filter((row) => (Date.parse(row.at) || 0) >= start.getTime());
}

// Where the roster sits around the hub: on an ellipse, first at the top,
// then clockwise (board 27.2: rx 143, ry 200 in a 459 by 560 box).
export function ringPositions(count: number, { cx, cy, rx, ry }: { cx: number; cy: number; rx: number; ry: number }): { x: number; y: number }[] {
  return Array.from({ length: count }, (_row, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, count);
    return { x: Math.round(cx + rx * Math.cos(angle)), y: Math.round(cy + ry * Math.sin(angle)) };
  });
}

export type RingSpec = {
  start: { rx: number; ry: number };
  node: { w: number; h: number };
  hub: { w: number; h: number };
  label?: { w: number; h: number };
  gap: number;
  hubInset: { x: number; y: number };
  nodeInset: { x: number; y: number };
};
export const MAP_RING: RingSpec = { start: { rx: 330, ry: 250 }, node: { w: 210, h: 59 }, hub: { w: 230, h: 103 }, label: { w: 170, h: 30 }, gap: 36, hubInset: { x: 124, y: 60 }, nodeInset: { x: 112, y: 36 } };
export const PANEL_RING: RingSpec = { start: { rx: 128, ry: 200 }, node: { w: 180, h: 34 }, hub: { w: 150, h: 52 }, gap: 16, hubInset: { x: 34, y: 30 }, nodeInset: { x: 30, y: 22 } };
export const LABEL_AT = 0.65;

type Box = { x: number; y: number; w: number; h: number };
const apart = (a: Box, b: Box, gap: number) => Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + gap || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + gap;

// Where a lane's label sits: LABEL_AT of the way along the drawn lane, from
// the hub's edge toward the node's edge.
export function labelPoint(from: { x: number; y: number }, to: { x: number; y: number }, hubInset: { x: number; y: number }, nodeInset: { x: number; y: number }, at = LABEL_AT): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const a = { x: from.x + ux * hubInset.x, y: from.y + uy * hubInset.y };
  const b = { x: to.x - ux * nodeInset.x, y: to.y - uy * nodeInset.y };
  return { x: Math.round(a.x + (b.x - a.x) * at), y: Math.round(a.y + (b.y - a.y) * at) };
}

export function ringSize(count: number, spec: RingSpec = MAP_RING): { rx: number; ry: number } {
  let { rx, ry } = spec.start;
  if (count < 2) return { rx, ry };
  const clear = () => {
    const centre = { x: 0, y: 0 };
    const points = ringPositions(count, { cx: 0, cy: 0, rx, ry });
    const boxes: Box[] = [{ ...centre, ...spec.hub }];
    for (const point of points) {
      boxes.push({ ...point, ...spec.node });
      if (spec.label) boxes.push({ ...labelPoint(centre, point, spec.hubInset, spec.nodeInset), ...spec.label });
    }
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (!apart(boxes[i], boxes[j], spec.gap / 2)) return false;
    return true;
  };
  for (let step = 0; step < 80 && !clear(); step += 1) { rx = Math.round(rx * 1.05); ry = Math.round(ry * 1.05); }
  return { rx, ry };
}

// The lane's path, from just outside the hub to just short of the node.
export function lanePath(from: { x: number; y: number }, to: { x: number; y: number }, hubInset: { x: number; y: number }, nodeInset: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const a = { x: from.x + ux * hubInset.x, y: from.y + uy * hubInset.y };
  const b = { x: to.x - ux * nodeInset.x, y: to.y - uy * nodeInset.y };
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
