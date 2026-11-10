import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp, state } from '../store';
import { Icon } from '../icons';
import { OrchMark } from './OrchMark';
import { openThreadAt, undoTraffic } from '../actions';
import { MAP_RING, clockTime, labelPoint, lanePath, outWords, ringPositions, ringSize, rosterOf, sinceMidnight, trafficRows } from '../lib/orchestrator';
import { useLanes } from '../lib/laneClock';
import type { Task, Tab } from '../types';


const NODE_W = MAP_RING.node.w;
const NODE_H = MAP_RING.node.h;
const HUB_W = MAP_RING.hub.w;
const HUB_H = MAP_RING.hub.h;
const HUB_INSET = MAP_RING.hubInset;
const NODE_INSET = MAP_RING.nodeInset;
const PAD = 72;
const ZOOM = { min: 0.3, max: 2.5 };
const FIT_GAP = 24;

type View = { x: number; y: number; k: number };

const gist = (value: string | undefined, max = 60) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\s,;:]+$/, '')}…` : text;
};
const clampZoom = (value: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, value));
const onGround = (target: EventTarget | null) => !(target instanceof Element && target.closest('button, .omap-lane-label, .omap-hub, .omap-zoom, .omap-rail'));

export function OrchMap({ task, hub }: { task: Task; hub: Tab }) {
  const s = useApp();
  const { now, lanes, states: laneOf } = useLanes(hub);
  const roster = rosterOf(task, hub.id);
  const states = roster.map((card) => laneOf[card.key] || 'idle');
  const out = states.filter((value) => value === 'out' || value === 'waiting' || value === 'quiet').length;
  const back = states.filter((value) => value === 'back' || value === 'done').length;
  const moving = states.some((value) => value === 'out' || value === 'back');
  const runningTabs = useMemo(() => {
    const running = new Set<string>();
    for (const row of s.threads) for (const other of row.tabs || []) if (other.status === 'running') running.add(other.id);
    return running;
  }, [s.threads]);
  const rows = trafficRows(task, hub, { now, runningTabs });
  const today = sinceMidnight(rows, now);
  const [docked, setDocked] = useState(() => { try { return localStorage.getItem('supreme.orchTraffic') !== 'tucked'; } catch { return true; } });
  const dock = (open: boolean) => { setDocked(open); try { localStorage.setItem('supreme.orchTraffic', open ? 'docked' : 'tucked'); } catch {} };

  // The world: a ring big enough for the roster, with room around it.
  const ring = useMemo(() => ringSize(roster.length, MAP_RING), [roster.length]);
  const world = { w: ring.rx * 2 + NODE_W + PAD * 2, h: ring.ry * 2 + NODE_H + PAD * 2 };
  const centre = { x: world.w / 2, y: world.h / 2 };
  const positions = ringPositions(roster.length, { cx: centre.x, cy: centre.y, rx: ring.rx, ry: ring.ry });
  // What is actually drawn, for the fit: a roster of two sits on the top
  // and bottom of the ring with nothing at its sides.
  const bounds = useMemo(() => {
    const boxes = [{ x: centre.x, y: centre.y, w: HUB_W, h: HUB_H }];
    roster.forEach((card, index) => {
      boxes.push({ ...positions[index], w: NODE_W, h: NODE_H });
      if (card.owes) boxes.push({ ...labelPoint(centre, positions[index], HUB_INSET, NODE_INSET), ...(MAP_RING.label || { w: 170, h: 30 }) });
    });
    const left = Math.min(...boxes.map((box) => box.x - box.w / 2));
    const top = Math.min(...boxes.map((box) => box.y - box.h / 2));
    const right = Math.max(...boxes.map((box) => box.x + box.w / 2));
    const bottom = Math.max(...boxes.map((box) => box.y + box.h / 2));
    return { left, top, w: right - left, h: bottom - top };
  }, [roster.map((card) => `${card.key}:${card.owes ? 1 : 0}`).join('|'), ring.rx, ring.ry]); // eslint-disable-line react-hooks/exhaustive-deps

  // The view onto it: where the world sits in the canvas and at what zoom.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);
  const [panning, setPanning] = useState(false);
  const fit = () => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    const k = clampZoom(Math.min(1, (canvas.clientWidth - FIT_GAP * 2) / bounds.w, (canvas.clientHeight - FIT_GAP * 2) / bounds.h));
    setView({ k, x: Math.round((canvas.clientWidth - bounds.w * k) / 2 - bounds.left * k), y: Math.round((canvas.clientHeight - bounds.h * k) / 2 - bounds.top * k) });
    touched.current = false;
  };
  const zoomAt = (px: number, py: number, factor: number) => {
    setView((prev) => {
      const k = clampZoom(prev.k * factor);
      const ratio = k / prev.k;
      return { k, x: Math.round(px - (px - prev.x) * ratio), y: Math.round(py - (py - prev.y) * ratio) };
    });
    touched.current = true;
  };
  const zoomBy = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, factor);
  };
  // Fit on open and whenever the ring changes size; follow the window while
  // the person has not moved the view themselves.
  useLayoutEffect(() => { fit(); }, [bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(() => { if (!touched.current) fit(); });
    watcher.observe(canvas);
    return () => watcher.disconnect();
  }, [bounds]); // eslint-disable-line react-hooks/exhaustive-deps
  // Two fingers pan, pinch (ctrl+wheel in the browser's eyes) or cmd+scroll
  // zooms at the pointer. A native listener, since React's wheel is passive
  // and the page must not scroll or zoom instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.01));
        return;
      }
      setView((prev) => ({ ...prev, x: Math.round(prev.x - event.deltaX), y: Math.round(prev.y - event.deltaY) }));
      touched.current = true;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onGround(event.target)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const start = { x: event.clientX, y: event.clientY, view: viewRef.current };
    let moved = false;
    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - start.x;
      const dy = move.clientY - start.y;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      setPanning(true);
      touched.current = true;
      setView({ ...start.view, x: Math.round(start.view.x + dx), y: Math.round(start.view.y + dy) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setPanning(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // The last thing back from each tab, for the node's line.
  const lastBack = new Map<string, string>();
  for (const message of hub.messages || []) if (message.role === 'tab' && message.direction === 'in' && message.from?.tabId) lastBack.set(message.from.tabId, message.content);
  const still = !state.motion.edges;
  const zoomPct = Math.round(view.k * 100);
  return (
    <div className={`omap${docked ? ' docked' : ''}`} data-orch-map>
      <div className={`omap-canvas${panning ? ' panning' : ''}`} ref={canvasRef} data-orch-canvas onPointerDown={onPointerDown} onDoubleClick={(event) => { if (onGround(event.target)) fit(); }}>
        <div className={`omap-world${still ? ' still' : ''}`} style={{ width: world.w, height: world.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }} data-orch-world data-orch-zoom-level={view.k.toFixed(2)}>
          <svg width={world.w} height={world.h} viewBox={`0 0 ${world.w} ${world.h}`} aria-hidden>
            {roster.map((card, index) => {
              const d = lanePath(centre, positions[index], HUB_INSET, NODE_INSET);
              return (
                <g key={card.key} className={`net-lane ${states[index]}`} data-orch-lane={card.tabId} data-lane-state={states[index]}>
                  <path className="net-base" d={d} />
                  <path className="net-tail" d={d} pathLength={100} />
                  <path className="net-spark" d={d} pathLength={100} />
                </g>
              );
            })}
          </svg>
          <div className={`omap-hub${moving ? ' active' : ''}`} style={{ left: centre.x - HUB_W / 2, top: centre.y - HUB_H / 2 }} data-orch-hub>
            <div className="omap-hub-head">
              <OrchMark size={13} />
              <b>{hub.name}</b>
              <button type="button" className="omap-hub-open" title="Open the orchestrator" aria-label="Open the orchestrator" data-orch-hub-open onClick={() => void openThreadAt(task.id, hub.id)}><Icon name="arrowUpRight" size={12} /></button>
            </div>
            <div className="omap-hub-body">
              <span>Across every workstream in {task.repoName || 'this project'}</span>
              <small><i />{back} back, {out} out</small>
            </div>
          </div>
          {roster.map((card, index) => {
            const value = states[index];
            const lane = lanes[card.key];
            const line = lastBack.get(card.tabId) ? gist(lastBack.get(card.tabId)) : card.description ? gist(card.description) : value === 'quiet' ? `Out ${Math.round((now - (Date.parse(lane?.askedAt || '') || now)) / 60_000)} minutes, nothing back` : 'Nothing back yet';
            const at = labelPoint(centre, positions[index], HUB_INSET, NODE_INSET);
            return (
              <div key={card.key}>
                <button type="button" className={`omap-node ${value === 'out' || value === 'back' ? 'moving' : value}`} style={{ left: positions[index].x - NODE_W / 2, top: positions[index].y - NODE_H / 2 }} title={lastBack.get(card.tabId) || card.description || undefined} data-orch-node={card.tabId} data-node-state={value} onClick={() => void openThreadAt(card.threadId, card.tabId)}>
                  <span className="omap-node-head"><i className="net-state" /><b>{card.name}</b><small>{card.threadTitle}</small></span>
                  <span className="omap-node-line">{line}</span>
                </button>
                {card.owes || value === 'quiet' ? (
                  <span className={`omap-lane-label${value === 'quiet' ? ' quiet' : ''}`} style={{ left: at.x, top: at.y }} title={card.owes || undefined} data-orch-lane-label={card.tabId}>
                    {card.owes ? <b>{card.owes}</b> : null}
                    {value === 'quiet' ? <small>{outWords(lane?.askedAt, now)}</small> : null}
                  </span>
                ) : null}
              </div>
            );
          })}
          {!roster.length ? <div className="omap-empty" style={{ left: centre.x - 170, top: centre.y + HUB_H / 2 + 24 }}>No tabs on the roster yet. The orchestrator puts them on as it works, or Add tab does.</div> : null}
        </div>
        <div className="omap-zoom" data-orch-zoom>
          <button type="button" title="Zoom out" aria-label="Zoom out" data-orch-zoom-out onClick={() => zoomBy(1 / 1.25)}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1.5 5 H8.5" stroke="currentColor" strokeWidth="1.3" /></svg></button>
          <button type="button" className="omap-zoom-fit" title="Fit the map" aria-label="Fit the map" data-orch-zoom-fit onClick={fit}>{zoomPct}%</button>
          <button type="button" title="Zoom in" aria-label="Zoom in" data-orch-zoom-in onClick={() => zoomBy(1.25)}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1.5 5 H8.5 M5 1.5 V8.5" stroke="currentColor" strokeWidth="1.3" /></svg></button>
        </div>
      </div>
      {docked ? (
        <aside className="omap-rail" data-orch-rail>
          <div className="omap-rail-head">
            <b>Traffic</b>
            <span>{today.length ? 'today' : 'nothing today'}</span>
            <button type="button" className="omap-rail-collapse" title="Tuck the traffic away" aria-label="Tuck the traffic away" data-orch-rail-collapse onClick={() => dock(false)}>
              <svg width="12" height="12" viewBox="0 0 13 13" aria-hidden><path d="M6.8 3 L10.2 6.5 L6.8 10" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.6 3 L6 6.5 L2.6 10" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            </button>
          </div>
          <div className="omap-rail-rows">
            {rows.map((row) => (
              <div key={row.id} className={`trow ${row.kind}`} data-traffic-row={row.kind}>
                <time>{clockTime(row.at)}</time>
                {row.event ? (
                  <div className="trow-wrote">
                    <p>{row.text}</p>
                    {row.event.undone ? <em className="trow-undone">Taken back</em> : <button type="button" className="trow-undo" data-traffic-undo={row.event.id} onClick={() => void undoTraffic(task.id, row.event!.id)}>{row.event.action === 'remove' ? 'Put it back' : row.event.action === 'write' ? 'Undo' : 'Take it off'}</button>}
                  </div>
                ) : <p>{row.text}</p>}
              </div>
            ))}
            {!rows.length ? <div className="trow"><time /><p className="trow-none">Nothing yet</p></div> : null}
          </div>
          <div className="omap-rail-foot">Messages and what it wrote to the map</div>
        </aside>
      ) : (
        <button type="button" className="omap-traffic-pill" title="Show the traffic" data-orch-traffic-pill onClick={() => dock(true)}>
          <svg width="12" height="12" viewBox="0 0 13 13" aria-hidden><path d="M6.2 3 L2.8 6.5 L6.2 10" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M10.4 3 L7 6.5 L10.4 10" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
          <span>Traffic</span>
          <b data-orch-traffic-count>{today.length}</b>
        </button>
      )}
    </div>
  );
}
