import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { captureAnalytics } from '../analytics';

const VISIBLE_PHASES = new Set(['ready', 'waiting', 'installing']);

export function DesktopUpdateNotice() {
  const desktop = window.conductorDesktop;
  const [status, setStatus] = useState<SupremeDesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState<'now' | 'idle' | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [waitingExpanded, setWaitingExpanded] = useState(false);
  const seenReadyVersion = useRef<string | null>(null);

  useEffect(() => {
    const bridge = window.conductorDesktop;
    if (!bridge) return undefined;
    let mounted = true;
    const receive = (next: SupremeDesktopUpdateStatus | null) => {
      if (!mounted || !next) return;
      setStatus(next);
      const readyVersion = next.availableVersion || null;
      if (next.phase === 'ready' && readyVersion && seenReadyVersion.current !== readyVersion) {
        seenReadyVersion.current = readyVersion;
        captureAnalytics('desktop_update_ready', { available_version: readyVersion });
      }
    };
    void bridge.getUpdateStatus().then(receive).catch(() => {});
    const unsubscribe = bridge.onUpdateStatus(receive);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!desktop || !status || !VISIBLE_PHASES.has(status.phase)) return null;

  const waiting = status.phase === 'waiting';
  const installing = status.phase === 'installing';
  const version = status.availableVersion || status.currentVersion;
  const dismissed = dismissedVersion === version;
  const showCard = installing || (!dismissed && (!waiting || waitingExpanded));
  let detail = 'Takes about a minute.';
  if (installing) {
    detail = 'Restarting Supreme to finish the update…';
  } else if (status.reason === 'agents-active' && status.activeRuns && status.activeRuns > 0) {
    detail = `${status.activeRuns} agent${status.activeRuns === 1 ? ' is' : 's are'} still working. Supreme updates the moment they finish.`;
  } else if (status.reason === 'service-unavailable') {
    detail = 'Supreme cannot confirm that every agent is idle yet.';
  }

  const act = async (mode: 'now' | 'idle') => {
    captureAnalytics(mode === 'now' ? 'desktop_update_now_selected' : 'desktop_update_after_runs_selected', {
      available_version: version,
      active_run_count: status.activeRuns || 0,
    });
    setBusy(mode);
    try {
      const next = await desktop.installUpdate(mode);
      if (next) setStatus(next);
      if (next?.phase === 'waiting') setWaitingExpanded(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {waiting ? (
        <button
          type="button"
          className="desktop-update-waiting"
          aria-label={`Supreme ${version} update waiting`}
          aria-expanded={waitingExpanded}
          onClick={() => {
            setDismissedVersion(null);
            setWaitingExpanded(true);
          }}
        >
          Update waiting
        </button>
      ) : null}
      {showCard ? (
        <aside className="desktop-update-card" role="status" aria-live="polite">
          <div className="desktop-update-head">
            <div className="desktop-update-mark"><Icon name="download" size={15} /></div>
            <div className="desktop-update-copy">
              <b>{installing ? 'Updating Supreme' : 'An update is ready'}</b>
              <p>{detail}</p>
            </div>
            {!installing ? (
              <button
                type="button"
                className="desktop-update-close"
                aria-label="Dismiss update notice"
                onClick={() => {
                  captureAnalytics('desktop_update_notice_dismissed', { available_version: version });
                  if (waiting) setWaitingExpanded(false);
                  else setDismissedVersion(version);
                }}
              >
                <Icon name="x" size={13} />
              </button>
            ) : null}
          </div>
          {!installing ? (
            <div className="desktop-update-actions">
              <button type="button" className="desktop-update-primary" disabled={busy !== null} onClick={() => act('idle')}>
                {busy === 'idle' ? 'Scheduling…' : 'Update after agents finish'}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => act('now')}>
                {busy === 'now' ? 'Checking agents…' : 'Update now'}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}
