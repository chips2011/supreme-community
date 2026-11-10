// Section 29, scheduled tasks by tab: how a time is said. Local wall time
// everywhere, the way a person would say it, and never a cron string. The
// page says "9:00am"; the History list says "9:00 AM", which is how the page
// this one copies writes a past fire (board 29.3).
import type { Schedule, ScheduleHistoryRow, ScheduleLateReason, ScheduleRepeat, ScheduledFire } from '../types';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "9:00am"
export function clockLabel(date: Date): string {
  const hour = date.getHours();
  return `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
}

// "9:00 AM"
function historyClock(date: Date): string {
  const hour = date.getHours();
  return `${hour % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function timeOfDay(value: string): string {
  const [hour, minute] = value.split(':').map(Number);
  return clockLabel(new Date(2000, 0, 1, hour || 0, minute || 0));
}

function wall(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) : null;
}

// "Mon 22 Sep"
export function dayLabel(date: Date): string {
  return `${SHORT_DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

function daysApart(date: Date, now: Date): number {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

export function repeatLabel(repeat: ScheduleRepeat): string {
  if (repeat.kind === 'reply') return 'On reply';
  if (repeat.kind === 'hourly') return repeat.minute ? `Hourly at :${String(repeat.minute).padStart(2, '0')}` : 'Hourly';
  if (repeat.kind === 'daily') return `Daily at ${timeOfDay(repeat.time)}`;
  if (repeat.kind === 'weekdays') return `Weekdays at ${timeOfDay(repeat.time)}`;
  if (repeat.kind === 'weekly') return `${WEEKDAYS[repeat.weekday]}s at ${timeOfDay(repeat.time)}`;
  const at = wall(repeat.at);
  return at ? `Once, ${dayLabel(at)} at ${clockLabel(at)}` : 'Once';
}

// The tab header's chip: "Daily 9:00am".
export function repeatChip(repeat: ScheduleRepeat): string {
  if (repeat.kind === 'reply') return 'On reply';
  if (repeat.kind === 'hourly') return 'Hourly';
  if (repeat.kind === 'daily') return `Daily ${timeOfDay(repeat.time)}`;
  if (repeat.kind === 'weekdays') return `Weekdays ${timeOfDay(repeat.time)}`;
  if (repeat.kind === 'weekly') return `${SHORT_DAYS[repeat.weekday]} ${timeOfDay(repeat.time)}`;
  const at = wall(repeat.at);
  return at ? `${dayLabel(at)} ${clockLabel(at)}` : 'Once';
}

// The card's chip: "in 21 hours", then the day once it is further out.
export function nextRunChip(nextAt: string | null, now = Date.now()): string {
  const at = Date.parse(nextAt || '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return 'in a moment';
  if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return dayLabel(new Date(at));
}

// The one line beside the toggle.
export function stateLine(schedule: Schedule, now = Date.now()): string {
  if (schedule.running) return 'Running now';
  if (!schedule.enabled) {
    if (schedule.repeat.kind === 'once' && schedule.history.length) return 'Off, it has run';
    return 'Paused';
  }
  const at = Date.parse(schedule.nextAt || '');
  if (!Number.isFinite(at)) return 'On';
  const date = new Date(at);
  const apart = daysApart(date, new Date(now));
  const day = apart === 0 ? 'today' : apart === 1 ? 'tomorrow' : dayLabel(date);
  return `On, next run ${day} at ${clockLabel(date)}`;
}

// A History row: "Today at 9:00 AM", "Fri 19 Sep at 9:00 AM".
export function historyLabel(row: ScheduleHistoryRow, now = Date.now()): string {
  const date = new Date(row.manual ? row.ranAt : row.dueAt);
  const apart = daysApart(date, new Date(now));
  const day = apart === 0 ? 'Today' : apart === -1 ? 'Yesterday' : dayLabel(date);
  return `${day} at ${historyClock(date)}`;
}

// The right end of a History row, in the mono face: a late fire says when it
// ran, a by-hand one says so, and one that did not start says that.
export function historyNote(row: ScheduleHistoryRow): string {
  if (row.error) return 'did not run';
  if (row.manual) return 'run by hand';
  const late = Date.parse(row.ranAt) - Date.parse(row.dueAt) > 90_000;
  if (late) return `ran ${historyClock(new Date(row.ranAt))}`;
  return row.missed ? `${row.missed} not run` : '';
}

const REASONS: Record<ScheduleLateReason, string> = {
  closed: 'Supreme was closed',
  busy: 'The tab was busy',
  asleep: 'The Mac was asleep',
};

function spokenDay(date: Date, now: Date): string {
  const apart = daysApart(date, now);
  if (apart === 0) return 'today';
  if (apart === -1) return 'yesterday';
  if (apart < 0 && apart > -7) return WEEKDAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// The line over a scheduled turn (board 29.6): "Sent today, 9:00am" when it
// ran on its slot, "Due 9:00am, ran 11:42am" with why when it ran late, and
// "Ran once, 8:06am" with the count when slots went by unrun.
export function fireLine(fire: ScheduledFire, now = Date.now()): { label: string; note: string } {
  const ran = new Date(fire.ranAt);
  const due = new Date(fire.dueAt);
  const today = new Date(now);
  const day = spokenDay(ran, today);
  const ranDay = day === 'today' ? '' : ` ${day}`;
  if (fire.missed) return { label: `Ran once${ranDay}, ${clockLabel(ran)}`, note: `${fire.missed} not run` };
  const late = !fire.manual && ran.getTime() - due.getTime() > 90_000;
  if (late) return { label: `Due ${clockLabel(due)}, ran${ranDay} ${clockLabel(ran)}`, note: fire.reason ? REASONS[fire.reason] : '' };
  return { label: `Sent ${day}, ${clockLabel(fire.manual ? ran : due)}`, note: '' };
}

// The small square before an app's name in Always allowed: its initial, the
// way the board draws Gmail's M and LinkedIn's in.
export function appMark(app: string): string {
  const name = app.trim();
  if (/^linkedin$/i.test(name)) return 'in';
  return (name[0] || '?').toUpperCase();
}
