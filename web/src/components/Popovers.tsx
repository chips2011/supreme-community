import { useEffect, type ReactNode, type CSSProperties } from 'react';
import {
  useApp, state, set, modelDesc, modelReady, providerHint, performanceStop, threadsForRepo,
  projectLabel,
} from '../store';
import { RECOMMENDED_MODEL } from '../constants';
import { EFFORTS } from '../constants';
import { Icon } from '../icons';
import { closePop, openPopAt } from '../lib/ui';
import { dragEnd, tabDragStart } from '../lib/dnd';
import {
  navigate, rememberModel, setTabModel, toggleConnectors, savePrefs, saveDefault, beginProjectCreation,
  refreshConnectors, openConnectorSettings,
  archiveProject, createDuel, newTab, selectTab, duelPhase, openShareDialog } from '../actions';
import type { Model, Task } from '../types';
import { ModelMark } from './bits';
import { SplitPicker } from './SplitPicker';
import { ContextPullPicker } from './ContextPullPicker';

function popBoxStyle(width: number | undefined): CSSProperties {
  const w = width || 262;
  const a = state.pop?.anchor || { left: 100, right: 200, top: 120, bottom: 140 };
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const left = Math.max(10, Math.min(a.left, vw - w - 10));
  const openUp = a.top > vh / 2;
  const vpos: CSSProperties = openUp ? { bottom: Math.round(vh - a.top + 6) } : { top: Math.round(a.bottom + 6) };
  return { position: 'fixed', left: Math.round(left), width: w, maxHeight: '70vh', overflow: 'auto', ...vpos };
}

function PopBox({ width, children }: { width?: number; children: ReactNode }) {
  return <div className="pop" style={popBoxStyle(width)}>{children}</div>;
}

function ModelOptions({ selected, onSelect }: { selected?: string; onSelect: (id: string) => void }) {
  const s = useApp();
  return (
    <>
      <div className={`recommended-option ${selected === RECOMMENDED_MODEL.id ? 'sel' : ''}`}>
        <button className="recommended-pick" onClick={() => onSelect(RECOMMENDED_MODEL.id)}>
          <span className="model-spark"><Icon name="sparkles" size={12} /></span>
          <span><b>Recommended <em>default</em></b><small>Best-value pick per step · dial: {performanceStop().label}</small></span>
        </button>
        <button className="recommended-link" onClick={() => navigate('performance')}>Performance →</button>
      </div>
      {s.models.filter((m: Model) => !m.retired || m.id === selected).map((m: Model) => {
        const ready = modelReady(m.id);
        const hint = providerHint(m.id);
        return (
          <button
            key={m.id}
            className={`it ${m.id === selected ? 'sel' : ''} ${ready ? '' : 'disabled'}`}
            disabled={!ready}
            title={ready ? '' : hint}
            onClick={() => { if (ready) onSelect(m.id); }}
          >
            <ModelMark id={m.id} />{m.label}<em>{ready ? modelDesc(m.id) : hint || 'Not connected'}</em>
          </button>
        );
      })}
    </>
  );
}

function ConnectorsPop({ task }: { task: Task | null }) {
  const s = useApp();
  const on = task ? task.connectors : true;
  useEffect(() => {
    void refreshConnectors({ fresh: true });
  }, []);
  return (
    <PopBox width={290}>
      <div className="hd">
        <span>Connectors{task ? ' · this workstream' : ''}</span>
        <button
          type="button"
          className="pop-refresh"
          disabled={s.connectorsRefreshing}
          onClick={() => void refreshConnectors({ fresh: true })}
        >
          {s.connectorsRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {task ? (
        <>
          <button className="it" onClick={() => toggleConnectors(task.id)}>
            <u style={{ background: on ? 'var(--ok)' : 'var(--n400)' }} />
            {on ? 'On for this workstream' : 'Off for this workstream'}<em>{on ? 'tap to turn off' : 'tap to turn on'}</em>
          </button>
          <div style={{ height: 1, background: 'var(--line)', margin: '5px 0' }} />
        </>
      ) : (
        <div className="sub" style={{ padding: '6px 9px', fontSize: 9.5 }}>
          New workstreams start with connectors on. Claude models use these; Codex models use browser control instead.
        </div>
      )}
      {!s.connectorsLoaded ? (
        <div className="sub" style={{ padding: '8px 9px' }} aria-live="polite">Loading connectors…</div>
      ) : s.connectors.length ? s.connectors.map((connector) => (
        <div key={`${connector.provider || 'provider'}:${connector.name}`} className="it" style={{ cursor: 'default' }}>
          <span className={`dot ${connector.connected ? 'ok' : 'err'}`} />{connector.name}<em>{connector.status}</em>
        </div>
      )) : (
        <div className="sub" style={{ padding: '8px 9px' }}>
          No connected services found. Connect services inside Claude or ChatGPT, then refresh.
        </div>
      )}
      <div style={{ height: 1, background: 'var(--line)', margin: '5px 0' }} />
      <div className="hd">Add more</div>
      <button className="it" onClick={() => void openConnectorSettings('claude')}>Claude connectors<em>Open settings</em></button>
      <button className="it" onClick={() => window.open('https://chatgpt.com/download', '_blank', 'noopener,noreferrer')}>ChatGPT desktop<em>Open download</em></button>
    </PopBox>
  );
}

export function Popovers() {
  const s = useApp();
  const k = s.pop?.kind || null;
  if (!s.pop) return null;
  let box: ReactNode = null;

  if (k === 'homemodel') {
    box = (
      <PopBox width={310}>
        <div className="hd">Model</div>
        <ModelOptions selected={s.homeModel} onSelect={(id) => { rememberModel(id); state.pop = null; set(); }} />
      </PopBox>
    );
  } else if (k === 'homeproj') {
    box = (
      <PopBox>
        <div className="hd">Project</div>
        {s.projects.map((p) => (
          <button
            key={p.path}
            className={`it ${p.path === s.homeProject ? 'sel' : ''}`}
            onClick={() => { state.homeProject = p.path; state.pop = null; savePrefs(); set(); }}
          >
            <u style={{ borderRadius: 3, background: 'var(--n500)' }} />{p.name}<em>{threadsForRepo(p.path).length}</em>
          </button>
        ))}
        <div style={{ height: 1, background: 'var(--line)', margin: '5px 0' }} />
        <button className="it" onClick={beginProjectCreation}>+ Add a project</button>
      </PopBox>
    );
  } else if (k === 'effort') {
    box = (
      <PopBox width={210}>
        <div className="hd">Effort</div>
        {EFFORTS.map((e) => (
          <button
            key={e[0]}
            className={`it ${e[0] === s.effort ? 'sel' : ''}`}
            onClick={() => { state.effort = e[0]; state.pop = null; savePrefs(); saveDefault({ defaultEffort: state.effort }); set(); }}
          >
            {e[0]}<em>{e[1]}</em>
          </button>
        ))}
      </PopBox>
    );
  } else if (k === 'tabmodel') {
    const p = s.panes[s.pop.pane as number];
    const task = p && s.cache[p.threadId];
    const tab = task && (task.tabs || []).find((t) => t.id === (p.tabId || task.activeTab));
    box = (
      <PopBox width={310}>
        <div className="hd">Model for this tab</div>
        <ModelOptions selected={tab ? tab.model : ''} onSelect={(id) => { if (task && tab) setTabModel(task.id, tab.id, id); }} />
      </PopBox>
    );
  } else if (k === 'split') {
    box = (
      <PopBox width={410}>
        <SplitPicker paneIdx={s.pop.pane == null ? s.activePane : s.pop.pane} />
      </PopBox>
    );
  } else if (k === 'pullcontext') {
    box = (
      <PopBox width={330}>
        <ContextPullPicker paneIdx={s.pop.pane == null ? s.activePane : s.pop.pane} />
      </PopBox>
    );
  } else if (k === 'connectors') {
    const paneCtx = s.pop.pane != null ? s.panes[s.pop.pane] : null;
    const task = paneCtx && s.cache[paneCtx.threadId];
    box = <ConnectorsPop task={task || null} />;
  }

  if (k === 'panemenu' || k === 'projectmenu') {
    // Paper 13.1: the dots absorb what does not need to be on screen while
    // you work. 'projectmenu' is the shared header with several workstreams
    // open, where renaming one of them would be ambiguous.
    const pane = s.pop.pane == null ? s.activePane : s.pop.pane;
    const p = s.panes[pane];
    const task = p ? s.cache[p.threadId] : null;
    if (task) {
      const projectName = projectLabel(task.repo, task.repoName);
      box = (
        <PopBox width={240}>
          {k === 'panemenu' ? (
            <button className="it" onClick={() => { state.renaming = { kind: 'thread', id: task.id, paneIdx: pane }; state.pop = null; set(); }}>
              <Icon name="pencil" size={13} />Rename workstream
            </button>
          ) : null}
          <button className="it" onClick={() => { state.renaming = { kind: 'project', id: task.repo }; state.railOpen = true; state.pop = null; set(); }}>
            <Icon name="pencil" size={13} />Rename project<em>{projectName}</em>
          </button>
          <button className="it" onClick={() => { state.pop = null; set(); openShareDialog(task.repo); }}>
            <Icon name="user" size={13} />Share project<em>{projectName}</em>
          </button>
          <div style={{ height: 1, background: 'var(--line)', margin: '5px 0' }} />
          <button className="it" onClick={() => { state.pop = null; set(); void archiveProject(task.repo, true); }}>
            <Icon name="archive" size={13} />Archive project<em>{projectName}</em>
          </button>
        </PopBox>
      );
    }
  }
  if (k === 'composermore') {
    // Paper 13.2: whatever folded out of the composer lands here, in the same
    // order it left: Duel, Pull, New tab, Attach.
    const pane = s.pop.pane == null ? s.activePane : s.pop.pane;
    const p = s.panes[pane];
    const task = p ? s.cache[p.threadId] : null;
    const tab = task ? (task.tabs || []).find((t) => t.id === (p.tabId || task.activeTab)) || task.tabs?.[0] : null;
    if (task && tab) {
      const isDuel = tab.type === 'duel';
      const anchor = s.pop.anchor;
      box = (
        <PopBox width={240}>
          {!isDuel ? (
            <button className="it" onClick={() => { state.pop = null; set(); void createDuel(pane); }}>
              <Icon name="columns" size={13} />Duel<em>blind compare</em>
            </button>
          ) : null}
          {!isDuel && s.panes.length > 1 ? (
            <button className="it" onClick={() => openPopAt(anchor, 'pullcontext', pane)}>
              <Icon name="fileText" size={13} />Pull context<em>from another pane</em>
            </button>
          ) : null}
          <button className="it" onClick={() => { state.pop = null; set(); void newTab(task.id, tab.model || task.model || 'recommended', pane); }}>
            <Icon name="plus" size={13} />New tab<em>same context</em>
          </button>
          <button className="it" onClick={() => openPopAt(anchor, 'connectors', pane)}>
            <Icon name="paperclip" size={13} />Attach &amp; connectors
          </button>
        </PopBox>
      );
    }
  }
  if (k === 'tabsmore') {
    // Paper 13.3: tabs that no longer fit the strip, in their own order.
    const pane = s.pop.pane == null ? s.activePane : s.pop.pane;
    const p = s.panes[pane];
    const task = p ? s.cache[p.threadId] : null;
    const hidden = (state.tabOverflow[pane] || [])
      .map((id) => (task?.tabs || []).find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t);
    box = (
      <PopBox width={240}>
        <div className="hd">More tabs</div>
        {hidden.map((t) => {
          const running = t.status === 'running' || (t.type === 'duel' && duelPhase(t) !== 'picked');
          const dot = running ? 'var(--am)' : t.status === 'error' ? 'var(--err)' : t.status === 'done' ? 'var(--ok)' : 'var(--n400)';
          // Draggable like a visible tab: drag a row onto another tab or
          // pane to split directly. The pop goes transparent to drops while
          // the drag is live (closing it here would cancel the drag).
          return (
            <button
              className="it"
              key={t.id}
              draggable
              onDragStart={(e) => { if (task) tabDragStart(e, `${task.id}::${t.id}`); }}
              onDragEnd={() => { dragEnd(); closePop(); }}
              onClick={() => { state.pop = null; set(); selectTab(pane, t.id); }}
            >
              <u style={{ width: 7, height: 7, background: dot }} />{t.type === 'duel' ? 'Duel' : t.name}
            </button>
          );
        })}
      </PopBox>
    );
  }

  return (
    <>
      <div className="scrim" onClick={() => closePop()} />
      {box}
    </>
  );
}
