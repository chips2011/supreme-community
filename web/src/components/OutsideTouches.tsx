import { memo, type CSSProperties } from 'react';
import type { OutsideTouch, OutsideTouchAction } from '../types';

const EMPTY_TOUCHES: OutsideTouch[] = [];
const BRAND: Record<string, { color: string; mark: string }> = {
  Gmail: { color: '#d94b40', mark: 'M' },
  LinkedIn: { color: '#0a66c2', mark: 'in' },
  Notion: { color: '#18181b', mark: 'N' },
  Smartlead: { color: '#635bff', mark: 'S' },
  'Google Calendar': { color: '#3578e5', mark: '31' },
  'Google Drive': { color: '#2878d0', mark: 'D' },
  'Google Docs': { color: '#4285f4', mark: 'D' },
  'Google Sheets': { color: '#188038', mark: 'S' },
  Slack: { color: '#7c3f8c', mark: 'S' },
};

const ACTION_VERBS: Record<OutsideTouchAction, string> = {
  create: 'Created',
  update: 'Updated',
  draft: 'Drafted',
  send: 'Sent',
  schedule: 'Scheduled',
  connect: 'Sent',
  publish: 'Published',
  upload: 'Uploaded',
  delete: 'Removed',
};

interface PlatformGroup {
  platform: string;
  state: OutsideTouch['state'];
  effects: OutsideTouch[];
  url?: string;
}

function pluralUnit(unit: string, count: number): string {
  if (count === 1) return unit;
  if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

function effectTitle(effect: OutsideTouch): string {
  const verb = ACTION_VERBS[effect.action] || 'Updated';
  const defaultUnit: Record<OutsideTouchAction, string> = {
    create: 'item', update: 'item', draft: 'draft', send: 'message', schedule: 'event',
    connect: 'connection request', publish: 'post', upload: 'file', delete: 'item',
  };
  const unit = effect.unit || defaultUnit[effect.action];
  if (effect.count != null) return `${verb} ${effect.count} ${pluralUnit(unit, effect.count)}`;
  const fallback: Record<OutsideTouchAction, string> = {
    create: 'Created an item', update: 'Updated records', draft: 'Created a draft', send: 'Sent a message',
    schedule: 'Scheduled an event', connect: 'Sent a connection request', publish: 'Published a post',
    upload: 'Uploaded a file', delete: 'Removed an item',
  };
  return fallback[effect.action];
}

function groupByPlatform(touches: OutsideTouch[]): PlatformGroup[] {
  const groups = new Map<string, PlatformGroup>();
  for (const touch of touches) {
    const key = touch.platform.toLowerCase();
    const prior = groups.get(key);
    if (!prior) {
      groups.set(key, { platform: touch.platform, state: touch.state, effects: [touch], url: touch.url });
      continue;
    }
    prior.effects.push(touch);
    prior.url = prior.url || touch.url;
    if (touch.state === 'error') prior.state = 'error';
    else if (prior.state !== 'error' && touch.state === 'stopped') prior.state = 'stopped';
  }
  return [...groups.values()];
}

function groupTitle(group: PlatformGroup): string {
  const titles = group.effects.map(effectTitle);
  if (titles.length <= 2) return titles.join(' · ');
  return `${titles.slice(0, 2).join(' · ')} · +${titles.length - 2} more`;
}

function groupMeta(group: PlatformGroup): string {
  const hasSent = group.effects.some((effect) => effect.action === 'send' || effect.action === 'connect');
  const accounts = [...new Set(group.effects.map((effect) => effect.account).filter(Boolean))];
  const results = [...new Set(group.effects.flatMap((effect) => {
    const outcome = effect.outcome && !(hasSent && effect.action === 'draft' && effect.outcome === 'nothing sent')
      ? effect.outcome
      : '';
    if (effect.detail && outcome) return [`${effect.detail} → ${outcome}`];
    return [effect.detail, outcome].filter(Boolean) as string[];
  }))];
  return [group.platform, ...accounts, ...results].join(' · ');
}

function PlatformTouch({ group }: { group: PlatformGroup }) {
  const brand = BRAND[group.platform] || { color: '#52525b', mark: group.platform.charAt(0).toUpperCase() };
  const contents = (
    <>
      <span className="outside-touch-mark" aria-hidden="true">{brand.mark}</span>
      <span className="outside-touch-copy">
        <b>{groupTitle(group)}</b>
        <small>{groupMeta(group)}</small>
      </span>
      {group.url ? <span className="outside-touch-open" aria-hidden="true">↗</span> : null}
      <span className="outside-touch-state" aria-label={group.state === 'done' ? 'Complete' : group.state === 'error' ? 'Needs attention' : 'Interrupted'}>
        {group.state === 'done' ? '✓' : group.state === 'error' ? '!' : '–'}
      </span>
    </>
  );
  const style = { '--touch-color': brand.color } as CSSProperties;
  return group.url ? (
    <a className={`outside-touch ${group.state}`} style={style} href={group.url} target="_blank" rel="noreferrer" aria-label={`Open ${group.platform}`}>
      {contents}
    </a>
  ) : <div className={`outside-touch ${group.state}`} style={style}>{contents}</div>;
}

function OutsideTouchesView({ touches }: { touches?: OutsideTouch[] | null }) {
  const groups = groupByPlatform(touches || EMPTY_TOUCHES);
  if (!groups.length) return null;
  return (
    <section className="outside-touches ph-no-capture" aria-label="Outside touches">
      <header>Outside touches</header>
      {groups.map((group) => <PlatformTouch key={group.platform.toLowerCase()} group={group} />)}
    </section>
  );
}

// Completed output receipts do not need to participate in token-stream renders.
export const OutsideTouches = memo(OutsideTouchesView);
