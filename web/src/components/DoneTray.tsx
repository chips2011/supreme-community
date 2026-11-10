import { useEffect, useRef, useState } from 'react';
import { projectLabel, set, state, useApp, peekingTab } from '../store';
import { archiveDoneRow, archiveDoneThread, archiveDoneToday, bringBackTab, bringBackThread, openThread, setTabDone } from '../actions';
import { Icon } from '../icons';
import type { Tab, Task } from '../types';

// Paper 20.3, current boards: one segmented control in the pane header —
// "✓ Done | 6". The left segment dones the tab on screen (the gesture for
// "clear this off my screen mid-work"); the right segment is the day's tally
// and opens the shelf. The count is the hero: what you moved today.
type DoneRow = {
  threadId: string;
  tabId: string;
  repo: string;
  // Scoped shelf rows are the shortest identifying name (board 20.3: the tab
  // name only); the all-workstreams view needs the thread for identity.
  short: string;
  full: string;
  tabName: string;
  title: string;
  doneAt: string;
  today: boolean;
  archivedTab: boolean;
};

export function doneShelfRows(): DoneRow[] {
  const today = new Date().toDateString();
  const rows: DoneRow[] = [];
  for (const t of state.threads) {
    for (const tab of t.doneTabs || []) {
      if (!tab.doneAt) continue;
      const multi = (t.tabCount || 0) + (t.archivedTabCount || 0) > 1;
      rows.push({
        threadId: t.id,
        tabId: tab.id,
        repo: t.repo,
        short: multi ? tab.name : t.title,
        full: multi ? `${t.title} · ${tab.name}` : t.title,
        tabName: tab.name,
        title: t.title,
        doneAt: tab.doneAt,
        today: new Date(tab.doneAt).toDateString() === today,
        archivedTab: !!t.archived || (t.archivedTabs || []).some((archived) => archived.id === tab.id),
      });
    }
  }
  return rows.sort((a, b) => b.doneAt.localeCompare(a.doneAt));
}

export function doneTodayRows(): DoneRow[] {
  return doneShelfRows().filter((row) => row.today);
}

type ShelfItem =
  | { kind: 'tab'; row: DoneRow; doneAt: string; today: boolean; repo: string }
  | { kind: 'workstream'; threadId: string; repo: string; title: string; tabCount: number; doneAt: string; today: boolean };

export function doneShelfItems(): ShelfItem[] {
  const today = new Date().toDateString();
  const items: ShelfItem[] = [];
  const whole = new Set<string>();
  for (const t of state.threads) {
    if (!t.done || t.archived || !(t.tabCount || 0)) continue;
    const archivedIds = new Set((t.archivedTabs || []).map((tab) => tab.id));
    const live = (t.doneTabs || []).filter((tab) => tab.doneAt && !archivedIds.has(tab.id));
    const doneAt = live.map((tab) => tab.doneAt as string).sort().at(-1) || '';
    if (!doneAt) continue;
    whole.add(t.id);
    items.push({ kind: 'workstream', threadId: t.id, repo: t.repo, title: t.title, tabCount: live.length, doneAt, today: new Date(doneAt).toDateString() === today });
  }
  for (const row of doneShelfRows()) {
    if (row.archivedTab || whole.has(row.threadId)) continue;
    items.push({ kind: 'tab', row, doneAt: row.doneAt, today: row.today, repo: row.repo });
  }
  return items.sort((a, b) => b.doneAt.localeCompare(a.doneAt));
}

// A parked row's age, in the archive rows' language: 18h under a day,
// then 3d.
function ageLabel(doneAt: string): string {
  const ms = Date.now() - Date.parse(doneAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Board 20.2a, rebuilt: 700ms, front-loaded — the click is instant, the
// payoff is the count. 0-90 the left segment fills like a switch; 90-260
// green floods the in-thread hairline; 260-520 the tab lifts out of the
// strip and arcs (never a straight line) into the count segment; 520-640
// the count goes solid, punches, and the number rolls up from below;
// 640-700 everything settles.
const FILL_MS = 90;
const FLOOD_MS = 170;
const ARC_MS = 260;

function arcGhost(fromEl: HTMLElement, toEl: HTMLElement): void {
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  const ghost = document.createElement('span');
  ghost.className = 'done-arc-ghost';
  ghost.textContent = (fromEl.textContent || '').trim();
  ghost.style.left = `${from.left}px`;
  ghost.style.top = `${from.top}px`;
  document.body.appendChild(ghost);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0 },
    // The waypoint sits above the straight line between the two, so the
    // flight reads as a lift and drop, not a slide.
    { transform: `translate(${dx * 0.45}px, ${Math.min(dy * 0.3, 0) - 18}px) scale(0.96)`, opacity: 0.75, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0, offset: 1 },
  ], { duration: ARC_MS, easing: 'cubic-bezier(.3,.05,.25,1)' }).onfinish = () => ghost.remove();
}

const markingTabs = new Set<string>();

// The one done gesture, shared by the header control and the in-thread
// hairline. All choreography is DOM-side; the store flips at the moment the
// tab should leave the strip.
// One soft tick at the catch, never the press, never blocking — two sounds
// in 700ms reads as an error chime, and a stutter kills the feel for good.
export function softTick(): void {
  try {
    const Ctor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1240;
    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => { void ctx.close().catch(() => {}); };
  } catch { /* sound is garnish, never a failure */ }
}

export function markTabDone(task: Task, tab: Tab, paneIdx: number): void {
  if (markingTabs.has(tab.id)) return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { void setTabDone(task.id, tab.id, true); return; }
  markingTabs.add(tab.id);
  const pane = document.querySelector(`[data-pane-index="${paneIdx}"]`);
  const button = pane?.querySelector('.tabs .done-now') as HTMLElement | null;
  const count = (pane?.querySelector('.paneh .done-count')
    || document.querySelector('.paneh-shared .done-count')
    || document.querySelector('.done-count')) as HTMLElement | null;
  // Press: the button fills like a switch and the pane's ground washes
  // green once — the section 16 wash with blue swapped out, not a loop.
  button?.classList.add('marking');
  pane?.classList.add('done-wash');
  window.setTimeout(() => pane?.querySelector('.done-mark')?.classList.add('flood'), FILL_MS);
  window.setTimeout(() => {
    const tabEl = pane?.querySelector(`.tabs [data-tab-id="${tab.id}"]`) as HTMLElement | null;
    if (tabEl && count) arcGhost(tabEl, count);
    // The strip closes the gap while the ghost flies. max-width needs a
    // measured starting value or the collapse has nothing to animate from.
    if (tabEl) {
      tabEl.style.maxWidth = `${tabEl.offsetWidth}px`;
      void tabEl.offsetWidth;
      tabEl.classList.add('departing');
    }
  }, FILL_MS + FLOOD_MS);
  window.setTimeout(() => {
    void setTabDone(task.id, tab.id, true).finally(() => markingTabs.delete(tab.id));
    count?.classList.add('punch');
    softTick();
  }, FILL_MS + FLOOD_MS + ARC_MS);
  window.setTimeout(() => {
    button?.classList.remove('marking');
    count?.classList.remove('punch');
    // Removing the class removes the gradient outright. Settling to a green
    // background-color would leave every finished pane faintly tinted and
    // the wash would stop meaning anything.
    pane?.classList.remove('done-wash');
  }, 700);
}

// Board 20.7: Done is the furthest-right control in each pane's tab strip —
// with two panes open, a single header button cannot say which tab it
// means. On an archived thread (or a peeked archived tab) it stays visible
// but greyed, so the strip never changes shape.
export function DoneNow({ task, tab, paneIdx }: { task: Task; tab: Tab | null; paneIdx: number }) {
  useApp();
  const peeking = !!tab && peekingTab(task, tab.id);
  const canMark = !!tab && !tab.done && tab.type !== 'duel' && !task.archived && !peeking;
  return (
    <button
      type="button"
      className={`done-now${tab?.done ? ' held' : ''}`}
      disabled={!canMark}
      title={task.archived || peeking ? 'Archived work cannot be doned' : tab?.done ? 'This tab is done' : 'Done with this tab'}
      onClick={() => { if (canMark && tab) markTabDone(task, tab, paneIdx); }}
    >
      <Icon name="check" size={11} /><span className="done-now-label">Done</span>
    </button>
  );
}

// The header keeps only the count — a check and a number. Clicking it opens
// the shelf.
export function DoneCount({ task, paneIdx }: { task: Task; paneIdx: number }) {
  useApp();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [allScope, setAllScope] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('.done-tray, .done-count')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const rows = doneShelfRows();
  const count = rows.filter((row) => row.today).length;
  // The list is the parking lot: still done, not yet archived — whole
  // workstreams as one row each, loose tabs one by one.
  const parked = doneShelfItems();
  const shown = allScope ? parked : parked.filter((item) => item.repo === task.repo);
  const todayShown = shown.filter((item) => item.today);
  const earlierShown = shown.filter((item) => !item.today);
  const toggle = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen((value) => !value);
  };
  const shelfRow = (item: ShelfItem) => {
    const aged = Date.now() - Date.parse(item.doneAt) > 24 * 3_600_000;
    if (item.kind === 'workstream') {
      return (
        <div
          className="done-tray-row quiet workstream"
          key={`ws:${item.threadId}`}
          role="menuitem"
          tabIndex={0}
          onClick={() => { setOpen(false); void openThread(item.threadId); }}
        >
          <span className="done-row-text">
            <b>{item.title}</b>
            <small>{allScope ? `${projectLabel(item.repo)} · ` : ''}Workstream · {item.tabCount} {item.tabCount === 1 ? 'tab' : 'tabs'}</small>
          </span>
          {!item.today ? <time>{ageLabel(item.doneAt)}</time> : null}
          {aged ? (
            <button
              type="button"
              className="done-row-archive"
              title="Archive workstream"
              aria-label={`Archive ${item.title}`}
              onClick={(event) => { event.stopPropagation(); void archiveDoneThread(item.threadId); }}
            >
              <Icon name="archive" size={12} />
            </button>
          ) : null}
          <button type="button" className="bring-back" onClick={(event) => { event.stopPropagation(); void bringBackThread(item.threadId); }}>Bring back</button>
        </div>
      );
    }
    const row = item.row;
    return (
      <div
        className="done-tray-row quiet"
        key={`${row.threadId}:${row.tabId}`}
        role="menuitem"
        tabIndex={0}
        onClick={() => {
          setOpen(false);
          void openThread(row.threadId).then(() => {
            const pane = state.panes[state.activePane || 0];
            if (pane?.threadId === row.threadId) { pane.tabId = row.tabId; set(); }
          });
        }}
      >
        <span className="done-row-text">
          <b>{row.tabName}</b>
          <small>{allScope ? `${projectLabel(row.repo)} · ${row.title}` : row.title}</small>
        </span>
        {!row.today ? <time>{ageLabel(row.doneAt)}</time> : null}
        {aged ? (
          <button
            type="button"
            className="done-row-archive"
            title="Archive"
            aria-label={`Archive ${row.short}`}
            onClick={(event) => { event.stopPropagation(); void archiveDoneRow(row.threadId, row.tabId); }}
          >
            <Icon name="archive" size={12} />
          </button>
        ) : null}
        <button type="button" className="bring-back" onClick={(event) => { event.stopPropagation(); void bringBackTab(row.threadId, row.tabId); }}>Bring back</button>
      </div>
    );
  };
  return (
    <>
      <button
        type="button"
        className="done-count"
        data-done-count={paneIdx}
        ref={anchor}
        aria-expanded={open}
        title="Moved today"
        onClick={toggle}
      >
        {/* Keyed remount rolls the new number up from below (board 20.2a). */}
        <Icon name="check" size={11} /><b key={count}>{count}</b>
      </button>
      {open && pos ? (
        <div className="done-tray" style={{ top: pos.top, right: pos.right }} role="menu" aria-label="Done today">
          {/* The header names what you are looking at; the scope link names
              where it takes you (so wide mode's way back carries the project
              name the header dropped). Archive all sweeps what is shown. */}
          <header>
            <small>{allScope ? 'Done today' : `Done in ${projectLabel(task.repo, task.repoName)}`}</small>
            <span className="links">
              {shown.length ? (
                <button type="button" onClick={() => { void archiveDoneToday(allScope ? undefined : task.repo); }}>Archive all</button>
              ) : null}
              <button type="button" onClick={() => setAllScope((value) => !value)}>
                {allScope ? `${projectLabel(task.repo, task.repoName)} only` : 'All projects'}
              </button>
            </span>
          </header>
          {shown.length ? (
            <>
              {todayShown.map((row) => shelfRow(row))}
              {earlierShown.length ? <div className="done-tray-divider" aria-label="Done before today"><span>Earlier</span><i /></div> : null}
              {earlierShown.map((row) => shelfRow(row))}
            </>
          ) : <div className="done-tray-empty">Nothing done here yet.</div>}
        </div>
      ) : null}
    </>
  );
}
