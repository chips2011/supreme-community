import { useMemo } from 'react';
import { useApp, state } from '../store';
import { openMap, openThreadAt, undoTraffic } from '../actions';
import { PANEL_RING, clockTime, lanePath, outWords, ringPositions, ringSize, rosterOf, trafficRows } from '../lib/orchestrator';
import { useLanes } from '../lib/laneClock';
import type { Task, Tab } from '../types';

// Section 27, board 27.2 to 27.5: the Network panel beside an orchestrator
// tab's conversation. The hub in the middle, one lane out to each roster
// tab, and the last few lines of traffic under it. A lane only goes blue
// while a message is on the wire: one pass out when it is sent, one pass
// back when the answer comes, dashed grey in between, and after ten
// minutes with nothing back it stops moving and says how long it has been
// out. The motion is the running-tab sweep and the run-card road from
// section 16; with motion off the lane changes state and the time updates.

const BOX = { w: 459, h: 560, cx: 230, cy: 300, rx: 128, ry: 200 };
const PILL_W = 180;
const PILL_H = 34;
// 2026-09-17: past what the board's ring holds, the ring grows until no
// pill touches another or the hub, and the whole ring scales down to fit
// the panel (the map beside it is the open canvas; the panel stays 460).


export function NetworkPanel({ task, tab }: { task: Task; tab: Tab }) {
  const s = useApp();
  const { now, lanes, states: laneOf } = useLanes(tab);
  const roster = rosterOf(task, tab.id);
  const states = roster.map((card) => laneOf[card.key] || 'idle');
  const waiting = states.filter((value) => value === 'out' || value === 'waiting' || value === 'quiet').length;
  const back = states.filter((value) => value === 'back' || value === 'done').length;
  const moving = states.some((value) => value === 'out' || value === 'back');
  const runningTabs = useMemo(() => {
    const running = new Set<string>();
    for (const row of s.threads) for (const other of row.tabs || []) if (other.status === 'running') running.add(other.id);
    for (const cached of Object.values(s.cache)) for (const other of cached?.tabs || []) if (other.status === 'running' || other.activeRun) running.add(other.id);
    return running;
  }, [s.threads, s.cache]);
  const rows = trafficRows(task, tab, { now, runningTabs });
  const ring = useMemo(() => ringSize(roster.length, PANEL_RING), [roster.length]);
  const grown = ring.rx > BOX.rx || ring.ry > BOX.ry;
  const world = grown ? { w: ring.rx * 2 + PILL_W + 24, h: ring.ry * 2 + PILL_H + 24 } : { w: BOX.w, h: BOX.h };
  const centre = grown ? { x: world.w / 2, y: world.h / 2 } : { x: BOX.cx, y: BOX.cy };
  const scale = grown ? Math.min(BOX.w / world.w, BOX.h / world.h) : 1;
  const offset = { x: (BOX.w - world.w * scale) / 2, y: (BOX.h - world.h * scale) / 2 };
  const positions = ringPositions(roster.length, { cx: centre.x, cy: centre.y, rx: ring.rx, ry: ring.ry });
  const lastAsked = Object.values(lanes).map((lane) => lane.askedAt || '').filter(Boolean).sort().at(-1);
  const hubLine = back ? `${back} back, ${waiting} out` : lastAsked ? `asked ${states.filter((value) => value !== 'idle').length} at ${clockTime(lastAsked)}` : roster.length ? 'nothing asked yet' : 'no roster yet';
  const still = !state.motion.edges;
  return (
    <aside className="net" data-network-panel aria-label={`Network of ${tab.name}`}>
      <div className="net-head">
        <h2>Network</h2>
        <span className="net-count" data-network-count>{roster.length} {roster.length === 1 ? 'tab' : 'tabs'} · {waiting} waiting</span>
        <button type="button" className="net-open" title="Open the map" aria-label="Open the map" data-network-map onClick={() => void openMap(task.id)}>
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden><path d="M7.6 1.6 H11.4 V5.4 M11.4 1.6 L7.2 5.8 M5.4 11.4 H1.6 V7.6 M1.6 11.4 L5.8 7.2" fill="none" stroke="currentColor" strokeWidth="1.1" /></svg>
        </button>
      </div>
      <div className={`net-ring${still ? ' still' : ''}`} data-network-ring data-network-scale={scale.toFixed(2)}>
       <div className="net-world" style={{ width: world.w, height: world.h, transform: `translate(${offset.x.toFixed(1)}px, ${offset.y.toFixed(1)}px) scale(${scale})` }}>
        <svg width={world.w} height={world.h} viewBox={`0 0 ${world.w} ${world.h}`} aria-hidden>
          {roster.map((card, index) => {
            const d = lanePath(centre, positions[index], PANEL_RING.hubInset, PANEL_RING.nodeInset);
            return (
              <g key={card.key} className={`net-lane ${states[index]}`} data-network-lane={card.tabId} data-lane-state={states[index]}>
                <path className="net-base" d={d} />
                <path className="net-tail" d={d} pathLength={100} />
                <path className="net-spark" d={d} pathLength={100} />
              </g>
            );
          })}
        </svg>
        <div className={`net-hub${moving ? ' active' : ''}`} style={{ left: centre.x, top: centre.y }} data-network-hub>
          <b>{tab.name}</b>
          <span data-network-hub-line>{hubLine}</span>
        </div>
        {roster.map((card, index) => {
          const lane = lanes[card.key];
          const value = states[index];
          const owes = value === 'quiet' ? outWords(lane?.askedAt, now) : card.owes || '';
          return (
            <button type="button" key={card.key} className={`net-node ${value === 'out' || value === 'back' ? 'moving' : value}`} style={{ left: positions[index].x - PILL_W / 2, top: positions[index].y - 17 }} data-network-node={card.tabId} data-node-state={value} title={`${card.threadTitle} / ${card.name}`} onClick={() => void openThreadAt(card.threadId, card.tabId)}>
              <i className="net-state" />
              <span className="net-name">{card.name}</span>
              <small className="net-owes">{owes}</small>
            </button>
          );
        })}
        {!roster.length ? <div className="net-empty">No tabs on the roster yet. The orchestrator puts them on as it works, or Add tab on the map does.</div> : null}
       </div>
      </div>
      <div className="net-traffic" data-network-traffic>
        <span className="net-label">TRAFFIC</span>
        {rows.map((row, index) => (
          <div key={row.id} className={`trow ${row.kind}${index === 0 ? ' now' : ''}`} data-traffic-row={row.kind}>
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
    </aside>
  );
}
