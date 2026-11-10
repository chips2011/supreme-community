import { memo, useEffect, useState, type CSSProperties } from 'react';
import type { ConnectorActivity } from '../types';

const CONNECTOR_COLORS: Record<string, string> = {
  Granola: '#2f9b64',
  Notion: '#18181b',
  Gmail: '#d94b40',
  'Google Drive': '#2878d0',
  'Google Calendar': '#3578e5',
  Slack: '#7c3f8c',
  PostHog: '#e98023',
  Clay: '#111827',
  Vercel: '#18181b',
  Circleback: '#5b67d7',
  Descript: '#6d57d9',
};

const ACTION_LABELS: Record<ConnectorActivity['action'], [string, string]> = {
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

const EMPTY_CONNECTOR_ACTIVITIES: ConnectorActivity[] = [];
const MUTATING_ACTIONS = new Set<ConnectorActivity['action']>(['create', 'update', 'draft', 'send', 'schedule', 'connect', 'publish', 'upload', 'delete']);

function groupedActivities(activities: ConnectorActivity[]): ConnectorActivity[] {
  const visible = activities.filter((activity) => activity.state !== 'done' || !MUTATING_ACTIONS.has(activity.action));
  const groups = new Map<string, ConnectorActivity & { actionSet: Set<ConnectorActivity['action']> }>();
  for (const activity of visible) {
    const key = activity.connector.toLowerCase();
    const prior = groups.get(key);
    if (!prior) {
      groups.set(key, { ...activity, id: `platform:${key}`, actionSet: new Set([activity.action]) });
      continue;
    }
    prior.actionSet.add(activity.action);
    const activeAction = activity.state === 'active' ? activity.action : null;
    if (activeAction) prior.action = activeAction;
    else if (prior.state !== 'active' && prior.actionSet.size > 1) prior.action = 'use';
    if (activity.state === 'active') prior.state = 'active';
    else if (prior.state !== 'active' && activity.state === 'error') prior.state = 'error';
    else if (!['active', 'error'].includes(prior.state) && activity.state === 'stopped') prior.state = 'stopped';
    const details = [...new Set([prior.detail, activity.detail].filter(Boolean))];
    const accounts = [...new Set([prior.account, activity.account].filter(Boolean))];
    prior.detail = details.slice(0, 2).join(' · ');
    prior.account = accounts.slice(0, 2).join(' · ');
    if (prior.unit && activity.unit && prior.unit === activity.unit && activity.count != null) {
      prior.count = Math.max(prior.count || 0, activity.count);
    } else if (prior.unit !== activity.unit) {
      prior.count = null;
      prior.unit = '';
    }
    prior.startedAt = prior.startedAt && activity.startedAt
      ? new Date(prior.startedAt) <= new Date(activity.startedAt) ? prior.startedAt : activity.startedAt
      : prior.startedAt || activity.startedAt;
    prior.updatedAt = activity.updatedAt || prior.updatedAt;
  }
  return [...groups.values()].map(({ actionSet: _actionSet, ...activity }) => activity);
}

function elapsed(startedAt?: string, now = Date.now()): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function title(activity: ConnectorActivity): string {
  if (activity.state === 'error') return `Couldn't finish in ${activity.connector}`;
  if (activity.state === 'stopped') return `Interrupted ${activity.connector}`;
  const labels = ACTION_LABELS[activity.action] || ACTION_LABELS.use;
  return `${activity.state === 'active' ? labels[0] : labels[1]} ${activity.connector}`;
}

function metric(activity: ConnectorActivity, now: number): string {
  if (activity.state === 'active') return elapsed(activity.startedAt, now);
  if (activity.state === 'error') return 'Needs attention';
  if (activity.state === 'stopped') return 'Interrupted';
  if (activity.count == null) return 'Done';
  if (activity.unit === 'minute') return `${activity.count}m`;
  if (activity.unit === 'second') return `${activity.count}s`;
  const unit = activity.unit || 'result';
  return `${activity.count} ${unit}${activity.count === 1 ? '' : 's'}`;
}

function StateMark({ state }: { state: ConnectorActivity['state'] }) {
  if (state === 'active') return <span className="connector-live-dot" aria-label="Connector is active" />;
  if (state === 'done') return <span className="connector-check" aria-label="Connector action complete">✓</span>;
  return <span className="connector-state-dot" aria-hidden="true" />;
}

function ConnectorMoment({ activity, now }: { activity: ConnectorActivity; now: number }) {
  const meta = [activity.detail, activity.account].filter((value, index, values) => value && values.indexOf(value) === index);
  const color = CONNECTOR_COLORS[activity.connector] || '#52525b';
  const mark = activity.connector === 'Connected tool' ? '↗' : activity.connector.charAt(0).toUpperCase();
  return (
    <div
      className={`connector-moment ${activity.state}`}
      style={{ '--connector-color': color } as CSSProperties}
      role={activity.state === 'active' ? 'status' : undefined}
      aria-live={activity.state === 'active' ? 'polite' : undefined}
    >
      <span className="connector-mark" aria-hidden="true">{mark}</span>
      <span className="connector-copy">
        <b>{title(activity)}</b>
        {meta.length ? <small>· {meta.join(' · ')}</small> : null}
      </span>
      <i className="connector-rule" />
      <span className="connector-metric">{metric(activity, now)}</span>
      <StateMark state={activity.state} />
    </div>
  );
}

function ConnectorMomentsView({ activities }: { activities?: ConnectorActivity[] | null }) {
  const items = groupedActivities(activities || EMPTY_CONNECTOR_ACTIVITIES);
  const active = items.some((activity) => activity.state === 'active');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!items.length) return null;
  return (
    <div className="connector-moments" aria-label="Connector activity">
      {items.map((activity) => <ConnectorMoment key={activity.id} activity={activity} now={now} />)}
    </div>
  );
}

// Token deltas do not change the connector array, so keep the timeline rows
// isolated from the high-frequency stream render.
export const ConnectorMoments = memo(ConnectorMomentsView);
