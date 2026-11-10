import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons';
import { state, toolKind, toolLabel, useApp } from '../store';
import { setComputerPaused, stopTabRun, type TabRunRef } from '../actions';
import type {
  ComputerActivity,
  ConnectorAction,
  ConnectorActivity,
  OutsideTouch,
  OutsideTouchAction,
  ToolActivityKind,
  ToolEvent,
} from '../types';

type CardState = 'active' | 'paused' | 'attention' | 'done' | 'stopped' | 'error';
type TraceState = 'done' | 'now' | 'attention' | 'fail' | 'pending';
// Paper 16.6, the ending: the road finishes its lap, the ring lights green,
// then the card settles to a 1px green border and one result line.
type Landing = 'none' | 'lap' | 'lit' | 'settled';
// One lap of the road, in step with --motion-lap in the stylesheet.
const LAP_MS = 2_400;
const LAP_FINISH_MAX_MS = 600;
const RING_LIGHT_MS = 160;
const RING_HOLD_MS = 700;
const COLLAPSE_AFTER_MS = 900;

interface TraceRow {
  id: string;
  label: string;
  meta: string;
  state: TraceState;
}

interface RunCardProps {
  tools?: (string | ToolEvent)[];
  statusText?: string;
  error?: string | null;
  stopped?: boolean;
  computer?: ComputerActivity | null;
  connectors?: ConnectorActivity[];
  outsideTouches?: OutsideTouch[];
  runRef?: TabRunRef | null;
  // Full-turn wall clock: a persisted duration for completed cards, or the
  // turn's start time for live ones. Without them the card falls back to the
  // tool-activity window, which hides the model's thinking time.
  turnMs?: number | null;
  turnStartedAt?: string | null;
  // The turn ended waiting on the user (a question, an unsent draft). The
  // card still settles and collapses, but never lights green.
  waiting?: boolean;
}

const EMPTY_TOOLS: (string | ToolEvent)[] = [];
const EMPTY_CONNECTORS: ConnectorActivity[] = [];
const EMPTY_TOUCHES: OutsideTouch[] = [];

const ACTION_LABELS: Record<ConnectorAction, [string, string]> = {
  listen: ['Listening with', 'Pulled notes from'],
  read: ['Reading', 'Read'],
  search: ['Searching', 'Searched'],
  create: ['Creating in', 'Created in'],
  update: ['Updating', 'Updated'],
  draft: ['Drafting in', 'Drafted in'],
  send: ['Sending with', 'Sent with'],
  schedule: ['Scheduling with', 'Scheduled with'],
  connect: ['Connecting with', 'Connected with'],
  publish: ['Publishing with', 'Published with'],
  upload: ['Uploading to', 'Uploaded to'],
  delete: ['Removing from', 'Removed from'],
  use: ['Working with', 'Used'],
};

const TOUCH_LABELS: Record<OutsideTouchAction, string> = {
  create: 'Created in',
  update: 'Updated',
  draft: 'Drafted in',
  send: 'Sent with',
  schedule: 'Scheduled with',
  connect: 'Connected with',
  publish: 'Published with',
  upload: 'Uploaded to',
  delete: 'Removed from',
};

const TOUCH_OUTCOME_LABELS: Record<OutsideTouchAction, string> = {
  create: 'created',
  update: 'updated',
  draft: 'drafted',
  send: 'sent',
  schedule: 'scheduled',
  connect: 'connected',
  publish: 'published',
  upload: 'uploaded',
  delete: 'removed',
};

const MUTATING_ACTIONS = new Set<ConnectorAction>([
  'create', 'update', 'draft', 'send', 'schedule', 'connect', 'publish', 'upload', 'delete',
]);

function cardState({ runRef, error, stopped, computer, connectors = [], outsideTouches = [] }: RunCardProps): CardState {
  // A single connector call that failed or was cut short is a row in the
  // trace, not the card's verdict: the model usually recovers and the run
  // finishes. Only the run's own error or stop colours the card.
  if (error || computer?.state === 'error' || outsideTouches.some((item) => item.state === 'error')) return 'error';
  if (stopped || computer?.state === 'stopped' || outsideTouches.some((item) => item.state === 'stopped')) return 'stopped';
  if (computer?.state === 'paused') return 'paused';
  if (connectors.some((item) => item.state === 'error' || item.state === 'stopped')) return 'attention';
  if (runRef || computer?.state === 'active' || connectors.some((item) => item.state === 'active')) return 'active';
  return 'done';
}

function startedAt(computer: ComputerActivity | null | undefined, connectors: ConnectorActivity[]): string | undefined {
  const values = [computer?.startedAt, ...connectors.map((item) => item.startedAt)]
    .filter(Boolean)
    .map((value) => Date.parse(value!))
    .filter(Number.isFinite);
  return values.length ? new Date(Math.min(...values)).toISOString() : undefined;
}

function finishedAt(computer: ComputerActivity | null | undefined, connectors: ConnectorActivity[]): string | undefined {
  const values = [computer?.updatedAt, ...connectors.map((item) => item.updatedAt)]
    .filter(Boolean)
    .map((value) => Date.parse(value!))
    .filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : undefined;
}

function durationLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function elapsed(start: string | undefined, end: number): string {
  const parsed = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(parsed)) return '';
  return durationLabel(end - parsed);
}

function countLabel(count: number | null | undefined, unit: string | undefined): string {
  if (count == null) return '';
  const label = unit || 'result';
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function connectorTitle(activity: ConnectorActivity, state: CardState): string {
  if (/^linkedin(?: via chrome)?$/i.test(activity.connector)) {
    if (state === 'stopped') return 'Interrupted LinkedIn via Chrome';
    return `${state === 'active' || state === 'paused' ? 'Reading' : 'Read'} LinkedIn via Chrome`;
  }
  // "stopped responding" was wrong for a call that simply failed while the run
  // went on; the row keeps its verb and the meta says failed.
  if (state === 'stopped') return `Interrupted ${activity.connector}`;
  const labels = ACTION_LABELS[activity.action] || ACTION_LABELS.use;
  return `${state === 'active' || state === 'paused' ? labels[0] : labels[1]} ${activity.connector}`;
}

function touchTitle(touch: OutsideTouch): string {
  return `${TOUCH_LABELS[touch.action] || 'Updated'} ${touch.platform}`;
}

function cardCopy(
  stateName: CardState,
  computer: ComputerActivity | null | undefined,
  connectors: ConnectorActivity[],
  touches: OutsideTouch[],
  tools: string[],
  statusText: string,
  error: string,
  runActive: boolean,
): { headline: string; detail: string; icon: string } {
  if (computer) {
    const surface = computer.surface === 'Chrome' ? 'Chrome' : 'browser';
    const app = computer.app && computer.app.toLowerCase() !== surface.toLowerCase() ? computer.app : '';
    const browserName = computer.app === 'Edge' ? 'Edge' : computer.surface === 'Chrome' || computer.app === 'Chrome' ? 'Chrome' : 'Browser';
    const headline = stateName !== 'stopped' && computer.connection === 'unavailable' ? `${browserName} disconnected`
      : stateName === 'active' && computer.connection === 'recovering' ? `Reconnecting to ${browserName}`
      : stateName === 'paused' ? 'Computer control paused'
      : stateName === 'done' ? 'Computer control complete'
        : stateName === 'stopped' ? 'Computer control interrupted'
          : stateName === 'error' ? 'Computer control stopped'
            : 'Computer control';
    const step = stateName === 'paused'
      ? `${computer.currentStep || 'Waiting for you'}, nothing else will happen`
      : error || computer.currentStep || statusText || 'Working in the browser';
    const detail = [[surface, app].filter(Boolean).join(' · '), step].filter(Boolean).join(' · ');
    return { headline, detail, icon: 'columns' };
  }
  if (touches.length) {
    const platforms = [...new Set(touches.map((touch) => touch.platform))];
    const first = touches[0];
    const headline = stateName === 'error' ? 'External action stopped'
      : stateName === 'stopped' ? 'External action interrupted'
        : platforms.length > 1 ? `External actions across ${platforms.length} platforms`
          : `${platforms[0]} action`;
    const detail = error || [touchTitle(first), first.detail, first.outcome, countLabel(first.count, first.unit)].filter(Boolean).join(' · ') || platforms.join(', ');
    return { headline, detail, icon: platforms.length > 1 ? 'sparkles' : 'message' };
  }
  if (connectors.length) {
    const names = [...new Set(connectors.map((item) => item.connector))];
    const first = connectors.find((item) => item.state === 'active') || connectors[0];
    const issue = connectors.find((item) => item.state === 'error' || item.state === 'stopped');
    if (stateName === 'attention' && issue) {
      return {
        headline: runActive ? 'Working on it' : 'Completed with a connector hiccup',
        detail: runActive
          ? `${issue.connector} hit a snag · Supreme is continuing`
          : `${issue.connector} had trouble with one step`,
        icon: names.length > 1 ? 'sparkles' : 'message',
      };
    }
    const headline = stateName === 'error' ? 'Connector activity stopped'
      : stateName === 'stopped' ? 'Connector activity interrupted'
        : names.length > 1 ? `${names.length} connectors`
          : `${names[0]} connector`;
    const detail = error || [connectorTitle(first, stateName), first.detail, first.outcome].filter(Boolean).join(' · ') || statusText || 'Connected work';
    return { headline, detail, icon: names.length > 1 ? 'sparkles' : 'message' };
  }
  const headline = stateName === 'error' ? 'Tool activity stopped'
    : stateName === 'stopped' ? 'Tool activity interrupted'
      : stateName === 'done' ? 'Tool activity complete'
        : 'Tool activity';
  const detail = error || tools[tools.length - 1] || statusText || 'Working with a tool';
  return { headline, detail, icon: 'wrench' };
}

function traceRows(
  stateName: CardState,
  computer: ComputerActivity | null | undefined,
  connectors: ConnectorActivity[],
  touches: OutsideTouch[],
  tools: string[],
  error: string,
  runActive: boolean,
): TraceRow[] {
  if (computer?.steps?.length) {
    const visible = computer.steps.slice(-4);
    return visible.map((step, index) => {
      const last = index === visible.length - 1;
      const traceState: TraceState = last && stateName === 'error' ? 'fail'
        : last && stateName === 'active' ? 'now'
          : last && stateName === 'stopped' ? 'pending'
            : 'done';
      return { id: `${step.at || index}:${step.step}`, label: step.step, meta: traceState === 'now' ? 'now' : traceState === 'fail' ? 'failed' : traceState === 'pending' ? 'held' : 'done', state: traceState };
    });
  }
  if (connectors.length) {
    // One row per distinct thing done, like the computer-control steps: the
    // verb plus what it searched for or read. Identical consecutive calls
    // collapse into one row with a count instead of five identical lines.
    const groups: Array<{ id: string; label: string; state: ConnectorActivity['state']; repeats: number; count: number | null; unit: string }> = [];
    for (const activity of connectors) {
      const cardStateFor: CardState = activity.state === 'active' ? 'active' : activity.state === 'stopped' ? 'stopped' : 'done';
      const base = connectorTitle(activity, cardStateFor);
      const detail = (activity.detail || '').trim();
      const label = detail ? `${base} · ${detail.length > 64 ? `${detail.slice(0, 63)}…` : detail}` : base;
      const last = groups[groups.length - 1];
      if (last && last.label === label && last.state === activity.state && activity.state !== 'active') {
        last.repeats += 1;
        if (last.count != null && activity.count != null && last.unit === (activity.unit || '')) last.count += activity.count;
        else last.count = null;
      } else {
        groups.push({ id: activity.id, label, state: activity.state, repeats: 1, count: activity.count ?? null, unit: activity.unit || '' });
      }
    }
    return groups.slice(-5).map((group) => {
      const times = group.repeats > 1 ? `×${group.repeats}` : '';
      const meta = group.state === 'active' ? 'now'
        : group.state === 'error' || group.state === 'stopped'
          ? [times, runActive ? 'working on it' : 'needs attention'].filter(Boolean).join(' · ')
            : [times, countLabel(group.count, group.unit)].filter(Boolean).join(' · ') || 'done';
      return {
        id: group.id,
        label: group.label,
        meta,
        state: group.state === 'active' ? 'now' : group.state === 'error' || group.state === 'stopped' ? 'attention' : 'done',
      };
    });
  }
  if (touches.length) {
    return touches.slice(-5).map((touch) => ({
      id: touch.id,
      label: touchTitle(touch),
      meta: countLabel(touch.count, touch.unit) || touch.outcome || (touch.state === 'error' ? 'failed' : touch.state === 'stopped' ? 'stopped' : 'done'),
      state: touch.state === 'error' ? 'fail' : touch.state === 'stopped' ? 'pending' : 'done',
    }));
  }
  const visibleTools = tools.slice(-4);
  const rows = visibleTools.map((tool, index) => {
    const last = index === visibleTools.length - 1;
    const rowState: TraceState = last && stateName === 'error' ? 'fail' : last && stateName === 'active' ? 'now' : 'done';
    return { id: `${index}:${tool}`, label: tool, meta: rowState === 'now' ? 'now' : rowState === 'fail' ? 'failed' : 'done', state: rowState };
  });
  if (!rows.length && error) rows.push({ id: 'error', label: error, meta: 'failed', state: 'fail' });
  return rows;
}

function toolIcon(kind: ToolActivityKind | 'outside', label: string): string {
  if (kind === 'computer') return 'columns';
  if (kind === 'outside') return 'message';
  if (kind === 'research') return 'sparkles';
  if (kind === 'context' || kind === 'work') return 'fileText';
  const value = label.toLowerCase();
  if (value.includes('gmail') || value.includes('slack') || value.includes('message')) return 'message';
  if (value.includes('notion') || value.includes('drive') || value.includes('read') || value.includes('file')) return 'fileText';
  return 'wrench';
}

function runToolLabel(item: string | ToolEvent): string {
  return toolLabel(item);
}

function TraceMark({ state: rowState }: { state: TraceState }) {
  return (
    <span className="run-trace-mark">
      {rowState === 'done' ? <Icon name="check" size={9} />
        : rowState === 'attention' ? <Icon name="ellipsis" size={9} />
          : rowState === 'fail' ? <Icon name="x" size={9} /> : null}
    </span>
  );
}

export function hasRunActivity({
  tools = EMPTY_TOOLS,
  computer,
  connectors = EMPTY_CONNECTORS,
  outsideTouches = EMPTY_TOUCHES,
}: Pick<RunCardProps, 'tools' | 'computer' | 'connectors' | 'outsideTouches'>): boolean {
  return !!(tools.length || computer || connectors.length || outsideTouches.length);
}

export function RunError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="run-inline-error" role="alert">
      <Icon name="x" size={11} />
      <span>{message}</span>
    </div>
  );
}

export function RunCard({
  tools: rawTools = EMPTY_TOOLS, statusText = '', error = '', stopped = false,
  computer, connectors = EMPTY_CONNECTORS, outsideTouches = EMPTY_TOUCHES, runRef = null,
  turnMs = null, turnStartedAt = null, waiting = false,
}: RunCardProps) {
  const toolActivities = useMemo(() => {
    const byType = new Map<string, { label: string; kind: ToolActivityKind }>();
    for (const item of rawTools) {
      const label = runToolLabel(item);
      const kind = toolKind(item);
      if (label) byType.set(`${kind}:${label}`, { label, kind });
    }
    return [...byType.values()];
  }, [rawTools]);
  const tools = toolActivities.map((activity) => activity.label);
  const stateName = cardState({ runRef, error, stopped, computer, connectors, outsideTouches });
  const hasEvidence = hasRunActivity({ tools, computer, connectors, outsideTouches });
  // Finished cards open behind the caret; the steps stay there.
  const [open, setOpen] = useState(stateName === 'active' || stateName === 'paused' || stateName === 'attention');
  // Paper 16.6: the ending. When the last step lands the road finishes the
  // lap it is on (up to 600ms), the whole ring lights green at once over
  // 160ms and holds 700ms, drops to a 1px green border, and 900ms later the
  // card collapses to one result line. Nothing to accept, nothing to dismiss.
  // A card that was already finished when it drew starts settled and still.
  const cardRef = useRef<HTMLElement>(null);
  const [landing, setLanding] = useState<Landing>(stateName === 'done' ? 'settled' : 'none');
  const lastState = useRef<CardState>(stateName);
  const drivingRef = useRef(false);
  const motion = useApp().motion;
  useEffect(() => {
    const was = lastState.current;
    lastState.current = stateName;
    if (stateName !== 'done') {
      if (landing !== 'none') setLanding('none');
      return undefined;
    }
    if (was === 'done' || landing !== 'none') return undefined;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setLanding('settled');
      setOpen(false);
      return undefined;
    }
    const el = cardRef.current;
    let lapMs = 0;
    if (motion.road && el) {
      lapMs = LAP_FINISH_MAX_MS;
      const angle = parseFloat(getComputedStyle(el, '::before').getPropertyValue('--road-a'));
      if (Number.isFinite(angle)) {
        const from = ((angle % 360) + 360) % 360;
        lapMs = Math.min(LAP_FINISH_MAX_MS, Math.round(((360 - from) / 360) * LAP_MS));
        el.style.setProperty('--road-from', `${from}deg`);
      }
      el.style.setProperty('--lap-ms', `${lapMs}ms`);
      setLanding('lap');
    }
    // Green means finished with nothing waiting, so a turn that ended asking
    // skips the lit ring and settles neutral.
    const lit = motion.road && !waiting;
    const timers = [
      window.setTimeout(() => setLanding(lit ? 'lit' : 'settled'), lapMs),
      window.setTimeout(() => setLanding('settled'), lapMs + RING_LIGHT_MS + RING_HOLD_MS),
      window.setTimeout(() => setOpen(false), lapMs + RING_LIGHT_MS + RING_HOLD_MS + COLLAPSE_AFTER_MS),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [stateName]);
  // Paper 16 A: the lit road runs the card border while the card is active;
  // iridescent only while Supreme is driving the user's Chrome, and it keeps
  // that colour through the lap it finishes.
  if (stateName === 'active') drivingRef.current = computer?.state === 'active';
  const driving = stateName === 'active' ? computer?.state === 'active' : (landing === 'lap' || landing === 'lit') && drivingRef.current;
  const road = motion.road ? ` road${driving ? ' driving' : ''}` : '';
  const settled = stateName === 'done' && landing === 'settled';
  const [peek, setPeek] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = !!runRef || stateName === 'active' || stateName === 'paused';
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => setPreviewError(false), [computer?.previewSeq, computer?.runId]);

  if (!hasEvidence) return null;
  const copy = cardCopy(stateName, computer, connectors, outsideTouches, tools, statusText, error || '', !!runRef);
  const trace = traceRows(stateName, computer, connectors, outsideTouches, tools, error || '', !!runRef);
  const start = startedAt(computer, connectors);
  const end = live ? now : Date.parse(finishedAt(computer, connectors) || '') || now;
  // Prefer full-turn timing so the card matches what the user actually waited.
  const duration = turnMs != null
    ? durationLabel(turnMs)
    : (live && turnStartedAt ? elapsed(turnStartedAt, now) : '') || elapsed(start, end);
  const canPeek = !!computer?.hasPreview && !!computer.runId && !previewError;
  const paused = stateName === 'paused';
  const canPause = !!runRef && !!computer && (stateName === 'active' || paused);
  const stopping = !!(runRef && state.stoppingRuns[runRef.key]);
  const screenUrl = computer ? `/api/runs/${encodeURIComponent(computer.runId)}/computer/screen?v=${computer.previewSeq || 0}` : '';
  const pillCandidates: { label: string; kind: ToolActivityKind | 'outside' }[] = [
    ...(computer ? [{ label: 'Computer control', kind: 'computer' as const }] : []),
    ...connectors.map((item) => ({
      label: /^linkedin(?: via chrome)?$/i.test(item.connector)
        ? 'LinkedIn via Chrome'
        : item.connector === 'Connected tool' ? item.connector : `${item.connector} connector`,
      kind: 'connector' as const,
    })),
    ...outsideTouches.map((item) => ({ label: `${item.platform} output`, kind: 'outside' as const })),
    ...toolActivities,
  ];
  const pills = [...new Map(pillCandidates.filter((pill) => pill.label).map((pill) => [`${pill.kind}:${pill.label}`, pill])).values()].slice(0, 6);
  const touchedOutside = connectors.some((item) => MUTATING_ACTIONS.has(item.action));
  const mutating = live && touchedOutside;
  const openTouch = outsideTouches.find((touch) => touch.url) || connectors.find((item) => item.url);
  const openTouchLabel = openTouch ? ('platform' in openTouch ? openTouch.platform : openTouch.connector) : '';
  const outcomeByAction = outsideTouches.reduce((totals, touch) => {
    if (touch.count) totals.set(touch.action, (totals.get(touch.action) || 0) + touch.count);
    return totals;
  }, new Map<OutsideTouchAction, number>());
  const outcomeLabel = [...outcomeByAction]
    .map(([action, count]) => `${count} ${TOUCH_OUTCOME_LABELS[action]}`)
    .join(' · ');

  const togglePause = async () => {
    if (!runRef || !computer || busy) return;
    setBusy(true);
    await setComputerPaused(runRef, !paused);
    setBusy(false);
  };

  // The single result line a settled card collapses to: what happened, how
  // long it took, and what went out (or that nothing did).
  const resultTail = outcomeLabel || (touchedOutside ? 'nothing sent' : '');

  return (
    <section
      ref={cardRef}
      className={`run-card ${stateName} ${open ? 'open' : ''} ${peek ? 'peeking' : ''}${road}${landing !== 'none' ? ` ${landing}` : ''}${waiting ? ' neutral' : ''}`}
      aria-label="Run activity"
    >
      <button className="run-card-head" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`run-state-dot ${stateName}`} />
        <span className="run-type-icon"><Icon name={copy.icon} size={15} /></span>
        {settled ? (
          <span className="run-card-copy result">
            <b>{copy.headline}</b>
            {duration ? <><i>·</i><time>{duration}</time></> : null}
            {resultTail ? <><i>·</i><small>{resultTail}</small></> : null}
          </span>
        ) : (
          <>
            <span className="run-card-copy"><b>{copy.headline}</b><small>{copy.detail}</small></span>
            {duration ? <time>{duration}</time> : null}
          </>
        )}
        <span className="run-card-caret"><Icon name="chevronDown" size={14} /></span>
      </button>
      <div className="run-card-body"><div>
        {trace.length ? (
          <div className="run-trace">
            {trace.map((row) => (
              <div className={`run-trace-row ${row.state}`} key={row.id}>
                <TraceMark state={row.state} /><span>{row.label}</span><em>{row.meta}</em>
              </div>
            ))}
          </div>
        ) : null}
      </div></div>
      {computer ? (
        <div className="run-peek"><div>
          {peek && canPeek ? (
            <div className="run-peek-inner">
              <div className="run-screen"><img src={screenUrl} alt={`Latest ${computer.app} screen from this run`} onError={() => setPreviewError(true)} /></div>
              <span>Latest screen, updates after each browser step<br />Every click is logged, using your own session</span>
            </div>
          ) : null}
        </div></div>
      ) : null}
      {(pills.length || runRef || canPeek || canPause || openTouch || mutating || outcomeLabel) ? (
        <footer className="run-card-footer">
          {pills.map((pill) => <span className={`run-tool-pill ${pill.kind}`} key={`${pill.kind}:${pill.label}`}><Icon name={toolIcon(pill.kind, pill.label)} size={11} />{pill.label}</span>)}
          <span className="run-card-actions">
            {mutating ? <span className="run-outcome">nothing sent yet</span> : null}
            {!mutating && outcomeLabel ? <span className="run-outcome">{outcomeLabel}</span> : null}
            {canPeek ? (
              <button className="strong run-peek-cta" type="button" aria-pressed={peek} onClick={() => setPeek((value) => !value)}>
                <Icon name="columns" size={12} />{peek ? 'Hide the screen' : 'Peek at the screen'}
              </button>
            ) : null}
            {canPause && paused ? <button className="strong" type="button" disabled={busy} onClick={togglePause}>{busy ? 'Updating…' : 'Give it back'}</button> : null}
            {openTouch?.url ? <a className="strong" href={openTouch.url} target="_blank" rel="noreferrer">Open in {openTouchLabel}</a> : null}
            {runRef ? (
              <button
                type="button"
                className="run-interrupt"
                disabled={stopping}
                aria-keyshortcuts="Escape"
                onClick={() => stopTabRun(runRef.threadId, runRef.tabId)}
              >
                {stopping ? 'Interrupting…' : <><kbd>Esc</kbd><span>to interrupt</span></>}
              </button>
            ) : null}
          </span>
        </footer>
      ) : null}
    </section>
  );
}
