import { markTabDone } from './DoneTray';
import type { Tab, Task } from '../types';

// Paper 20.2, current boards: the in-thread hairline is a prompt, not
// chrome — it appears once the tab has been quiet about six hours and says
// so. The always-available gesture lives in the pane header (DoneControl);
// this is the nudge for a tab that looks finished.
function quietLabel(since: string): string {
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return '';
  const hour = at.getHours() % 12 || 12;
  const minutes = at.getMinutes();
  const half = at.getHours() < 12 ? 'am' : 'pm';
  const clock = minutes ? `${hour}:${String(minutes).padStart(2, '0')}${half}` : `${hour}${half}`;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? clock : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

export function DoneMark({ task, tab, paneIdx, quietSince }: { task: Task; tab: Tab; paneIdx: number; quietSince?: string }) {
  if (tab.done) {
    return <div className="done-mark settled" aria-label="Marked done"><span className="done-ring filled" /><span>Done</span><i /></div>;
  }
  const since = quietSince ? quietLabel(quietSince) : '';
  return (
    <button type="button" className="done-mark" onClick={() => markTabDone(task, tab, paneIdx)}>
      <span className="done-ring" /><span>Done with this</span>
      {since ? <small className="done-quiet">quiet since {since}</small> : null}
      <i />
    </button>
  );
}
