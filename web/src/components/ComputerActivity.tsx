import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { setComputerPaused, type TabRunRef } from '../actions';
import type { ComputerActivity as Activity } from '../types';

function elapsed(startedAt?: string, now = Date.now()): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function clock(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function titleFor(activity: Activity): string {
  if (activity.state === 'paused') return `Paused, your ${activity.surface === 'Chrome' ? 'Chrome' : 'browser'} is yours`;
  if (activity.state === 'released') return `${activity.surface === 'Chrome' ? 'Chrome' : 'Browser'} handed back`;
  if (activity.state === 'done') return 'Computer work complete';
  if (activity.state === 'stopped') return 'Computer work interrupted';
  if (activity.state === 'error') return 'Computer work interrupted';
  return `Controlling your ${activity.surface === 'Chrome' ? 'Chrome' : 'browser'}, ${activity.app}`;
}

function detailFor(activity: Activity): string {
  if (activity.state === 'paused') {
    const previous = [...(activity.steps || [])].reverse().find((step) => step.phase !== 'paused');
    return `${previous?.step || activity.currentStep} · nothing else will happen`;
  }
  if (activity.state === 'released') return `${activity.app} session released · no further browser control`;
  return activity.currentStep || 'Working in the browser';
}

export function ComputerActivity({ activity, runRef = null }: { activity?: Activity | null; runRef?: TabRunRef | null }) {
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const live = activity?.state === 'active' || activity?.state === 'paused';
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => setPreviewError(false), [activity?.previewSeq, activity?.runId]);

  if (!activity) return null;
  const paused = activity.state === 'paused';
  const canPause = !!runRef && (activity.state === 'active' || paused);
  const canPeek = !!activity.hasPreview && !!activity.runId && !previewError;
  const visibleSteps = (activity.steps || []).slice(-4);
  const earlier = Math.max(0, (activity.steps || []).length - visibleSteps.length);
  const screenUrl = `/api/runs/${encodeURIComponent(activity.runId)}/computer/screen?v=${activity.previewSeq || 0}`;

  const togglePause = async () => {
    if (!runRef || busy) return;
    setBusy(true);
    await setComputerPaused(runRef, !paused);
    setBusy(false);
  };

  return (
    <section className={`computer-activity ${activity.state}`} aria-label="Computer use activity">
      <button className="computer-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="computer-pulse"><i /></span>
        <span className="computer-copy">
          <b>{titleFor(activity)}</b>
          <small>{detailFor(activity)}</small>
        </span>
        <time>{elapsed(activity.startedAt, now)}</time>
        <span className={`computer-caret ${open ? 'open' : ''}`}><Icon name="chevronDown" size={13} /></span>
      </button>
      {open ? (
        <div className="computer-detail">
          <div className="computer-ledger">
            {earlier ? <div className="computer-earlier">{earlier} earlier {earlier === 1 ? 'step' : 'steps'}</div> : null}
            {visibleSteps.map((entry, index) => {
              const current = index === visibleSteps.length - 1;
              return (
                <div className={`computer-step ${current ? 'current' : ''}`} key={`${entry.at || index}:${entry.step}`}>
                  <time>{current && live ? 'now' : clock(entry.at)}</time>
                  <span>{current ? <i /> : '✓'}</span>
                  <b>{entry.step}</b>
                </div>
              );
            })}
          </div>
          {peek && canPeek ? (
            <div className="computer-screen">
              <img src={screenUrl} alt={`Latest ${activity.app} screen from this run`} onError={() => setPreviewError(true)} />
              <span>Latest screen · updates after each browser step</span>
            </div>
          ) : null}
          <div className="computer-actions">
            {canPeek ? <button onClick={() => setPeek((value) => !value)}>{peek ? 'Hide the screen' : 'Peek at the screen'}</button> : null}
            {canPause ? <button disabled={busy} onClick={togglePause}>{busy ? 'Updating…' : paused ? 'Resume' : 'Pause'}</button> : null}
          </div>
          <footer>every click logged <i /> using your session</footer>
        </div>
      ) : null}
    </section>
  );
}
