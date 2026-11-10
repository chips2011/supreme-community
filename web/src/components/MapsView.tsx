import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useApp, projectLabel } from '../store';
import { TopBar } from './bits';
import { Icon } from '../icons';
import { openMap, refreshThreads, setMapOn } from '../actions';
import { relativeTime } from '../lib/format';
import type { TaskSummary } from '../types';


function countLine(row: TaskSummary): string {
  // The cards on the map, which is the live tabs less the done ones.
  const tabs = row.mapCards ?? row.tabCount ?? 0;
  const handovers = row.mapHandovers || 0;
  if (!tabs) return `${projectLabel(row.repo, row.repoName)} · No tabs yet`;
  if ((row.mapDone || 0) >= tabs) return `${projectLabel(row.repo, row.repoName)} · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'}, all done`;
  return `${projectLabel(row.repo, row.repoName)} · ${tabs} ${tabs === 1 ? 'tab' : 'tabs'}, ${handovers ? `${handovers} ${handovers === 1 ? 'hand-over' : 'hand-overs'}` : 'no hand-overs yet'}`;
}

function when(value: string | undefined): string {
  const short = relativeTime(value);
  if (!short) return '';
  return short === 'now' ? 'just now' : `${short} ago`;
}

type RowMenu = { id: string; name: string; left: number; top: number };

export function MapsView() {
  const s = useApp();
  useEffect(() => { void refreshThreads(); }, []);
  const at = (row: TaskSummary) => Date.parse(row.lastActivity || row.updatedAt || '') || 0;
  const live = s.threads
    .filter((row) => !row.archived)
    .sort((a, b) => at(b) - at(a));
  const rows = live.filter((row) => !row.mapOff);
  const without = live.filter((row) => row.mapOff);
  const count = rows.length;
  const line = count === 0 ? 'No maps yet' : count === 1 ? '1 map' : `${count} maps, newest first`;
  // The Add map menu under the heading's button, the same menu Add tab
  // opens on a map (board 10), over the workstreams that have no map.
  const [addMenu, setAddMenu] = useState<{ query: string; selected: number } | null>(null);
  // A row's right-click menu, the rail's menu grammar.
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  useEffect(() => {
    if (!rowMenu) return undefined;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.archive-context-menu')) return;
      setRowMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRowMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [rowMenu]);
  const addRows = (query: string) => {
    const q = query.trim().toLowerCase();
    return without
      .filter((row) => !q || (row.title || row.repoName || '').toLowerCase().includes(q) || projectLabel(row.repo, row.repoName).toLowerCase().includes(q))
      .slice(0, 8);
  };
  const startMap = async (row: TaskSummary | undefined) => {
    if (!row) return;
    setAddMenu(null);
    if (await setMapOn(row.id, true)) await openMap(row.id);
  };
  const openRowMenu = (event: ReactMouseEvent, row: TaskSummary) => {
    event.preventDefault();
    event.stopPropagation();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - 94));
    setRowMenu({ id: row.id, name: row.title || row.repoName || 'Untitled', left, top });
  };
  return (
    <>
      <TopBar><span className="crumb">Map</span><i /></TopBar>
      <div className="maps-page" onClick={() => { if (addMenu) setAddMenu(null); }}>
        <header className="tabmap-head tabmap-head-map">
          <div>
            <h1>Map</h1>
            <p data-maps-count>{line}</p>
          </div>
          <div className="tabmap-add-wrap" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="tabmap-add-tab" data-add-map aria-expanded={!!addMenu} onClick={() => setAddMenu(addMenu ? null : { query: '', selected: 0 })}>
              <Icon name="plus" size={13} />Add map
            </button>
            {addMenu ? (() => {
              const list = addRows(addMenu.query);
              const selected = Math.min(addMenu.selected, Math.max(0, list.length - 1));
              return (
                <div className="tabmap-add-menu" role="listbox" data-add-map-menu>
                  <div className="tabmap-add-search">
                    <Icon name="search" size={13} />
                    <input
                      autoFocus
                      aria-label="Search your workstreams"
                      placeholder="Search your workstreams"
                      value={addMenu.query}
                      onChange={(event) => setAddMenu({ query: event.target.value, selected: 0 })}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') { event.preventDefault(); setAddMenu({ ...addMenu, selected: Math.min(list.length - 1, selected + 1) }); }
                        if (event.key === 'ArrowUp') { event.preventDefault(); setAddMenu({ ...addMenu, selected: Math.max(0, selected - 1) }); }
                        if (event.key === 'Escape') { event.preventDefault(); setAddMenu(null); }
                        if (event.key === 'Enter') { event.preventDefault(); void startMap(list[selected]); }
                      }}
                    />
                  </div>
                  <i />
                  {list.length ? list.map((row, index) => (
                    <button type="button" role="option" key={row.id} aria-selected={selected === index} className={`tabmap-add-row${selected === index ? ' sel' : ''}`} data-add-map-row={row.id} onClick={() => void startMap(row)}>
                      <Icon name="connected" size={13} /><span>{row.title || row.repoName || 'Untitled'}</span><small>{projectLabel(row.repo, row.repoName)}</small>
                    </button>
                  )) : (
                    <div className="tabmap-add-none">{without.length ? 'No workstream by that name' : 'Every workstream has a map'}</div>
                  )}
                </div>
              );
            })() : null}
          </div>
        </header>
        {count ? (
          <div className="maps-list" role="list">
            {rows.map((row) => (
              <button type="button" key={row.id} className="maps-row" role="listitem" data-map-row={row.id} onClick={() => void openMap(row.id)} onContextMenu={(event) => openRowMenu(event, row)}>
                <Icon name="connected" size={15} />
                <div>
                  <b>{row.title || row.repoName || 'Untitled'}</b>
                  <span>{countLine(row)}</span>
                </div>
                <i />
                <time>{when(row.lastActivity || row.updatedAt)}</time>
                <Icon name="chevronRight" size={13} />
              </button>
            ))}
          </div>
        ) : (
          <div className="tabmap-empty" data-maps-empty>No maps yet. Add map picks a workstream, and its tabs are its map.</div>
        )}
        {rowMenu ? (
          <div className="archive-context-menu" role="menu" aria-label={`Map actions for ${rowMenu.name}`} style={{ left: rowMenu.left, top: rowMenu.top }} onClick={(event) => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => { const target = rowMenu; setRowMenu(null); void openMap(target.id); }}><Icon name="connected" size={13} />Open map</button>
            <button type="button" role="menuitem" data-remove-map-row onClick={() => { const target = rowMenu; setRowMenu(null); void setMapOn(target.id, false); }}><Icon name="x" size={13} />Remove map</button>
          </div>
        ) : null}
      </div>
    </>
  );
}
