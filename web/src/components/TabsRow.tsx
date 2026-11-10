import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pendingConfirmation, state, set, emptyTab } from '../store';
import { Icon } from '../icons';
import { RenameInput } from './RenameInput';
import { selectTab, archiveTab, duelPhase, newTab, streamKey, setTabType } from '../actions';
import { OrchMark } from './OrchMark';
import { tabDragStart, dragEnd, splitTargetOver, tabTargetLeave, tabDrop } from '../lib/dnd';
import { openPop } from '../lib/ui';
import type { Task, Tab } from '../types';
import { initials } from '../lib/people';
import { tabAsleep, tabVitality, type Vitality } from '../lib/vitality';

// Paper 16.6: the dot is the finished signal visible from another pane. Ink
// blue and still while working, green once the turn lands with nothing
// waiting, the asleep grey after a day untouched, and the wait ring when the
// turn ended asking for something.
function StatusDot({ vitality, asleep }: { vitality: Vitality; asleep: boolean }) {
  if (vitality === 'waiting') return <u className="wait" />;
  if (vitality === 'working') return <u className="run" />;
  if (vitality === 'failed') return <u className="err" />;
  if (vitality === 'awake') return <u className={asleep ? 'asleep' : 'ok'} />;
  return null;
}

// Paper 16 C: a 26px segment sweeps the running tab's underline, 2s a lap and
// a 400ms hold, so eight tabs read at a glance. The dot stays lit and still.
function EdgeSweep({ vitality, threadId, tabId }: { vitality: Vitality; threadId: string; tabId: string }) {
  if (vitality !== 'working' || !state.motion.edges) return null;
  // Waiting on the user is the loudest signal in the app, so the sweep holds.
  const waiting = state.streams[streamKey(threadId, tabId)]?.computer?.state === 'paused';
  return <span className={`tab-track${waiting ? ' hold' : ''}`} aria-hidden><b /></span>;
}

// Strip geometry the overflow maths needs: the gap between tabs, the "+" tab,
// and the "+N" count. Kept in step with .tabs / .tab.add / .tab.more in CSS.
const GAP = 5;
const ADD_WIDTH = 27;
const MORE_WIDTH = 44;
// Once the strip is crammed (tabs folding into +N), the Done button drops its
// word and keeps the check. It only gets the word back when the row could hold
// everything plus this much slack, so re-showing it cannot re-cram the row.
const LABEL_SLACK = 56;

// Renders the tab strip for one pane: the tab buttons, a "+N" for tabs that
// no longer fit (Paper 13.3, option A: tabs stay where they are, overflow
// collapses to a count), and the "new tab" button.
export function TabsRow({ task, activeTab, idx }: { task: Task; activeTab: Tab | null; idx: number }) {
  // Paper 20: a done tab collapses into the day's tray. It stays visible only
  // while it is the pane's current tab (reading it back is allowed); anywhere
  // else the strip shows live work.
  const tabs = (task.tabs || []).filter((tab) => !tab.done || tab.id === (activeTab?.id || null));
  const rowRef = useRef<HTMLDivElement>(null);
  // Last measured width per tab id, so tabs folded into "+N" (no longer in
  // the DOM) still count when the strip widens again.
  const widths = useRef(new Map<string, number>());
  // How many leading tabs fit; null means every tab is shown (also the state
  // in which unmeasured newcomers get measured).
  const [limit, setLimit] = useState<number | null>(null);
  // Section 27, board 27.1: a tab's type, Tab or Orchestrator, set on the
  // tab from its right-click. The orchestrator mark is the type's identity.
  const [typeMenu, setTypeMenu] = useState<{ tabId: string; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!typeMenu) return undefined;
    const close = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest('.tab-type-menu')) return; setTypeMenu(null); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setTypeMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', closeOnEscape); };
  }, [typeMenu]);
  const activeId = activeTab?.id || null;
  const signature = tabs.map((t) => `${t.id}:${t.name || ''}:${t.type || ''}:${t.done ? 'd' : ''}`).join('|');

  const reviewActive = !!(state.duelReview
    && state.duelReview.paneIdx === idx
    && state.duelReview.threadId === task.id
    && state.duelReview.sourceTabId === activeTab?.id);

  let visible = tabs;
  if (limit != null && limit < tabs.length) {
    visible = tabs.slice(0, limit);
    // The active tab always stays on screen: it takes the last slot.
    const active = activeId ? tabs.find((t) => t.id === activeId) : null;
    if (active && !visible.includes(active)) {
      visible = visible.length ? [...visible.slice(0, -1), active] : [active];
    }
  }
  const hidden = tabs.filter((t) => !visible.includes(t));
  state.tabOverflow[idx] = hidden.map((t) => t.id);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return undefined;
    const measure = () => {
      // The fold owns fitting; any stray horizontal scroll (a trackpad
      // swipe, a focus scroll) would clip the first tab from the left.
      if (el.scrollLeft) el.scrollLeft = 0;
      el.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((node) => {
        if (node.dataset.tabId) widths.current.set(node.dataset.tabId, node.offsetWidth);
      });
      // A tab we have never measured has to be rendered once before it can
      // be folded away.
      if (tabs.some((t) => !widths.current.has(t.id))) {
        if (limit != null) setLimit(null);
        return;
      }
      const available = el.clientWidth;
      const everything = tabs.reduce((sum, t) => sum + (widths.current.get(t.id) || 0) + GAP, 0) + ADD_WIDTH;
      // The Done label yields with the same width logic as the tabs: crammed
      // the moment folding starts, back only once there is slack to spare
      // (hysteresis, or showing the word would re-trigger the fold forever).
      const strip = el.parentElement;
      if (strip) {
        const crammed = strip.classList.contains('crammed')
          ? available - everything < LABEL_SLACK
          : everything > available;
        strip.classList.toggle('crammed', crammed);
      }
      if (everything <= available) {
        if (limit != null) setLimit(null);
        return;
      }
      let used = MORE_WIDTH + GAP + ADD_WIDTH;
      let count = 0;
      for (const t of tabs) {
        const width = (widths.current.get(t.id) || 0) + GAP;
        if (used + width > available) break;
        used += width;
        count += 1;
      }
      const next = Math.max(1, count);
      if (next !== limit) setLimit(next);
    };
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [signature, limit, activeId]);

  return (
    <div className="tabs-scroll" ref={rowRef}>
      {visible.map((t) => {
        const cls = !reviewActive && t.id === (activeTab && activeTab.id) ? 'sel' : '';
        const needsReply = !!pendingConfirmation(t);
        const vitality = tabVitality(task, t);
        const asleep = tabAsleep(task, t);
        const archiveBtn = tabs.length > 1 ? (
          <s
            className="tabx"
            title={emptyTab(t) ? 'Close tab' : 'Archive tab'}
            aria-label={`${emptyTab(t) ? 'Close' : 'Archive'} ${t.name || 'tab'}`}
            onClick={(e) => { e.stopPropagation(); archiveTab(task.id, t.id); }}
          >
            <Icon name="x" size={11} />
          </s>
        ) : null;

        if (t.type === 'duel') {
          const pending = duelPhase(t) !== 'picked';
          return (
            <button key={t.id} data-tab-id={t.id} className={`tab duel ${cls}`} onClick={() => selectTab(idx, t.id)}>
              {pending ? <u /> : null}Duel{archiveBtn}
            </button>
          );
        }

        if (state.renaming && state.renaming.kind === 'tab' && state.renaming.id === t.id
          && (state.renaming.paneIdx == null || state.renaming.paneIdx === idx)) {
          return (
            <span key={t.id} data-tab-id={t.id} className="tab sel">
              <StatusDot vitality={vitality} asleep={asleep} />
              <RenameInput className="reninp" value={t.name} />
            </span>
          );
        }

        return (
          <button
            key={t.id}
            data-tab-id={t.id}
            data-tab-status={t.status || 'idle'}
            className={`tab ${cls} ${needsReply ? 'needs-confirmation' : ''}${asleep ? ' asleep' : ''}`}
            draggable
            title="Double-click to rename · drag to split or move"
            onClick={() => selectTab(idx, t.id)}
            onDoubleClick={() => { state.renaming = { kind: 'tab', id: t.id, threadId: task.id, paneIdx: idx }; set(); }}
            onDragStart={(e) => tabDragStart(e, `${task.id}::${t.id}`)}
            onDragEnd={dragEnd}
            onDragOver={splitTargetOver}
            onDragLeave={tabTargetLeave}
            onDrop={(e) => tabDrop(e, idx, task.id, t.id)}
            onContextMenu={(e) => { if (t.type === 'duel') return; e.preventDefault(); e.stopPropagation(); setTypeMenu({ tabId: t.id, left: Math.max(8, Math.min(e.clientX, window.innerWidth - 336)), top: Math.max(8, Math.min(e.clientY, window.innerHeight - 200)) }); }}
          >
            <StatusDot vitality={vitality} asleep={asleep} />{t.type === 'orchestrator' ? <OrchMark size={12} className="tab-orch" /> : null}{t.name}{t.id === activeId ? (
              // Board 27.1: the caret on the chip is how a person finds that
              // a tab has a type; right-click is the second way in.
              <span
                className="tab-caret"
                role="button"
                tabIndex={0}
                aria-label={`What ${t.name} is`}
                aria-haspopup="menu"
                aria-expanded={typeMenu?.tabId === t.id}
                data-tab-caret
                onClick={(e) => { e.stopPropagation(); const chip = (e.currentTarget as HTMLElement).closest('.tab')?.getBoundingClientRect(); setTypeMenu(typeMenu?.tabId === t.id ? null : { tabId: t.id, left: Math.max(8, Math.min(chip?.left ?? e.clientX, window.innerWidth - 336)), top: Math.min((chip?.bottom ?? e.clientY) + 7, window.innerHeight - 200) }); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); (e.currentTarget as HTMLElement).click(); } }}
              >
                <Icon name="chevronDown" size={10} />
              </span>
            ) : null}{(task.viewers || []).filter((viewer) => viewer.tabId === t.id).slice(0, 1).map((viewer) => <b key={viewer.id} className="tab-viewer" title={`${viewer.name} is here`} data-tab-viewer={viewer.name}>{initials(viewer.name)}</b>)}{needsReply ? <small className="tab-needs-reply">reply</small> : null}{archiveBtn}<EdgeSweep vitality={vitality} threadId={task.id} tabId={t.id} />
          </button>
        );
      })}
      {activeTab && state.peeks[task.id] === activeTab.id && !tabs.some((t) => t.id === activeTab.id) ? (
        // Paper 20.6: the peek tab — in the strip while you look, dashed so
        // it reads as archived, gone when you switch away.
        <button className="tab peek sel" aria-current="page" title="Reading an archived tab">
          <Icon name="archive" size={11} />{activeTab.name}
        </button>
      ) : null}
      {hidden.length ? (
        <button
          className="tab more"
          title={`${hidden.length} more ${hidden.length === 1 ? 'tab' : 'tabs'}`}
          aria-label={`${hidden.length} more ${hidden.length === 1 ? 'tab' : 'tabs'}`}
          onClick={(e) => openPop(e.currentTarget, 'tabsmore', idx)}
        >
          +{hidden.length}
        </button>
      ) : null}
      {reviewActive ? (
        <button className="tab duel decided sel" aria-current="page">
          Duel · decided
        </button>
      ) : null}
      <button
        className="tab add"
        title="New blank tab · same context and model"
        onClick={() => { void newTab(task.id, activeTab?.model || task.model || 'recommended', idx); }}
      >
        <Icon name="plus" size={14} />
      </button>
      {typeMenu ? (() => {
        const target = (task.tabs || []).find((row) => row.id === typeMenu.tabId);
        const current = target?.type === 'orchestrator' ? 'orchestrator' : 'tab';
        const pick = (type: 'tab' | 'orchestrator') => { setTypeMenu(null); if (type !== current) void setTabType(task.id, typeMenu.tabId, type); };
        return (
          <div className="tab-type-menu" role="menu" aria-label={`What ${target?.name || 'this tab'} is`} data-tab-type-menu style={{ left: typeMenu.left, top: typeMenu.top }} onPointerDown={(event) => event.stopPropagation()}>
            <div className="tab-type-label">WHAT THIS TAB IS</div>
            <button type="button" role="menuitemradio" aria-checked={current === 'tab'} className="tab-type-row" data-tab-type="tab" onClick={() => pick('tab')}>
              <Icon name="columns" size={13} />
              <span><b>Tab</b><small>Talks to you, and to tabs you name</small></span>
              {current === 'tab' ? <Icon name="check" size={12} /> : null}
            </button>
            <button type="button" role="menuitemradio" aria-checked={current === 'orchestrator'} className="tab-type-row" data-tab-type="orchestrator" onClick={() => pick('orchestrator')}>
              <OrchMark size={13} />
              <span><b>Orchestrator</b><small>Reaches every tab in the project, writes the map it works from, and the network opens beside it</small></span>
              {current === 'orchestrator' ? <Icon name="check" size={12} /> : null}
            </button>
            <footer>One orchestrator per project</footer>
          </div>
        );
      })() : null}
    </div>
  );
}
