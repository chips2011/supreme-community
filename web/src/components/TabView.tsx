import { Fragment } from 'react';
import { useApp, state, set, projectLabel } from '../store';
import { Icon } from '../icons';
import { RenameInput } from './RenameInput';
import { Pane } from './Pane';
import { PaneResizer } from './PaneResizer';
import { DiffPanel } from './DiffPanel';
import { DoneCount } from './DoneTray';
import { openPop, toggleRail } from '../lib/ui';
import { openShareDialog, navigate } from '../actions';
import { CloudHandoffControl } from './CloudHandoffControl';
import { projectZoneOver, projectZoneLeave, projectZoneDrop } from '../lib/dnd';
import { paneGridTemplate, paneTrackMinWidth, paneWeight } from '../lib/panes';
import type { Pane as PaneT, Task } from '../types';

const paneKeys = new WeakMap<PaneT, string>();
let paneKeySequence = 0;

function paneKey(pane: PaneT): string {
  let key = paneKeys.get(pane);
  if (!key) {
    paneKeySequence += 1;
    key = `pane-${paneKeySequence}`;
    paneKeys.set(pane, key);
  }
  return key;
}

// One bar for the window (Paper 13.5): it names the active pane's workstream
// and carries that workstream's actions, so the strips below stay light.
function SharedPaneHeader({ task, paneIdx }: { task: Task; paneIdx: number }) {
  const s = useApp();
  const projectName = projectLabel(task.repo, task.repoName);
  const railToggle = (
    <button className="tgl" title={s.railOpen ? 'Close sidebar' : 'Open sidebar'} onClick={() => toggleRail()}>
      <Icon name="panelLeft" size={15} />
    </button>
  );
  const splitToggle = (
    <button className="tgl" title="Split view" onClick={(event) => openPop(event.currentTarget, 'split', s.activePane)}>
      <Icon name="columns" size={14} />
    </button>
  );
  const dots = (
    <button className="tgl pane-dots" title="More" aria-label="More actions" onClick={(event) => openPop(event.currentTarget, 'panemenu', paneIdx)}>
      <Icon name="ellipsis" size={15} />
    </button>
  );
  const editing = !!(s.renaming && s.renaming.kind === 'thread' && s.renaming.id === task.id
    && (s.renaming.paneIdx == null || s.renaming.paneIdx === paneIdx));
  return (
    <div className="paneh paneh-shared">
      {railToggle}{s.slackReturnThread === task.id ? <button type="button" className="pane-project slack-return" aria-label="Back to Slack" onClick={() => navigate('slack')}><Icon name="arrowLeft" size={13} />Slack</button> : <span className="pane-project">{projectName}</span>}<span className="pane-sep">/</span>
      {editing ? (
        <RenameInput className="reninp pane-thread-input" value={task.title} ariaLabel="Workstream name" />
      ) : (
        <button
          className="pane-thread"
          title="Double-click to rename workstream"
          onDoubleClick={() => { state.renaming = { kind: 'thread', id: task.id, paneIdx }; set(); }}
        >
          {task.title}
        </button>
      )}
      <i />
      <CloudHandoffControl task={task} />
      <button className="pane-archive pane-share" title="Share this project" data-share-project onClick={() => openShareDialog(task.repo)}>
        <Icon name="user" size={13} /><span>Share</span>
      </button>
      {dots}
      {/* Board 20.7: the header keeps only the count — a check and a
          number. Done itself lives in each pane's strip. */}
      <DoneCount task={task} paneIdx={paneIdx} />
      {splitToggle}
    </div>
  );
}

// Ported from vanilla tabView().
export function TabView() {
  const s = useApp();
  if (!s.panes.length) return null;
  const paneTasks = s.panes.map((p) => s.cache[p.threadId]);
  const paneWeights = s.panes.map((pane) => paneWeight(pane));
  const sharedProject = s.panes.length > 1 && paneTasks.every(Boolean)
    && paneTasks.every((task) => task.repo === paneTasks[0].repo);
  const sharedThread = sharedProject && paneTasks.every((task) => task.id === paneTasks[0].id);
  const activeIdx = Math.min(Math.max(0, s.activePane), s.panes.length - 1);

  return (
    <>
      <div className="pane-stage">
        {sharedProject ? <SharedPaneHeader task={paneTasks[activeIdx] || paneTasks[0]} paneIdx={activeIdx} /> : null}
        <div className={`panes ${sharedProject ? 'shared-project' : ''}`}>
          <div
            className="panes-track"
            style={{
              gridTemplateColumns: paneGridTemplate(paneWeights),
              minWidth: paneTrackMinWidth(s.panes.length),
            }}
          >
            {s.panes.map((p, i) => (
              <Fragment key={paneKey(p)}>
                <Pane p={p} idx={i} sharedProject={sharedProject} sharedThread={sharedThread} />
                {i < s.panes.length - 1 ? <PaneResizer leftIdx={i} weights={paneWeights} /> : null}
              </Fragment>
            ))}
          </div>
          <div className="dropz" onDragOver={projectZoneOver} onDragLeave={projectZoneLeave} onDrop={projectZoneDrop}>
            <span><Icon name="columns" size={18} /></span>
            <b>Open beside this pane</b>
            <small>Drop a project or workstream</small>
          </div>
        </div>
      </div>
      <DiffPanel />
    </>
  );
}
