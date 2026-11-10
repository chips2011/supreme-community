import { useApp } from '../store';
import { Icon } from '../icons';
import { bringThreadBack, keepThreadInCloud } from '../actions';
import type { Task } from '../types';

// Paper 13.1: three words instead of five, the sentence lives on hover.
export function CloudHandoffControl({ task }: { task: Task }) {
  const s = useApp();
  if (!s.status?.cloudWorker?.configured) return null;
  const busy = !!s.cloudHandoffBusy[task.id];
  if (task.cloudHandoff?.machineId) {
    const stopped = task.cloudHandoff.state === 'stopped';
    const failed = task.cloudHandoff.state === 'return-failed';
    return (
      <div className="cloud-handoff active" title="This thread keeps running even when this Mac sleeps">
        <span><Icon name="cloud" size={12} /> <b>{failed ? 'Cloud return needs attention' : stopped ? 'Cloud work is ready' : 'Running in the cloud'}</b></span>
        <button disabled={busy || failed} onClick={() => void bringThreadBack(task.id)}>
          {busy ? 'Bringing back…' : stopped ? 'Bring changes back' : 'Bring back to this Mac'}
        </button>
      </div>
    );
  }
  return (
    <button className="cloud-handoff-button" disabled={busy} title="Keeps going when you shut the laptop" onClick={() => void keepThreadInCloud(task.id)}>
      <Icon name="cloud" size={13} /><b>{busy ? 'Starting…' : 'Run in cloud'}</b>
    </button>
  );
}
