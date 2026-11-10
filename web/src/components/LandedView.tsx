// Section 30, Landed: the page is the tab, unchanged. One pane on the row
// on screen; the three controls it adds sit in the pane header (Pane.tsx).
// Empty is one line, no subtext (board 30.5).
import { useEffect } from 'react';
import { useApp } from '../store';
import { landedMoveOn } from '../actions';
import { Pane } from './Pane';
import { LandedHeader } from './LandedHeader';

export function LandedView() {
  const s = useApp();
  const pane = s.landedCurrent ? s.panes[0] : null;
  // The row, not the pane's tab: Done moves the pane onto the next live
  // tab of the workstream, and it is the row's tab that was shelved.
  const [rowThread, rowTab] = (s.landedCurrent || '').split(':');
  const task = rowThread ? s.cache[rowThread] : null;
  const shown = task ? (task.tabs || []).find((tab) => tab.id === rowTab) : null;
  const slack = task?.origin === 'slack' || s.threads.find(thread => thread.id === rowThread)?.origin === 'slack';
  const shelved = slack || !!(task && (task.archived || (shown && shown.done) || (!shown && (task.archivedTabs || []).some((tab) => tab.id === rowTab))));
  useEffect(() => { if (shelved) landedMoveOn(); }, [shelved]);
  if (!pane || slack) return <div className="pane landed-pane" data-landed><LandedHeader /><div className="landed-empty" data-landed-empty>Nothing has landed since you were last here.</div></div>;
  return (
    <div className="pane-stage" data-landed>
      <div className="panes">
        <div className="panes-track" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <Pane p={pane} idx={0} sharedProject={false} sharedThread={false} />
        </div>
      </div>
    </div>
  );
}
