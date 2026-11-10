import { useEffect, useRef, useState } from 'react';
import { useApp, state, set, projectLabel, paneTabKey } from '../store';
import { Icon } from '../icons';
import { landedPlace } from '../lib/landed';
import { LandedHeader } from './LandedHeader';
import { RenameInput } from './RenameInput';
import { TabsRow } from './TabsRow';
import { DoneCount, DoneNow } from './DoneTray';
import { Conversation } from './Conversation';
import { DecidedDuelView, DuelView } from './Duel';
import { ContextPanel } from './ContextPanel';
import { NetworkPanel } from './NetworkPanel';
import { ContextHandle } from './ContextHandle';
import { CloudHandoffControl } from './CloudHandoffControl';
import { closePane, streamKey, openShareDialog, openScheduled, navigate } from '../actions';
import { repeatChip } from '../lib/scheduled';
import { contextTargetDrop, contextTargetLeave, contextTargetOver } from '../lib/dnd';
import { openPop, toggleRail } from '../lib/ui';
import { tabAsleep } from '../lib/vitality';
import { PlayPanel } from './PlayPanel';
import { togglePlayPanel } from '../actions';
import type { Pane as PaneT } from '../types';

// Ported from vanilla pane(). Header (or shared-project variant), tabs row, and a
// body that is the context drawer, a Duel, or the conversation.
// A pane whose thread has not been read yet says so; the loaded pane mounts
// once the thread is here. Two components, so the loaded pane's hooks never
// follow a render that had none (a pane keeps its identity across a click,
// and the same instance going from Loading… to loaded broke React's hook
// order, 2026-09-07).
export function Pane(props: { p: PaneT; idx: number; sharedProject: boolean; sharedThread: boolean }) {
  const s = useApp();
  const task = s.cache[props.p.threadId];
  if (!task) {
    return <div className="pane" data-pane-index={props.idx}><div className="paneh"><span className="ttl" style={{ flex: 1 }}>Loading…</span></div></div>;
  }
  return <PaneLoaded {...props} />;
}

function PaneLoaded({ p, idx, sharedProject, sharedThread }: { p: PaneT; idx: number; sharedProject: boolean; sharedThread: boolean }) {
  const s = useApp();
  const task = s.cache[p.threadId];
  if (!task) return null;
  const projectName = projectLabel(task.repo, task.repoName);
  const tabs = task.tabs || [];
  const tabId = p.tabId || task.activeTab || (tabs[0] && tabs[0].id);
  // Paper 20.6: a peeked archived tab resolves from archivedTabs — present
  // while you look, gone when you switch away.
  const peekedTab = s.peeks[task.id] && s.peeks[task.id] === tabId
    ? (task.archivedTabs || []).find((t) => t.id === tabId) || null
    : null;
  const tab = tabs.find((t) => t.id === tabId) || peekedTab || tabs[0];
  // The peeked tab came back to life (restored from the rail, by a teammate,
  // by the cloud copy): the peek is over, the tab is simply open.
  const stalePeek = !!s.peeks[task.id] && tabs.some((t) => t.id === s.peeks[task.id]);
  useEffect(() => {
    if (!stalePeek) return;
    delete state.peeks[task.id];
    set();
  }, [stalePeek, task.id]);
  // Paper 16 B: weather on the ground. The pane's own paper carries a slow
  // wash while its tab works, holds still while it waits on you, and a
  // ripple crosses on each tool call or step.
  const stream = tab ? s.streams[streamKey(task.id, tab.id)] : null;
  const working = !!(stream || tab?.activeRun);
  const holding = stream?.computer?.state === 'paused';
  const events = (stream?.computer?.steps?.length || 0) + (stream?.tools?.length || 0) + (stream?.connectors?.length || 0);
  const seenEvents = useRef(events);
  const [rippling, setRippling] = useState(false);
  useEffect(() => {
    if (events > seenEvents.current && working) {
      setRippling(false);
      const raise = requestAnimationFrame(() => setRippling(true));
      const timer = setTimeout(() => setRippling(false), 750);
      seenEvents.current = events;
      return () => { cancelAnimationFrame(raise); clearTimeout(timer); };
    }
    seenEvents.current = events;
    return undefined;
  }, [events, working]);
  const ground = s.motion.ground && working ? ` working${holding ? ' hold' : ''}${rippling ? ' ripple' : ''}` : '';
  // Paper 16.10: a pane untouched for over a day dims its chrome, never its
  // content or the one action still waiting on the user. Opening it wakes it.
  const asleep = !!tab && !working && tabAsleep(task, tab);
  // Paper 17: the play panel hangs off the pane; ⚡ goes green when a Find a
  // Play result landed while it was closed.
  // Keyed by the tab in this pane, not the pane slot, so a run's panel only
  // shows on the tab it was opened for and comes back with that tab.
  const playPanelState = s.playPanels[paneTabKey(idx)];
  const playPanelOn = !!playPanelState?.open;
  const playLanded = !!playPanelState?.landed && !playPanelOn;
  const showClose = s.panes.length > 1;
  const editingThread = !!(s.renaming && s.renaming.kind === 'thread' && s.renaming.id === task.id
    && (s.renaming.paneIdx == null || s.renaming.paneIdx === idx));
  const contextOn = !!s.contextOpen[idx];
  const review = s.duelReview?.paneIdx === idx && s.duelReview.threadId === task.id ? s.duelReview : null;
  const decidedDuel = review && tab?.id === review.sourceTabId
    ? (tab.duels || []).find((duel) => duel.duelId === review.duelId)
    : null;

  const threadTitle = editingThread ? (
    <RenameInput className="reninp pane-thread-input" value={task.title} ariaLabel="Workstream name" />
  ) : (
    <button
      className="pane-thread"
      title="Double-click to rename workstream"
      onDoubleClick={() => { state.renaming = { kind: 'thread', id: task.id, paneIdx: idx }; set(); }}
    >
      {task.title}
    </button>
  );
  // Paper 19.1: Share up top, for the project this workstream is in.
  const share = (
    <button className="pane-archive pane-share" title="Share this project" data-share-project onClick={() => openShareDialog(task.repo)}>
      <Icon name="user" size={13} /><span>Share</span>
    </button>
  );
  const contextToggle = tab ? <ContextHandle taskId={task.id} tabId={tab.id} paneIdx={idx} on={contextOn} /> : null;
  const findToggle = tab && tab.type !== 'duel' && !tab.duel?.choice && !contextOn ? <button type="button" className="tgl" title="Search this conversation, /" aria-label="Search this conversation" onClick={() => { state.activePane = idx; state.tabSearch = { key: `${task.id}::${tab.id}`, query: '', selected: 0 }; set(); }}><Icon name="search" size={13} /></button> : null;
  const closeBtn = showClose ? (
    <button className="pane-close" title="Close pane" onClick={() => closePane(idx)}><Icon name="x" size={14} /></button>
  ) : null;
  const dots = (
    <button className="tgl pane-dots" title="More" aria-label="More actions" onClick={(event) => openPop(event.currentTarget, 'panemenu', idx)}>
      <Icon name="ellipsis" size={15} />
    </button>
  );
  const railToggle = (
    <button className="tgl" title={s.railOpen ? 'Close sidebar' : 'Open sidebar'} onClick={() => toggleRail()}>
      <Icon name="panelLeft" size={15} />
    </button>
  );
  const splitToggle = (
    <button className="tgl" title="Split view" onClick={(event) => openPop(event.currentTarget, 'split', idx)}>
      <Icon name="columns" size={14} />
    </button>
  );

  const body = decidedDuel && tab ? <DecidedDuelView tab={tab} duel={decidedDuel} idx={idx} />
    : contextOn ? <ContextPanel task={task} idx={idx} />
      : (tab && (tab.type === 'duel' || tab.duel?.choice)) ? <DuelView task={task} tab={tab} idx={idx} />
      : tab ? <Conversation task={task} tab={tab} idx={idx} />
        : <div className="empty"><div className="ttl">No tabs</div></div>;
  const networkOn = !!tab && tab.type === 'orchestrator' && !contextOn && !decidedDuel;

  // Board 20.3: the done control sits far right, immediately before the
  // split toggle. Archive left the top bar — it lives on the rail's
  // right-click menu now.
  // Board 20.7: the header keeps only the count; Done itself lives in the
  // strip so each pane's button names the tab that pane is showing.
  const doneCount = <DoneCount task={task} paneIdx={idx} />;
  const doneNow = <DoneNow task={task} tab={tab || null} paneIdx={idx} />;
  // Section 29, board 29.5: a tab that a scheduled task runs in says so once,
  // at the right of its header, and the chip opens the task. Paused tasks
  // say nothing here.
  const tabSchedules = tab ? s.schedules.filter((row) => row.enabled && row.threadId === task.id && row.tabId === tab.id) : [];
  const scheduleChip = tabSchedules.length ? (
    <button
      type="button"
      className="sched-tab-chip"
      data-sched-tab-chip
      title={tabSchedules.map((row) => row.name).join(', ')}
      onClick={() => openScheduled(tabSchedules.length === 1 ? tabSchedules[0].id : null)}
    >
      <Icon name={tabSchedules[0].repeat.kind === 'reply' ? 'mail' : 'clock'} size={11} />{repeatChip(tabSchedules[0].repeat)}{tabSchedules.length > 1 ? ` +${tabSchedules.length - 1}` : ''}
    </button>
  ) : null;
  const paneHeader = sharedProject ? null : (
    <div className="paneh">
      {railToggle}{s.slackReturnThread === task.id ? <button type="button" className="pane-project slack-return" aria-label="Back to Slack" onClick={() => navigate('slack')}><Icon name="arrowLeft" size={13} />Slack</button> : <span className="pane-project">{projectName}</span>}<span className="pane-sep">/</span>{threadTitle}<i />
      {scheduleChip}<CloudHandoffControl task={task} />{share}{dots}{doneCount}{splitToggle}{closeBtn}
    </div>
  );
  const threadLead = sharedProject && !sharedThread
    ? (editingThread
      ? <span className="tab-thread">{threadTitle}</span>
      : (
        <span
          className="tab-strip-name"
          title={`${task.title} · double-click to rename`}
          onDoubleClick={() => { state.renaming = { kind: 'thread', id: task.id, paneIdx: idx }; set(); }}
        >
          {task.title}
        </span>
      ))
    : null;
  // Strip order (board 20.7): tabs, +, spacer, lightning, Context, Done —
  // Done last because it is what you do when you are finished with
  // everything to its left.
  const sharedControls = sharedProject ? (
    <>
      {contextToggle}{findToggle}{doneNow}{closeBtn}
    </>
  ) : (
    <>
      {contextToggle}{findToggle}{doneNow}
    </>
  );

  // Section 30, boards 30.6 and 30.7: in Landed the tab sits on a card on a
  // stage. The header says Landed and nothing else; the card's head is the
  // workstream and the tab with the tab's own Context and Done; the thread
  // and composer are the tab's own. The next row peeks out behind it. The
  // card is keyed by the row, so each row is a fresh card to fly off.
  if (s.view === 'landed') {
    const place = landedPlace();
    return (
      <div className="pane landed-pane" data-pane-index={idx} onPointerDown={() => { state.activePane = idx; }}>
        <LandedHeader />
        <div className="landed-stage">
          <div className="landed-deck">
            {place.next ? <div key={`peek:${s.landedCurrent}`} className="landed-peek" data-landed-peek aria-hidden /> : null}
            <div key={s.landedCurrent || 'none'} className={`landed-card${ground}`} data-landed-card>
              <span className="landed-stamp" aria-hidden><Icon name="check" size={34} /></span>
              <div className="landed-card-head" data-landed-card-head>
                <span className="lc-ws">{task.title}</span><span className="lc-sep">/</span><span className="lc-tab" data-landed-card-tab>{tab?.name}</span><i />
                {contextToggle}{doneNow}
              </div>
              <div className="pane-split"><div className="pane-main">{body}</div></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`pane${ground}${asleep ? ' asleep' : ''}`}
      data-pane-index={idx}
      onPointerDown={() => { state.activePane = idx; }}
      onDragOver={contextTargetOver}
      onDragLeave={contextTargetLeave}
      onDrop={(event) => contextTargetDrop(event, idx)}
    >
      {paneHeader}
      <div className="tabs">
        {threadLead}
        <TabsRow task={task} activeTab={tab} idx={idx} />
        {sharedProject ? scheduleChip : null}
        {tab && tab.type !== 'duel' ? (
          <button
            type="button"
            className={`play-toggle${playPanelOn ? ' on' : ''}${playLanded ? ' landed' : ''}`}
            title={playLanded ? 'Your play is ready' : 'Find a Play'}
            aria-label="Find a Play"
            aria-pressed={playPanelOn}
            onClick={() => void togglePlayPanel(idx)}
          >
            <Icon name="zap" size={13} />
          </button>
        ) : null}
        {sharedControls}
      </div>
      {/* The wrapper is always there so opening or closing the play panel
          never remounts the conversation (a remount lands it at the top). */}
      {/* Section 27: an orchestrator tab keeps its Network panel beside the
          conversation, the same slot the play panel takes. */}
      <div className={`pane-split${playPanelOn || networkOn ? ' with-panel' : ''}`}>
        <div className="pane-main">{body}</div>
        {playPanelOn ? <PlayPanel panelKey={paneTabKey(idx)} paneIdx={idx} modelId={tab?.model} /> : networkOn && tab ? <NetworkPanel task={task} tab={tab} /> : null}
      </div>
    </div>
  );
}
