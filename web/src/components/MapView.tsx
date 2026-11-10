import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp, state, set, projectLabel } from '../store';
import { TopBar } from './bits';
import { RenameInput } from './RenameInput';
import { OrchMark } from './OrchMark';
import { OrchMap } from './OrchMap';
import { laneState, laneStates } from '../lib/orchestrator';
import { Icon } from '../icons';
import {
  openThread, openThreadAt, openTabFromMap, saveMapCard, addMapCard, removeMapCard, connectMapTabs, rewordMapEdge, removeMapEdge, loadPlays, refreshConnectors, mapCardKey, newMapTab, setMapOn,
} from '../actions';
import { destinationsElsewhere, mentionAtCursor } from '../lib/mention';
import { draggedTabKey, dragEnd } from '../lib/dnd';
import type { MapCard, MapEdge, MapRef, TabMap, Task } from '../types';

// Connected tabs (Paper page 8-2, boards 1 to 7). The workstream's map: its
// tabs as cards on a canvas, joined by hand-overs said in the person's own
// words. The tab is the building block, so a card opens the tab, and the
// card is standing guidance for the tab's turns (lib/tabmap.mjs).

const CARD_W = 340;
const CARD_H = 292;
const CARD_MIN_H = 86;
const COLUMN = 404;
const ROW = 368;
const BUBBLE_W = 500;
const MENU_W = 266;

interface Placed { card: MapCard; x: number; y: number; w: number; h: number }

// Board 1's arrangement, continued: one card mid-height, then a column of
// two, then one mid again, so a chain reads left to right.
function defaultPosition(index: number): { x: number; y: number } {
  const slot = index % 3;
  const column = Math.floor(index / 3) * 2 + (slot === 0 ? 0 : 1);
  return { x: column * COLUMN, y: slot === 0 ? 184 : slot === 1 ? 0 : ROW };
}

// Board 1: "Starts" is When I ask, then every hand-over that lands here.
function startsOf(map: TabMap, key: string): string[] {
  const triggers = map.edges.filter((edge) => mapCardKey(edge.to.threadId, edge.to.tabId) === key).map((edge) => edge.rule.trigger || edge.rule.when).filter(Boolean);
  return ['When I ask', ...triggers];
}

function countLine(card: MapCard): string {
  const parts = [];
  if (card.tools.length) parts.push(`${card.tools.length} ${card.tools.length === 1 ? 'tool' : 'tools'}`);
  if (card.skill) parts.push('1 skill');
  return parts.join(' · ') || 'nothing yet';
}

interface Route { d: string; arrow: string; label: { x: number; y: number; align: 'center' | 'left'; w: number }; bubble: { x: number; y: number } }

// How an edge is drawn between two cards: side to side when the target sits
// beside, top to bottom when it sits below or above, and down, across and
// back up when both share a row (boards 4 and 5). The label sits in the
// gap; the composer or panel opens off the same point.
function routeEdge(a: Placed, b: Placed, others: Placed[] = []): Route {
  const gap = 24;
  const ay = a.y + a.h / 2;
  const by = b.y + b.h / 2;
  // A column of cards standing between the two ends blocks the straight
  // route (boards 4 and 5: the edge would cut through their labels and
  // edges); the edge goes down, across under everything in the way, and up.
  const blocked = (left: number, right: number) => others.filter((row) => row !== a && row !== b && row.x < right - 8 && row.x + row.w > left + 8);
  const around = (blockers: Placed[]) => {
    const ax = a.x + a.w / 2; const bx = b.x + b.w / 2;
    const y1 = a.y + a.h; const y2 = b.y + b.h;
    const yy = Math.max(y1, y2, ...blockers.map((row) => row.y + row.h)) + 40; const r = 20; const dir = bx < ax ? -1 : 1;
    const d = `M${ax} ${y1} L${ax} ${yy - r} Q${ax} ${yy} ${ax + dir * r} ${yy} L${bx - dir * r} ${yy} Q${bx} ${yy} ${bx} ${yy - r} L${bx} ${y2 + 6}`;
    return { d, arrow: `M${bx - 6} ${y2 + 12} ${bx} ${y2 + 6} ${bx + 6} ${y2 + 12}`, label: { x: bx + 14, y: (y2 + yy) / 2, align: 'left' as const, w: 110 }, bubble: { x: (ax + bx) / 2, y: yy - 40 } };
  };
  if (b.x >= a.x + a.w + gap) {
    const inWay = blocked(a.x + a.w, b.x);
    if (inWay.length) return around(inWay);
    const x1 = a.x + a.w; const x2 = b.x; const c = (x2 - x1) * 0.55;
    const mx = (x1 + x2) / 2; const my = (ay + by) / 2;
    return { d: `M${x1} ${ay} C${x1 + c} ${ay} ${x2 - c} ${by} ${x2} ${by}`, arrow: `M${x2 - 6} ${by - 4} ${x2} ${by} ${x2 - 6} ${by + 4}`, label: { x: mx, y: my, align: 'center', w: Math.max(44, Math.min(96, x2 - x1 - 8)) }, bubble: { x: mx, y: my + 22 } };
  }
  if (b.x + b.w <= a.x - gap) {
    const inWay = blocked(b.x + b.w, a.x);
    if (inWay.length) return around(inWay);
    const x1 = a.x; const x2 = b.x + b.w; const c = (x1 - x2) * 0.55;
    const mx = (x1 + x2) / 2; const my = (ay + by) / 2;
    return { d: `M${x1} ${ay} C${x1 - c} ${ay} ${x2 + c} ${by} ${x2} ${by}`, arrow: `M${x2 + 6} ${by - 4} ${x2} ${by} ${x2 + 6} ${by + 4}`, label: { x: mx, y: my, align: 'center', w: Math.max(44, Math.min(96, x1 - x2 - 8)) }, bubble: { x: mx, y: my + 22 } };
  }
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  if (b.y >= a.y + a.h + gap) {
    const y1 = a.y + a.h; const y2 = b.y; const c = (y2 - y1) * 0.55;
    const mx = (ax + bx) / 2; const my = (y1 + y2) / 2;
    return { d: `M${ax} ${y1} C${ax} ${y1 + c} ${bx} ${y2 - c} ${bx} ${y2}`, arrow: `M${bx - 4} ${y2 - 6} ${bx} ${y2} ${bx + 4} ${y2 - 6}`, label: { x: mx, y: my, align: 'center', w: 96 }, bubble: { x: mx + 60, y: my + 22 } };
  }
  if (b.y + b.h <= a.y - gap) {
    const y1 = a.y; const y2 = b.y + b.h; const c = (y1 - y2) * 0.55;
    const mx = (ax + bx) / 2; const my = (y1 + y2) / 2;
    return { d: `M${ax} ${y1} C${ax} ${y1 - c} ${bx} ${y2 + c} ${bx} ${y2}`, arrow: `M${bx - 4} ${y2 + 6} ${bx} ${y2} ${bx + 4} ${y2 + 6}`, label: { x: mx, y: my, align: 'center', w: 96 }, bubble: { x: mx + 60, y: my + 22 } };
  }
  return around([]);
}

interface Draft { from: MapRef; to: MapRef[]; edgeId: string | null; words: string; busy: boolean; at?: { x: number; y: number } }
interface TabPick { threadId: string; tabId: string; name: string; threadTitle: string; where: string }

// Every tab a connection can land on: the siblings on this map, then tabs
// in other workstreams, named where they live.
function tabPicks(task: Task, from: MapRef, query: string): TabPick[] {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  const hit = (row: TabPick) => !q || row.name.toLowerCase().includes(q) || row.threadTitle.toLowerCase().includes(q);
  const here = task.title || task.repoName || 'this workstream';
  const rows: TabPick[] = [
    ...(task.tabs || []).filter((tab) => tab.type !== 'duel' && !(from.threadId === task.id && tab.id === from.tabId)).map((tab) => ({ threadId: task.id, tabId: tab.id, name: tab.name || 'Untitled', threadTitle: here, where: `Tab in ${here}` })),
    ...destinationsElsewhere(task).filter((row) => !(row.threadId === from.threadId && row.tabId === from.tabId)).map((row) => {
      const at = row.name.lastIndexOf(' / ');
      const threadTitle = row.name.slice(0, at);
      return { threadId: row.threadId, tabId: row.tabId, name: row.name.slice(at + 3), threadTitle, where: `Tab in ${threadTitle}` };
    }),
  ];
  return rows.filter(hit).slice(0, 6);
}
// The menu sits under its field at the card's inset; when it would run past
// the bottom of the window it flips above the field instead, and what still
// does not fit scrolls inside the menu. The map itself never moves under a
// person mid sentence (design session, 2026-09-08).
interface AtMenu { cardKey: string; field: 'description' | 'tool' | 'add-tool' | 'add-skill'; index: number; query: string; selected: number; start: number; end: number; fieldTop: number; fieldBottom: number; flip: boolean }
interface MenuItem { type: 'connector' | 'skill' | 'tab'; id: string; name: string; where: string; threadId?: string }

function menuItems(task: Task, card: MapCard, query: string, lead: 'connector' | 'skill' = 'connector'): MenuItem[] {
  const q = query.trim().toLowerCase();
  const hit = (name: string) => !q || name.toLowerCase().includes(q);
  const seen = new Set<string>();
  const connectors: MenuItem[] = [];
  for (const connector of state.connectors) {
    const name = String(connector.name || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    connectors.push({ type: 'connector', id: name, name, where: 'Connector' });
  }
  const skills: MenuItem[] = state.plays.map((play) => ({ type: 'skill', id: play.id, name: play.name || 'Skill', where: 'Skill' }));
  const here = task.title || task.repoName || 'this workstream';
  const tabs: MenuItem[] = [
    ...(task.tabs || []).filter((tab) => tab.type !== 'duel' && !(card.own && tab.id === card.tabId)).map((tab) => ({ type: 'tab' as const, id: tab.id, threadId: task.id, name: tab.name || 'Untitled', where: `Tab in ${here}` })),
    ...destinationsElsewhere(task).filter((row) => !(row.threadId === card.threadId && row.tabId === card.tabId)).map((row) => ({ type: 'tab' as const, id: row.tabId, threadId: row.threadId, name: row.name.slice(row.name.lastIndexOf(' / ') + 3), where: `Tab in ${row.name.slice(0, row.name.lastIndexOf(' / '))}` })),
  ];
  // The skill line leads with skills; every other field leads with connectors.
  const [a, b] = lead === 'skill' ? [skills, connectors] : [connectors, skills];
  if (q) return [...a.filter((row) => hit(row.name)), ...b.filter((row) => hit(row.name)), ...tabs.filter((row) => hit(row.name) || hit(row.where))].slice(0, 8);
  // Unfiltered, every kind shows: a few of the leading kind, a couple of the
  // other, a couple of tabs, then whatever is left fills the eight rows.
  const first = [...a.slice(0, 4), ...b.slice(0, 2), ...tabs.slice(0, 2)];
  const rest = [...a.slice(4), ...b.slice(2), ...tabs.slice(2)];
  return [...first, ...rest].slice(0, 8);
}

const MENU_ICON = { connector: 'link', skill: 'asterisk', tab: 'columns' } as const;
const menuLead = (field: AtMenu['field']) => (field === 'add-skill' ? 'skill' : 'connector');

export function MapView() {
  const s = useApp();
  const mapThreadId = s.mapRoot;
  const task = mapThreadId ? s.cache[mapThreadId] : null;
  const map = task?.map || null;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [moving, setMoving] = useState<{ key: string; x: number; y: number } | null>(null);
  const [linking, setLinking] = useState<{ fromKey: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ x: number; y: number; name: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<AtMenu | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [addDrafts, setAddDrafts] = useState<Record<string, string>>({});
  // Board 10: the Add tab menu under the heading's button.
  const [addMenu, setAddMenu] = useState<{ query: string; selected: number } | null>(null);
  // Boards 4 and 4b: which row of the composer's tab menu is chosen.
  const [pick, setPick] = useState(0);
  // A drag that starts on one element and ends on another still fires a
  // click on their common parent; that click must not close what the drag
  // just opened.
  const swallowClick = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!s.playsLoaded) void loadPlays();
    if (!s.connectorsLoaded) void refreshConnectors();
  }, []);

  // Cards size to their content; the edges need the real height.
  useLayoutEffect(() => {
    if (!map) return;
    const next: Record<string, number> = {};
    let changed = false;
    for (const key of Object.keys(map.cards)) {
      const el = cardRefs.current[key];
      const h = el ? Math.round(el.getBoundingClientRect().height) : 0;
      if (h) next[key] = h;
      if (h && heights[key] !== h) changed = true;
    }
    if (changed || Object.keys(heights).length !== Object.keys(next).length) setHeights(next);
  });

  useLayoutEffect(() => {
    if (!menu || menu.flip || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) setMenu({ ...menu, flip: true });
  }, [menu]);

  const placed = useMemo<Placed[]>(() => {
    if (!map) return [];
    return Object.values(map.cards).map((card, index) => {
      const fallback = defaultPosition(index);
      const x = moving?.key === card.key ? moving.x : (card.x ?? fallback.x);
      const y = moving?.key === card.key ? moving.y : (card.y ?? fallback.y);
      return { card, x, y, w: CARD_W, h: heights[card.key] || (card.minimized ? CARD_MIN_H : CARD_H) };
    });
  }, [map, moving, heights]);
  const byKey = useMemo(() => new Map(placed.map((row) => [row.card.key, row])), [placed]);
  const canvasW = Math.max(1148, ...placed.map((row) => row.x + row.w + 40), dropHint ? dropHint.x + CARD_W + 40 : 0);
  const canvasH = Math.max(660, ...placed.map((row) => row.y + row.h + 120), dropHint ? dropHint.y + CARD_H + 60 : 0, draft?.at ? draft.at.y + 300 : 0);

  if (!mapThreadId) return null;
  if (!task || !map) {
    return (
      <>
        <TopBar><span className="crumb">Connected tabs</span><i /></TopBar>
        <div className="tabmap-page"><div className="tabmap-empty">Loading…</div></div>
      </>
    );
  }

  const canvasPoint = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left || 0), y: clientY - (rect?.top || 0) };
  };
  const cardAt = (x: number, y: number) => placed.find((row) => x >= row.x && x <= row.x + row.w && y >= row.y && y <= row.y + row.h) || null;
  const refOf = (card: MapCard): MapRef => ({ threadId: card.threadId, tabId: card.tabId, name: card.name, threadTitle: card.threadTitle });

  // Board 4: a connection is drawn from one card's port to another card.
  const startLink = (event: ReactPointerEvent<HTMLButtonElement>, card: MapCard) => {
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event.clientX, event.clientY);
    setOpenEdge(null);
    setDraft(null);
    setLinking({ fromKey: card.key, x: point.x, y: point.y });
    const move = (ev: PointerEvent) => { const p = canvasPoint(ev.clientX, ev.clientY); setLinking((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev)); };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const p = canvasPoint(ev.clientX, ev.clientY);
      const target = cardAt(p.x, p.y);
      setLinking(null);
      swallowClick.current = true;
      if (target && target.card.key === card.key) return;
      // Board 4: released anywhere, the composer opens there and the field
      // finds the tab; released on a card, that card is the tab.
      if (!target) {
        if (Math.abs(p.x - point.x) < 6 && Math.abs(p.y - point.y) < 6) return;
        setPick(0);
        setDraft({ from: refOf(card), to: [], edgeId: null, words: '', busy: false, at: { x: Math.round(p.x), y: Math.round(p.y) } });
        return;
      }
      const existing = map.edges.find((edge) => mapCardKey(edge.from.threadId, edge.from.tabId) === card.key && mapCardKey(edge.to.threadId, edge.to.tabId) === target.card.key);
      setDraft({ from: refOf(card), to: [refOf(target.card)], edgeId: existing?.id || null, words: existing?.words || '', busy: false, at: { x: Math.round(p.x), y: Math.round(p.y) } });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The header moves the card; a click on it does nothing, so the chevron
  // and the arrow keep their jobs.
  const startMove = (event: ReactPointerEvent<HTMLDivElement>, row: Placed) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const origin = canvasPoint(event.clientX, event.clientY);
    const offset = { x: origin.x - row.x, y: origin.y - row.y };
    let moved = false;
    let last = { x: row.x, y: row.y };
    const move = (ev: PointerEvent) => {
      const p = canvasPoint(ev.clientX, ev.clientY);
      if (!moved && Math.abs(p.x - origin.x) < 3 && Math.abs(p.y - origin.y) < 3) return;
      moved = true;
      last = { x: Math.max(0, Math.round(p.x - offset.x)), y: Math.max(0, Math.round(p.y - offset.y)) };
      setMoving({ key: row.card.key, ...last });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      swallowClick.current = true;
      const card = state.cache[mapThreadId]?.map?.cards[row.card.key];
      if (card) { card.x = last.x; card.y = last.y; }
      setMoving(null);
      void saveMapCard(mapThreadId, row.card.key, { x: last.x, y: last.y });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Board 3: a tab from the rail lands here as a card, the dashed target the
  // size of a real card under the cursor until it does.
  const tabInAir = (event: DragEvent) => {
    const key = draggedTabKey(event);
    if (!key) return null;
    const [threadId, tabId] = key.split('::');
    if (!threadId || !tabId) return null;
    const owner = s.cache[threadId] || null;
    const light = s.threads.find((row) => row.id === threadId);
    const name = owner?.tabs.find((tab) => tab.id === tabId)?.name || light?.tabs?.find((tab) => tab.id === tabId)?.name || 'that tab';
    return { threadId, tabId, name };
  };
  const onCanvasDragOver = (event: DragEvent<HTMLDivElement>) => {
    const air = tabInAir(event);
    if (!air) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const p = canvasPoint(event.clientX, event.clientY);
    const x = Math.max(0, Math.round(p.x - CARD_W / 2));
    const y = Math.max(0, Math.round(p.y - 40));
    setDropHint((prev) => (prev && Math.abs(prev.x - x) < 8 && Math.abs(prev.y - y) < 8 ? prev : { x, y, name: air.name }));
  };
  const onCanvasDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropHint(null);
  };
  const onCanvasDrop = (event: DragEvent<HTMLDivElement>) => {
    const air = tabInAir(event);
    setDropHint(null);
    if (!air) return;
    event.preventDefault();
    const p = canvasPoint(event.clientX, event.clientY);
    const x = Math.max(0, Math.round(p.x - CARD_W / 2));
    const y = Math.max(0, Math.round(p.y - 40));
    const key = mapCardKey(air.threadId, air.tabId);
    dragEnd();
    if (map.cards[key]) void saveMapCard(mapThreadId, key, { x, y });
    else void addMapCard(mapThreadId, air.threadId, air.tabId, x, y);
  };

  // With no target yet the whole field is the search; with one, an @ at the
  // end of the rule is (the same shape as the card's own @ menu).
  const draftMention = (current: Draft) => (current.to.length && !current.edgeId ? mentionAtCursor(current.words, current.words.length) : null);
  const draftPicks = (current: Draft) => {
    const mention = draftMention(current);
    if (current.to.length && !mention) return [];
    return tabPicks(task, current.from, mention ? mention.query : current.words)
      .filter((row) => !current.to.some((ref) => ref.threadId === row.threadId && ref.tabId === row.tabId));
  };
  const pickTab = (row: TabPick) => {
    if (!draft) return;
    const mention = draftMention(draft);
    const words = mention ? draft.words.slice(0, mention.start).replace(/\s+$/, '') : '';
    setDraft({ ...draft, to: [...draft.to, { threadId: row.threadId, tabId: row.tabId, name: row.name, threadTitle: row.threadTitle }], words });
    setPick(0);
  };
  const commitDraft = async () => {
    if (!draft || draft.busy) return;
    if (!draft.to.length || draftMention(draft)) {
      const rows = draftPicks(draft);
      const row = rows[Math.min(pick, rows.length - 1)];
      if (row) pickTab(row);
      return;
    }
    const words = draft.words.trim();
    if (!words) return;
    setDraft({ ...draft, busy: true });
    if (draft.edgeId) {
      const edge = await rewordMapEdge(mapThreadId, draft.edgeId, words);
      setDraft(null);
      if (edge) setOpenEdge(edge.id);
      return;
    }
    // Every chip gets the same words, one hand-over each. A tab from another
    // workstream lands as a card where the drag was released before its
    // connection is made, the next such tab a column along.
    let landedCount = 0;
    let last: MapEdge | null = null;
    for (const to of draft.to) {
      const targetKey = mapCardKey(to.threadId, to.tabId);
      if (!state.cache[mapThreadId]?.map?.cards[targetKey]) {
        const at = draft.at || { x: 0, y: 0 };
        const landed = await addMapCard(mapThreadId, to.threadId, to.tabId, Math.max(0, at.x - CARD_W / 2 + landedCount * COLUMN), Math.max(0, at.y + 24));
        if (!landed) { setDraft({ ...draft, busy: false }); return; }
        landedCount += 1;
      }
      const edge = await connectMapTabs(mapThreadId, draft.from, to, words);
      if (edge) last = edge;
    }
    setDraft(null);
    if (last) setOpenEdge(last.id);
  };
  // Board 10: Add tab. A tab from another workstream joins at the next
  // free slot; a new tab starts here and is a card on its own.
  const addTabRows = (query: string) => {
    const q = query.trim().toLowerCase();
    const here = task.title || task.repoName || 'this workstream';
    // This workstream's own tabs taken off the map come first, then tabs
    // from other workstreams.
    const own = (task.mapHiddenTabs || []).map((tab) => ({ threadId: task.id, tabId: tab.id, name: tab.name, threadTitle: here }));
    const elsewhere = destinationsElsewhere(task)
      .filter((row) => !map.cards[mapCardKey(row.threadId, row.tabId)])
      .map((row) => { const at = row.name.lastIndexOf(' / '); return { threadId: row.threadId, tabId: row.tabId, name: row.name.slice(at + 3), threadTitle: row.name.slice(0, at) }; });
    return [...own, ...elsewhere]
      .filter((row) => !q || row.name.toLowerCase().includes(q) || row.threadTitle.toLowerCase().includes(q))
      .slice(0, 8);
  };
  const addExistingTab = async (row: { threadId: string; tabId: string }) => {
    setAddMenu(null);
    const slot = defaultPosition(Object.keys(state.cache[mapThreadId]?.map?.cards || {}).length);
    await addMapCard(mapThreadId, row.threadId, row.tabId, slot.x, slot.y);
  };
  const startTabHere = async () => {
    setAddMenu(null);
    const tabId = await newMapTab(mapThreadId);
    if (!tabId) return;
    window.setTimeout(() => { (cardRefs.current[mapCardKey(mapThreadId, tabId)]?.querySelector('.tabmap-desc') as HTMLTextAreaElement | null)?.focus(); }, 60);
  };

  // Board 7: what the @ menu's pick files into. A connector is a tool with
  // a context line to fill; a skill is the skill; a tab is a connection.
  const pickMenuItem = async (card: MapCard, item: MenuItem) => {
    const current = menu;
    setMenu(null);
    if (current && (current.field === 'add-tool' || current.field === 'add-skill')) setAddDrafts((prev) => ({ ...prev, [`${card.key}:${current.field}`]: '' }));
    if (current && (current.field === 'description' || current.field === 'tool')) {
      const fieldKey = current.field === 'description' ? `${card.key}:description` : `${card.key}:tool:${current.index}`;
      const value = fieldDrafts[fieldKey] ?? (current.field === 'description' ? card.description : card.tools[current.index]?.context || '');
      const stripped = (value.slice(0, current.start) + value.slice(current.end)).replace(/\s+$/, '');
      setFieldDrafts((prev) => ({ ...prev, [fieldKey]: stripped }));
      if (current.field === 'description') await saveMapCard(mapThreadId, card.key, { description: stripped });
      else await saveMapCard(mapThreadId, card.key, { tools: card.tools.map((tool, index) => (index === current.index ? { ...tool, context: stripped } : tool)) });
    }
    const fresh = state.cache[mapThreadId]?.map?.cards[card.key] || card;
    if (item.type === 'connector') {
      if (fresh.tools.some((tool) => tool.name.toLowerCase() === item.name.toLowerCase())) return;
      const tools = [...fresh.tools, { name: item.name, context: '' }];
      await saveMapCard(mapThreadId, card.key, { tools });
      window.setTimeout(() => { (cardRefs.current[card.key]?.querySelector(`[data-tool-context="${tools.length - 1}"]`) as HTMLInputElement | null)?.focus(); }, 0);
      return;
    }
    if (item.type === 'skill') {
      await saveMapCard(mapThreadId, card.key, { skill: { id: item.id, name: item.name } });
      return;
    }
    if (item.type === 'tab' && item.threadId) {
      const targetKey = mapCardKey(item.threadId, item.id);
      let target = state.cache[mapThreadId]?.map?.cards[targetKey] || null;
      if (!target) {
        const here = byKey.get(card.key);
        target = await addMapCard(mapThreadId, item.threadId, item.id, (here?.x || 0) + COLUMN, here?.y || 0);
      }
      if (!target) return;
      const existing = (state.cache[mapThreadId]?.map?.edges || []).find((edge) => mapCardKey(edge.from.threadId, edge.from.tabId) === card.key && mapCardKey(edge.to.threadId, edge.to.tabId) === targetKey);
      setOpenEdge(null);
      setDraft({ from: refOf(fresh), to: [refOf(target)], edgeId: existing?.id || null, words: existing?.words || '', busy: false });
    }
  };

  const fieldValue = (card: MapCard, field: 'description' | 'tool', index: number) => {
    const key = field === 'description' ? `${card.key}:description` : `${card.key}:tool:${index}`;
    return fieldDrafts[key] ?? (field === 'description' ? card.description : card.tools[index]?.context || '');
  };
  const setFieldValue = (card: MapCard, field: 'description' | 'tool', index: number, value: string, cursor: number, el: HTMLElement) => {
    const key = field === 'description' ? `${card.key}:description` : `${card.key}:tool:${index}`;
    setFieldDrafts((prev) => ({ ...prev, [key]: value }));
    const mention = mentionAtCursor(value, cursor);
    if (mention) setMenu((prev) => ({ cardKey: card.key, field, index, query: mention.query, selected: 0, start: mention.start, end: mention.end, fieldTop: el.offsetTop, fieldBottom: el.offsetTop + el.offsetHeight, flip: prev?.cardKey === card.key && prev.field === field && prev.index === index ? prev.flip : false }));
    else if (menu && menu.cardKey === card.key && (menu.field === field)) setMenu(null);
  };
  const addKey = (card: MapCard, field: 'add-tool' | 'add-skill') => `${card.key}:${field}`;
  const addQuery = (value: string) => value.replace(/^\s*@/, '').trim();
  const openAddLine = (card: MapCard, field: 'add-tool' | 'add-skill', el: HTMLElement, value: string) => {
    setMenu((prev) => ({ cardKey: card.key, field, index: 0, query: addQuery(value), selected: 0, start: 0, end: 0, fieldTop: el.offsetTop, fieldBottom: el.offsetTop + el.offsetHeight, flip: prev?.cardKey === card.key && prev.field === field ? prev.flip : false }));
  };
  const typeAddLine = (card: MapCard, field: 'add-tool' | 'add-skill', value: string, el: HTMLElement) => {
    setAddDrafts((prev) => ({ ...prev, [addKey(card, field)]: value }));
    openAddLine(card, field, el, value);
  };
  const leaveAddLine = (card: MapCard, field: 'add-tool' | 'add-skill') => {
    window.setTimeout(() => { setMenu((prev) => (prev && prev.cardKey === card.key && prev.field === field ? null : prev)); }, 0);
  };
  const commitField = async (card: MapCard, field: 'description' | 'tool', index: number) => {
    const key = field === 'description' ? `${card.key}:description` : `${card.key}:tool:${index}`;
    const value = fieldDrafts[key];
    if (value === undefined) return;
    setFieldDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
    if (field === 'description') { if (value !== card.description) await saveMapCard(mapThreadId, card.key, { description: value }); }
    else if (value !== (card.tools[index]?.context || '')) await saveMapCard(mapThreadId, card.key, { tools: card.tools.map((tool, i) => (i === index ? { ...tool, context: value } : tool)) });
  };
  const menuKeys = (event: KeyboardEvent, card: MapCard) => {
    if (!menu || menu.cardKey !== card.key) return false;
    const items = menuItems(task, card, menu.query, menuLead(menu.field));
    if (event.key === 'ArrowDown') { event.preventDefault(); setMenu({ ...menu, selected: Math.min(items.length - 1, menu.selected + 1) }); return true; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setMenu({ ...menu, selected: Math.max(0, menu.selected - 1) }); return true; }
    if (event.key === 'Enter') { event.preventDefault(); const item = items[Math.min(menu.selected, items.length - 1)]; if (item) void pickMenuItem(card, item); return true; }
    if (event.key === 'Escape') { event.preventDefault(); setMenu(null); return true; }
    return false;
  };

  // Only a text field marks the card as being edited; a button's focus must
  // not re-render the card between mousedown and mouseup, which would
  // replace the icon under the pointer and lose the click.
  const focusIn = (key: string, target: EventTarget | null) => {
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) return;
    setEditing(key);
  };
  const blurOut = (key: string) => {
    window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && cardRefs.current[key]?.contains(active)) return;
      setEditing((prev) => (prev === key ? null : prev));
      setMenu((prev) => (prev && prev.cardKey === key ? null : prev));
    }, 0);
  };

  const projectName = projectLabel(task.repo, task.repoName);
  const title = task.title || task.repoName || 'Untitled';
  const cardCount = Object.keys(map.cards).length;
  const edgeCount = map.edges.length;
  const doneCount = Object.values(map.cards).filter((card) => card.done).length;
  // A map whose every card is done is a workflow that has run, and says so.
  const summary = cardCount === 0 ? 'No tabs yet' : doneCount === cardCount ? `${cardCount} ${cardCount === 1 ? 'tab' : 'tabs'}, all done` : `${cardCount} ${cardCount === 1 ? 'tab' : 'tabs'}, ${edgeCount ? `${edgeCount} ${edgeCount === 1 ? 'hand-over' : 'hand-overs'}` : 'no hand-overs yet'}`;
  // Section 27, boards 27.7 and 27.8: a workstream with an orchestrator
  // draws its map as the orchestrator's rails, and the head says so.
  const orchTab = (task.tabs || []).find((candidate) => candidate.type === 'orchestrator') || null;
  const orchLanes = orchTab ? laneStates(orchTab) : {};
  const orchRoster = orchTab ? Object.values(map.cards).filter((card) => card.key !== mapCardKey(task.id, orchTab.id)) : [];
  const orchStates = orchRoster.map((card) => laneState(orchLanes[card.key]));
  const orchWorkstreams = new Set(orchRoster.map((card) => card.threadId)).size;
  const orchSummary = orchTab ? `Written by the orchestrator · ${orchRoster.length} ${orchRoster.length === 1 ? 'tab' : 'tabs'} across ${orchWorkstreams} ${orchWorkstreams === 1 ? 'workstream' : 'workstreams'} · ${orchStates.filter((value) => value === 'back' || value === 'done').length} back, ${orchStates.filter((value) => value === 'out' || value === 'waiting' || value === 'quiet').length} out` : '';
  const panelEdge = openEdge ? map.edges.find((edge) => edge.id === openEdge) || null : null;
  const bubbleAt = (from: MapRef, to: MapRef | null, at?: { x: number; y: number }) => {
    const a = byKey.get(mapCardKey(from.threadId, from.tabId));
    const b = to ? byKey.get(mapCardKey(to.threadId, to.tabId)) : null;
    if (a && b) {
      const route = routeEdge(a, b, placed);
      return { left: Math.max(0, Math.min(canvasW - BUBBLE_W, route.bubble.x - BUBBLE_W / 2)), top: Math.max(0, route.bubble.y) };
    }
    // Released anywhere: the composer sits under the release point.
    const point = at || { x: canvasW / 2, y: 0 };
    return { left: Math.max(0, Math.min(canvasW - BUBBLE_W, point.x - BUBBLE_W / 2)), top: Math.max(0, point.y + 12) };
  };
  const linkFrom = linking ? byKey.get(linking.fromKey) : null;

  return (
    <>
      <TopBar>
        <span className="crumb tabmap-crumb">
          <span className="pane-project">{projectName}</span>
          <span className="pane-sep">/</span>
          <button type="button" className="pane-thread" title="Back to the workstream" onClick={() => void openThread(task.id)}>{title}</button>
        </span>
        <i />
      </TopBar>
      <div className={`tabmap-page${linking || moving ? ' busy' : ''}${orchTab ? ' tabmap-page-orch' : ''}`} onClick={(event) => { if (swallowClick.current) { swallowClick.current = false; return; } if (addMenu) setAddMenu(null); if ((event.target as HTMLElement).closest('.tabmap-card,.tabmap-bubble,.tabmap-edge-hit,.tabmap-edge-label')) return; setOpenEdge(null); if (draft && !draft.busy) setDraft(null); }}>
        <header className="tabmap-head tabmap-head-map">
          <div>
            {s.renaming?.kind === 'thread' && s.renaming.id === task.id ? (
              <RenameInput className="reninp tabmap-title-input" value={title} ariaLabel="Workstream name" />
            ) : (
              <h1 title="Double-click to rename" data-map-title onDoubleClick={() => { state.renaming = { kind: 'thread', id: task.id, paneIdx: null }; set(); }}>{title}</h1>
            )}
            <p data-map-summary>{orchTab ? orchSummary : summary}</p>
          </div>
          <div className="tabmap-head-actions">
            {/* Board 12, opt-in maps: Remove map takes this map off the Map
                page and lands there; the workstream, its tabs and the stored
                connections stay, and Add map brings it back. Shows when the
                head is hovered, the way a card's x does. */}
            <button type="button" className="tabmap-add-tab tabmap-remove-map" data-remove-map title="Take this map off the Map page. The workstream and its connections stay." onClick={(event) => { event.stopPropagation(); void setMapOn(task.id, false); }}>
              <Icon name="x" size={13} />Remove map
            </button>
          <div className="tabmap-add-wrap" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="tabmap-add-tab" data-add-tab aria-expanded={!!addMenu} onClick={() => setAddMenu(addMenu ? null : { query: '', selected: 0 })}>
              <Icon name="plus" size={13} />Add tab
            </button>
            {addMenu ? (() => {
              const rows = addTabRows(addMenu.query);
              const total = rows.length + 1;
              const selected = Math.min(addMenu.selected, total - 1);
              return (
                <div className="tabmap-add-menu" role="listbox" data-add-menu>
                  <div className="tabmap-add-search">
                    <Icon name="search" size={13} />
                    <input
                      autoFocus
                      aria-label="Search your tabs"
                      placeholder="Search your tabs"
                      value={addMenu.query}
                      onChange={(event) => setAddMenu({ query: event.target.value, selected: 0 })}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') { event.preventDefault(); setAddMenu({ ...addMenu, selected: Math.min(total - 1, selected + 1) }); }
                        if (event.key === 'ArrowUp') { event.preventDefault(); setAddMenu({ ...addMenu, selected: Math.max(0, selected - 1) }); }
                        if (event.key === 'Escape') { event.preventDefault(); setAddMenu(null); }
                        if (event.key === 'Enter') { event.preventDefault(); if (selected === 0) void startTabHere(); else void addExistingTab(rows[selected - 1]); }
                      }}
                    />
                  </div>
                  <i />
                  <button type="button" role="option" aria-selected={selected === 0} className={`tabmap-add-row new${selected === 0 ? ' sel' : ''}`} data-add-new onClick={() => void startTabHere()}>
                    <Icon name="plus" size={13} /><b>Start a new tab here</b>
                  </button>
                  {rows.length ? <i /> : null}
                  {rows.map((row, index) => (
                    <button type="button" role="option" key={`${row.threadId}:${row.tabId}`} aria-selected={selected === index + 1} className={`tabmap-add-row${selected === index + 1 ? ' sel' : ''}`} data-add-existing={row.tabId} onClick={() => void addExistingTab(row)}>
                      <Icon name="columns" size={13} /><span>{row.name}</span><small>{row.threadTitle}</small>
                    </button>
                  ))}
                </div>
              );
            })() : null}
          </div>
          {orchTab ? (
            <button type="button" className="tabmap-open-orch" data-open-orchestrator onClick={() => void openThreadAt(task.id, orchTab.id)}>
              <OrchMark size={12} />Open the orchestrator
            </button>
          ) : null}
          </div>
        </header>
        {orchTab ? <OrchMap task={task} hub={orchTab} /> : (
        <div
          className={`tabmap-canvas${dropHint ? ' dropping' : ''}`}
          ref={canvasRef}
          style={{ width: canvasW, height: canvasH }}
          data-tabmap={task.id}
          onDragOver={onCanvasDragOver}
          onDragEnter={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={onCanvasDrop}
        >
          <svg className="tabmap-edges" width={canvasW} height={canvasH} viewBox={`0 0 ${canvasW} ${canvasH}`} aria-hidden>
            {map.edges.map((edge) => {
              const a = byKey.get(mapCardKey(edge.from.threadId, edge.from.tabId));
              const b = byKey.get(mapCardKey(edge.to.threadId, edge.to.tabId));
              if (!a || !b) return null;
              const route = routeEdge(a, b, placed);
              const open = openEdge === edge.id;
              return (
                <g key={edge.id} className={`tabmap-edge${open ? ' open' : ''}`} data-edge={edge.id}>
                  <path className="tabmap-edge-hit" d={route.d} onClick={(event) => { event.stopPropagation(); setDraft(null); setOpenEdge(open ? null : edge.id); }} />
                  <path className="tabmap-edge-line" d={route.d} />
                  <path className="tabmap-edge-arrow" d={route.arrow} />
                </g>
              );
            })}
            {draft && !draft.edgeId ? (() => {
              // Boards 4, 4b and 5: the connection being described is on
              // the canvas already, dashed in the accent: to the release
              // point while the tab is still being found, routed to the
              // card once there is one.
              const a = byKey.get(mapCardKey(draft.from.threadId, draft.from.tabId));
              if (!a) return null;
              const targets = draft.to.map((ref) => byKey.get(mapCardKey(ref.threadId, ref.tabId))).filter((b): b is Placed => !!b);
              if (!targets.length) {
                const at = draft.at || { x: a.x + a.w / 2, y: a.y + a.h + 40 };
                return (
                  <g className="tabmap-edge pending loose" data-map-pending data-map-pending-loose>
                    <path className="tabmap-edge-line" d={`M${a.x + a.w / 2} ${a.y + a.h} L${at.x} ${at.y}`} />
                    <circle cx={a.x + a.w / 2} cy={a.y + a.h} r="3.5" className="tabmap-edge-dot" />
                  </g>
                );
              }
              // One dashed line per chip, so several targets read as several.
              return targets.map((b) => {
                const route = routeEdge(a, b, placed);
                return (
                  <g key={b.card.key} className="tabmap-edge pending" data-map-pending>
                    <path className="tabmap-edge-line" d={route.d} />
                    <path className="tabmap-edge-arrow" d={route.arrow} />
                    <circle cx={a.x + a.w / 2} cy={a.y + a.h} r="3" className="tabmap-edge-dot" />
                  </g>
                );
              });
            })() : null}
            {linking && linkFrom ? (
              <g className="tabmap-edge linking">
                <path className="tabmap-edge-line" d={`M${linkFrom.x + linkFrom.w / 2} ${linkFrom.y + linkFrom.h} L${linking.x} ${linking.y}`} />
                <circle cx={linkFrom.x + linkFrom.w / 2} cy={linkFrom.y + linkFrom.h} r="3" className="tabmap-edge-dot" />
              </g>
            ) : null}
          </svg>
          {map.edges.map((edge) => {
            const a = byKey.get(mapCardKey(edge.from.threadId, edge.from.tabId));
            const b = byKey.get(mapCardKey(edge.to.threadId, edge.to.tabId));
            if (!a || !b || !edge.rule.label) return null;
            const route = routeEdge(a, b, placed);
            return (
              <button
                type="button"
                key={`label-${edge.id}`}
                className={`tabmap-edge-label ${route.label.align}`}
                style={{ left: route.label.x, top: route.label.y, maxWidth: route.label.w }}
                data-edge-label={edge.id}
                title={edge.words}
                onClick={(event) => { event.stopPropagation(); setDraft(null); setOpenEdge(openEdge === edge.id ? null : edge.id); }}
              >
                {edge.rule.label}
              </button>
            );
          })}
          {placed.map((row) => {
            const card = row.card;
            const starts = startsOf(map, card.key);
            const cardMenu = menu && menu.cardKey === card.key ? menu : null;
            const items = cardMenu ? menuItems(task, card, cardMenu.query, menuLead(cardMenu.field)) : [];
            return (
              <div
                key={card.key}
                className={`tabmap-card${card.minimized ? ' minimized' : ''}${card.done ? ' done' : ''}${editing === card.key ? ' editing' : ''}${moving?.key === card.key ? ' moving' : ''}${linking && linking.fromKey !== card.key && cardAt(linking.x, linking.y)?.card.key === card.key ? ' link-target' : ''}`}
                style={{ left: row.x, top: row.y, width: CARD_W }}
                data-map-card={card.key}
                data-map-tab={card.tabId}
                ref={(el) => { cardRefs.current[card.key] = el; }}
                onFocusCapture={(event) => focusIn(card.key, event.target)}
                onBlurCapture={() => blurOut(card.key)}
              >
                <div className="tabmap-card-head" onPointerDown={(event) => startMove(event, row)}>
                  <Icon name="columns" size={14} />
                  <b>{card.name}</b>
                  {!card.own ? <small>{card.threadTitle}</small> : null}
                  <i />
                  <button type="button" className="tabmap-toggle" title={card.minimized ? 'Show the card' : 'Minimize the card'} aria-expanded={!card.minimized} data-map-toggle onClick={() => void saveMapCard(mapThreadId, card.key, { minimized: !card.minimized })}>
                    <Icon name={card.minimized ? 'chevronRight' : 'chevronDown'} size={13} />
                  </button>
                  <button type="button" className="tabmap-open" title={`Open ${card.name}`} data-map-open onClick={() => void openTabFromMap(mapThreadId, card.threadId, card.tabId)}>
                    <Icon name="arrowUpRight" size={13} />
                  </button>
                  <button type="button" className="tabmap-x tabmap-off" title={card.own ? 'Take off the map, the tab stays' : 'Take off this map'} aria-label={`Take ${card.name} off this map`} data-map-remove onClick={() => void removeMapCard(mapThreadId, card.key)}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
                {card.minimized ? (
                  <div className="tabmap-card-line">
                    <span>Starts</span>
                    <b>{starts[starts.length - 1]}</b>
                    <i />
                    <em>{countLine(card)}</em>
                  </div>
                ) : (
                  <div className="tabmap-card-body">
                    <textarea
                      className="tabmap-desc"
                      rows={2}
                      placeholder="What this tab is for"
                      aria-label={`What ${card.name} is for`}
                      value={fieldValue(card, 'description', 0)}
                      onChange={(event) => setFieldValue(card, 'description', 0, event.target.value, event.target.selectionStart ?? event.target.value.length, event.target)}
                      onKeyDown={(event) => { if (menuKeys(event, card)) return; if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLTextAreaElement).blur(); } }}
                      onBlur={() => { window.setTimeout(() => { if (!menu || menu.cardKey !== card.key) void commitField(card, 'description', 0); }, 0); }}
                    />
                    <div className="tabmap-section">
                      <span>Tools</span>
                      {card.tools.map((tool, index) => (
                        <div className="tabmap-tool" key={`${tool.name}-${index}`}>
                          <span className="tabmap-lane"><em className="tabmap-chip">@{tool.name}</em></span>
                          <input
                            className="tabmap-context"
                            data-tool-context={index}
                            placeholder="How this tab uses it"
                            aria-label={`How ${card.name} uses ${tool.name}`}
                            value={fieldValue(card, 'tool', index)}
                            onChange={(event) => setFieldValue(card, 'tool', index, event.target.value, event.target.selectionStart ?? event.target.value.length, event.target)}
                            onKeyDown={(event) => { if (menuKeys(event, card)) return; if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }}
                            onBlur={() => { window.setTimeout(() => { if (!menu || menu.cardKey !== card.key) void commitField(card, 'tool', index); }, 0); }}
                          />
                          <button type="button" className="tabmap-x" title={`Take ${tool.name} off`} aria-label={`Take ${tool.name} off ${card.name}`} data-tool-remove={index} onClick={() => void saveMapCard(mapThreadId, card.key, { tools: card.tools.filter((_, i) => i !== index) })}>
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      ))}
                      <input
                        className="tabmap-add"
                        data-add-tool
                        placeholder="Type @ to add a tool"
                        aria-label={`Add a tool to ${card.name}`}
                        value={addDrafts[addKey(card, 'add-tool')] || ''}
                        onFocus={(event) => openAddLine(card, 'add-tool', event.currentTarget, event.currentTarget.value)}
                        onChange={(event) => typeAddLine(card, 'add-tool', event.target.value, event.currentTarget)}
                        onKeyDown={(event) => { if (menuKeys(event, card)) return; if (event.key === 'Enter') event.preventDefault(); }}
                        onBlur={() => leaveAddLine(card, 'add-tool')}
                      />
                    </div>
                    <div className="tabmap-section">
                      <span>Skill</span>
                      {card.skill ? (
                        <div className="tabmap-skill-row">
                          <em className="tabmap-skill"><Icon name="asterisk" size={11} />@{card.skill.name}</em>
                          <button type="button" className="tabmap-x" title="Take the skill off" aria-label={`Take ${card.skill.name} off ${card.name}`} data-skill-remove onClick={() => void saveMapCard(mapThreadId, card.key, { skill: null })}>
                            <Icon name="x" size={11} />
                          </button>
                        </div>
                      ) : (
                        <input
                          className="tabmap-add"
                          data-add-skill
                          placeholder="Type @ to add a skill"
                          aria-label={`Add a skill to ${card.name}`}
                          value={addDrafts[addKey(card, 'add-skill')] || ''}
                          onFocus={(event) => openAddLine(card, 'add-skill', event.currentTarget, event.currentTarget.value)}
                          onChange={(event) => typeAddLine(card, 'add-skill', event.target.value, event.currentTarget)}
                          onKeyDown={(event) => { if (menuKeys(event, card)) return; if (event.key === 'Enter') event.preventDefault(); }}
                          onBlur={() => leaveAddLine(card, 'add-skill')}
                        />
                      )}
                    </div>
                    <div className="tabmap-section tabmap-starts">
                      <span>Starts</span>
                      <b data-map-starts>{starts.join(' · ')}</b>
                    </div>
                  </div>
                )}
                <button type="button" className="tabmap-port" title="Drag to another tab to connect them" aria-label={`Connect ${card.name} to another tab`} data-map-port onPointerDown={(event) => startLink(event, card)} />
                {cardMenu ? (
                  <div
                    className={`tabmap-menu${cardMenu.flip ? ' above' : ''}`}
                    role="listbox"
                    ref={menuRef}
                    style={cardMenu.flip ? { bottom: (cardRefs.current[card.key]?.offsetHeight || 0) - cardMenu.fieldTop + 4, width: MENU_W } : { top: cardMenu.fieldBottom + 4, width: MENU_W }}
                    data-map-menu
                    data-map-menu-flip={cardMenu.flip ? 'above' : 'below'}
                    onPointerDown={(event) => event.preventDefault()}
                  >
                    {items.length ? items.map((item, index) => (
                      <button
                        type="button"
                        key={`${item.type}-${item.threadId || ''}-${item.id}`}
                        role="option"
                        aria-selected={index === cardMenu.selected}
                        className={`tabmap-menu-item${index === cardMenu.selected ? ' sel' : ''}`}
                        data-menu-type={item.type}
                        onClick={() => void pickMenuItem(card, item)}
                      >
                        <Icon name={MENU_ICON[item.type]} size={13} />
                        <b>{item.name}</b>
                        <i />
                        <small>{item.where}</small>
                      </button>
                    )) : <div className="tabmap-menu-empty">Nothing matches that.</div>}
                  </div>
                ) : null}
              </div>
            );
          })}
          {cardCount === 0 && !dropHint ? (
            // Board 9: an empty map says so where the first card would sit.
            <div className="tabmap-placeholder" style={{ left: Math.max(0, (canvasW - CARD_W) / 2), top: 100 }} data-map-placeholder>
              <div className="tabmap-drop tabmap-drop-still">
                <span>Nothing on this map yet</span>
                <button type="button" className="tabmap-add-tab" data-add-tab-empty onClick={(event) => { event.stopPropagation(); setAddMenu({ query: '', selected: 0 }); }}><Icon name="plus" size={13} />Add tab</button>
              </div>
              <small>or drag one in from the sidebar</small>
            </div>
          ) : null}
          {dropHint ? (
            <div className="tabmap-drop" style={{ left: dropHint.x, top: dropHint.y }} data-map-drop>
              Drop {dropHint.name} here
            </div>
          ) : null}
          {draft ? (() => {
            const picking = !draft.to.length || !!draftMention(draft);
            const rows = draftPicks(draft);
            const selected = Math.min(pick, Math.max(0, rows.length - 1));
            const first = draft.to[0] || null;
            return (
              <div className={`tabmap-bubble tabmap-composer${picking ? ' picking' : ''}`} style={bubbleAt(draft.from, first, draft.at)} data-map-composer onClick={(event) => event.stopPropagation()} ref={(el) => { if (el && !first) el.scrollIntoView({ block: 'nearest' }); }}>
                <span>{draft.busy ? 'Making the rule from your words' : `${draft.from.name} hands over to`}</span>
                <div className="tabmap-composer-row">
                  {draft.to.map((ref) => <em key={`${ref.threadId}:${ref.tabId}`} className="tabmap-target" data-map-target={ref.tabId}><Icon name="columns" size={12} />@{ref.name}</em>)}
                  <input
                    autoFocus
                    aria-label={first ? `What ${draft.from.name} hands over` : `Which tab ${draft.from.name} hands over to`}
                    placeholder={!first ? '@ a tab' : draft.edgeId ? 'Say what hands over, in your own words' : 'Say what hands over, or @ another tab'}
                    value={draft.words}
                    disabled={draft.busy}
                    onChange={(event) => { setDraft({ ...draft, words: event.target.value }); setPick(0); }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); void commitDraft(); return; }
                      if (event.key === 'Escape') { event.preventDefault(); setDraft(null); return; }
                      if (picking && event.key === 'ArrowDown') { event.preventDefault(); setPick(Math.min(rows.length - 1, selected + 1)); return; }
                      if (picking && event.key === 'ArrowUp') { event.preventDefault(); setPick(Math.max(0, selected - 1)); return; }
                      // Backspace on an empty field takes the last tab back out.
                      if (first && !draft.edgeId && event.key === 'Backspace' && !draft.words) { event.preventDefault(); setDraft({ ...draft, to: draft.to.slice(0, -1) }); setPick(0); }
                    }}
                  />
                  <button type="button" className="tabmap-enter" title={picking ? 'Pick this tab' : 'Make the rule'} aria-label={picking ? 'Pick this tab' : 'Make the rule'} disabled={draft.busy || (picking ? !rows.length : !draft.words.trim())} onClick={() => void commitDraft()}>
                    <Icon name="cornerDownLeft" size={14} />
                  </button>
                </div>
                {picking ? (
                  <div className="tabmap-composer-picks" role="listbox" data-map-picks>
                    <i />
                    {rows.length ? rows.map((row, index) => (
                      <button type="button" role="option" key={`${row.threadId}:${row.tabId}`} aria-selected={index === selected} className={`tabmap-pick${index === selected ? ' sel' : ''}`} data-map-pick={row.tabId} onPointerDown={(event) => event.preventDefault()} onClick={() => pickTab(row)}>
                        <Icon name="columns" size={13} /><b>{row.name}</b><i /><small>{row.where}</small>
                      </button>
                    )) : <div className="tabmap-menu-empty">No tab matches that.</div>}
                  </div>
                ) : null}
              </div>
            );
          })() : null}
          {panelEdge && !draft ? (
            <div className="tabmap-bubble tabmap-rule" style={bubbleAt(panelEdge.from, panelEdge.to)} data-map-rule={panelEdge.id} onClick={(event) => event.stopPropagation()}>
              <div className="tabmap-rule-row"><span>When</span><b>{panelEdge.rule.when}</b></div>
              <div className="tabmap-rule-row"><span>Then</span><b>{panelEdge.rule.then}</b></div>
              <div className="tabmap-rule-row"><span>With</span><b>{panelEdge.rule.with}</b></div>
              <div className="tabmap-rule-foot">
                <i />
                <div>
                  <q>{panelEdge.words}</q>
                  <button type="button" className="tabmap-quiet" data-map-disconnect onClick={() => { setOpenEdge(null); void removeMapEdge(mapThreadId, panelEdge.id); }}>Disconnect</button>
                  <button type="button" className="tabmap-reword" data-map-reword onClick={() => { setOpenEdge(null); setDraft({ from: panelEdge.from, to: [panelEdge.to], edgeId: panelEdge.id, words: panelEdge.words, busy: false }); }}>Say it differently</button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        )}
      </div>
    </>
  );
}
