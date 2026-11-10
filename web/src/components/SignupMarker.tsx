import { useApp, state } from '../store';
import { decideSignupFork, streamKey } from '../actions';
import type { Task, Tab } from '../types';

// Paper 14.9: the thread Supreme started from what it read at sign up says so,
// once, at the top.
export function SignupMarker() {
  return <div className="signup-marker" aria-label="Started from what Supreme read at sign up"><span>Started from what Supreme read at sign up</span></div>;
}

// Paper 14.10: when that first task lands, one fork. Archive as one-off, or
// make repeatable. Nothing else is asked.
export function SignupFork({ task, tab }: { task: Task; tab: Tab }) {
  const s = useApp();
  if (task.origin !== 'signup' || task.signupFork) return null;
  const finished = (tab.messages || []).some((message) => message.role === 'assistant' && message.ok !== false && message.model);
  if (!finished || tab.activeRun || state.streams[streamKey(task.id, tab.id)]) return null;
  const busy = s.busy;
  return (
    <div className="signup-fork">
      <span>Want this again, or was it a one-off?</span>
      <button type="button" disabled={busy} onClick={() => void decideSignupFork(task.id, 'archived')}>Archive as one-off</button>
      <button type="button" className="strong" disabled={busy} onClick={() => void decideSignupFork(task.id, 'repeat')}>Make repeatable</button>
    </div>
  );
}
