import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, newId } from './store.mjs';

const FILE = path.join(DATA_DIR, 'scheduled.json');
const HISTORY_KEPT = 80;
const ALLOWED_KEPT = 24;
// A fire this far behind its slot says so on its line (board 29.6, 02).
export const LATE_MS = 90_000;

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WALL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

function clock(value) {
  const match = TIME.exec(String(value || '').trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

// "2026-09-22T09:00" read as this Mac's own time, never as UTC.
export function wallDate(value) {
  const match = WALL.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

const pad = (n) => String(n).padStart(2, '0');

export function normalizeRepeat(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.kind || '');
  if (kind === 'hourly') {
    const minute = Number(input.minute);
    return { kind, minute: Number.isInteger(minute) && minute >= 0 && minute < 60 ? minute : 0 };
  }
  if (kind === 'daily' || kind === 'weekdays') {
    const at = clock(input.time);
    return at ? { kind, time: `${pad(at.hour)}:${pad(at.minute)}` } : null;
  }
  if (kind === 'weekly') {
    const at = clock(input.time);
    const weekday = Number(input.weekday);
    if (!at || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return { kind, weekday, time: `${pad(at.hour)}:${pad(at.minute)}` };
  }
  if (kind === 'once') {
    const date = wallDate(input.at);
    return date ? { kind, at: String(input.at).trim() } : null;
  }
  if (kind === 'reply') return { kind };
  return null;
}

// The first slot strictly after `after`, in local time. Days move with
// setDate so a daylight saving change keeps 9:00am at 9:00am.
export function nextOccurrence(repeat, after) {
  const from = after instanceof Date ? after : new Date(after);
  if (!repeat || !Number.isFinite(from.getTime())) return null;
  if (repeat.kind === 'reply') return null;
  if (repeat.kind === 'once') {
    const at = wallDate(repeat.at);
    return at && at.getTime() > from.getTime() ? at : null;
  }
  if (repeat.kind === 'hourly') {
    const slot = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), repeat.minute || 0, 0, 0);
    while (slot.getTime() <= from.getTime()) slot.setTime(slot.getTime() + 3_600_000);
    return slot;
  }
  const at = clock(repeat.time);
  if (!at) return null;
  const slot = new Date(from.getFullYear(), from.getMonth(), from.getDate(), at.hour, at.minute, 0, 0);
  for (let day = 0; day < 9; day += 1) {
    const weekday = slot.getDay();
    const fits = repeat.kind === 'daily'
      || (repeat.kind === 'weekdays' && weekday >= 1 && weekday <= 5)
      || (repeat.kind === 'weekly' && weekday === repeat.weekday);
    if (fits && slot.getTime() > from.getTime()) return slot;
    slot.setDate(slot.getDate() + 1);
    slot.setHours(at.hour, at.minute, 0, 0);
  }
  return null;
}

// What is owed at `now`: the most recent slot that has come due, and how
// many earlier ones went by unrun. Never a list to work through.
export function dueState(schedule, now = Date.now()) {
  if (!schedule?.enabled || !schedule.nextAt) return null;
  const first = Date.parse(schedule.nextAt);
  if (!Number.isFinite(first) || first > now) return null;
  let dueAt = first;
  let missed = 0;
  for (let guard = 0; guard < 20_000; guard += 1) {
    const next = nextOccurrence(schedule.repeat, new Date(dueAt));
    if (!next || next.getTime() > now) break;
    dueAt = next.getTime();
    missed += 1;
  }
  return { dueAt: new Date(dueAt).toISOString(), missed };
}

// Why a fire ran behind its slot, for the right end of its line.
export function lateReason({ dueAt, ranAt, bootAt, busy = false, gap = null }) {
  const due = Date.parse(dueAt);
  const ran = Date.parse(ranAt);
  if (!Number.isFinite(due) || !Number.isFinite(ran) || ran - due <= LATE_MS) return null;
  if (due < bootAt) return 'closed';
  if (busy) return 'busy';
  if (gap && gap.from <= due && due <= gap.to) return 'asleep';
  return null;
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  } catch {
    return [];
  }
}

function write(schedules) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schedules }, null, 2));
  fs.renameSync(tmp, FILE);
}

export function listSchedules() {
  return read();
}

export function getSchedule(id) {
  return read().find((schedule) => schedule.id === id) || null;
}

// Section 33: the On reply tasks that are switched on, oldest first.
export function replySchedules() {
  return read().filter((schedule) => schedule.enabled && schedule.repeat?.kind === 'reply');
}

function cleanText(value, limit) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, limit);
}

function cleanAllowed(row) {
  const app = cleanText(row?.app, 40).replace(/\s+/g, ' ');
  const action = cleanText(row?.action, 60).replace(/\s+/g, ' ');
  return app && action ? { app, action } : null;
}

const sameAllowed = (a, b) => a.app.toLowerCase() === b.app.toLowerCase() && a.action.toLowerCase() === b.action.toLowerCase();

export function createSchedule(input, now = Date.now()) {
  const name = cleanText(input?.name, 120);
  const instructions = cleanText(input?.instructions, 20_000);
  const repeat = normalizeRepeat(input?.repeat);
  const threadId = cleanText(input?.threadId, 80);
  const tabId = cleanText(input?.tabId, 80);
  if (!name) throw new Error('Give the task a name.');
  if (!instructions) throw new Error('Write what the tab should do.');
  if (!threadId || !tabId) throw new Error('Pick the tab that runs it.');
  if (!repeat) throw new Error('Pick when it repeats.');
  const next = nextOccurrence(repeat, new Date(now));
  if (!next && repeat.kind !== 'reply') throw new Error('That time has already passed.');
  const at = new Date(now).toISOString();
  const enabled = input?.enabled === undefined ? true : !!input.enabled;
  const schedule = { id: newId(), name, instructions, threadId, tabId, repeat, enabled, allowed: [], nextAt: next && enabled ? next.toISOString() : null, pending: null, history: [], createdAt: at, updatedAt: at };
  write([...read(), schedule]);
  return schedule;
}

export function updateSchedule(id, patch, now = Date.now()) {
  const schedules = read();
  const schedule = schedules.find((row) => row.id === id);
  if (!schedule) return null;
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, 120);
    if (!name) throw new Error('Give the task a name.');
    schedule.name = name;
  }
  if (patch.instructions !== undefined) {
    const instructions = cleanText(patch.instructions, 20_000);
    if (!instructions) throw new Error('Write what the tab should do.');
    schedule.instructions = instructions;
  }
  if (patch.threadId !== undefined || patch.tabId !== undefined) {
    const threadId = cleanText(patch.threadId ?? schedule.threadId, 80);
    const tabId = cleanText(patch.tabId ?? schedule.tabId, 80);
    if (!threadId || !tabId) throw new Error('Pick the tab that runs it.');
    schedule.threadId = threadId;
    schedule.tabId = tabId;
  }
  let rearm = false;
  if (patch.repeat !== undefined) {
    const repeat = normalizeRepeat(patch.repeat);
    if (!repeat) throw new Error('Pick when it repeats.');
    rearm = JSON.stringify(repeat) !== JSON.stringify(schedule.repeat);
    schedule.repeat = repeat;
  }
  if (patch.enabled !== undefined && !!patch.enabled !== !!schedule.enabled) {
    schedule.enabled = !!patch.enabled;
    rearm = true;
  }
  // Turning it on, or changing when, starts the clock from now: a pause is
  // not a row of misses to be told about later.
  if (rearm) {
    const next = schedule.enabled ? nextOccurrence(schedule.repeat, new Date(now)) : null;
    if (schedule.enabled && !next && schedule.repeat?.kind !== 'reply') {
      schedule.enabled = false;
      throw new Error('That time has already passed.');
    }
    schedule.nextAt = next ? next.toISOString() : null;
    schedule.pending = null;
  }
  schedule.updatedAt = new Date(now).toISOString();
  write(schedules);
  return schedule;
}

export function deleteSchedule(id) {
  const schedules = read();
  const kept = schedules.filter((row) => row.id !== id);
  if (kept.length === schedules.length) return false;
  write(kept);
  return true;
}

// A tab moved to another workstream gets a new id there; its tasks go with
// it, since a task belongs to the tab and not to where the tab sat.
export function retarget(from, to) {
  const schedules = read();
  let moved = 0;
  for (const schedule of schedules) {
    if (schedule.threadId !== from.threadId || schedule.tabId !== from.tabId) continue;
    schedule.threadId = to.threadId;
    schedule.tabId = to.tabId;
    moved += 1;
  }
  if (moved) write(schedules);
  return moved;
}

// The slot has come due: move the clock on before anything runs, so a run
// that takes Supreme down with it is not asked for again at every start.
// What is owed waits in `pending`, and a slot that comes due while it waits
// folds into it as one more not run.
export function takeDue(id, now = Date.now()) {
  const schedules = read();
  const schedule = schedules.find((row) => row.id === id);
  if (!schedule) return null;
  const due = dueState(schedule, now);
  if (due) {
    const waiting = schedule.pending;
    schedule.pending = waiting
      ? { dueAt: due.dueAt, missed: (waiting.missed || 0) + 1 + due.missed, busy: !!waiting.busy }
      : { dueAt: due.dueAt, missed: due.missed, busy: false };
    const next = nextOccurrence(schedule.repeat, new Date(now));
    schedule.nextAt = next ? next.toISOString() : null;
    // A one-off has had its turn.
    if (!next) schedule.enabled = false;
    write(schedules);
  }
  return schedule.pending ? { ...schedule.pending } : null;
}

export function markBusy(id) {
  const schedules = read();
  const schedule = schedules.find((row) => row.id === id);
  if (!schedule?.pending || schedule.pending.busy) return;
  schedule.pending.busy = true;
  write(schedules);
}

export function recordFire(id, fire, { clearPending = true } = {}) {
  const schedules = read();
  const schedule = schedules.find((row) => row.id === id);
  if (!schedule) return null;
  const row = {
    id: fire.id || newId(),
    dueAt: fire.dueAt,
    ranAt: fire.ranAt,
    ...(fire.missed ? { missed: fire.missed } : {}),
    ...(fire.reason ? { reason: fire.reason } : {}),
    ...(fire.manual ? { manual: true } : {}),
    ...(fire.error ? { error: cleanText(fire.error, 300) } : {}),
  };
  schedule.history = [row, ...(schedule.history || [])].slice(0, HISTORY_KEPT);
  if (clearPending) schedule.pending = null;
  if (fire.pause) { schedule.enabled = false; schedule.nextAt = null; }
  write(schedules);
  return row;
}

export function allow(id, input) {
  const row = cleanAllowed(input);
  if (!row) throw new Error('Name the app and what it may do.');
  const schedules = read();
  const schedule = schedules.find((candidate) => candidate.id === id);
  if (!schedule) return null;
  schedule.allowed = schedule.allowed || [];
  if (!schedule.allowed.some((existing) => sameAllowed(existing, row))) schedule.allowed = [...schedule.allowed, row].slice(-ALLOWED_KEPT);
  write(schedules);
  return schedule;
}

export function disallow(id, input) {
  const row = cleanAllowed(input);
  const schedules = read();
  const schedule = schedules.find((candidate) => candidate.id === id);
  if (!schedule || !row) return schedule || null;
  schedule.allowed = (schedule.allowed || []).filter((existing) => !sameAllowed(existing, row));
  write(schedules);
  return schedule;
}

// Board 29.7: nobody is watching, so the run does what the tab may already
// do, plus what this task's Always allowed list names, and anything else it
// stops and asks about. This rides the model's copy of the prompt only; the
// thread shows the instructions as they were written.
export function unattendedPreamble(schedule) {
  const allowed = (schedule?.allowed || []).map((row) => `${row.app}: ${row.action}`);
  return [
    `[Scheduled run of "${schedule?.name || 'a task'}". A schedule on the user's Mac started this turn; nobody typed it just now and nobody may be watching.`,
    'Work the way this tab normally may.',
    allowed.length ? `For this task the user has already allowed, without asking: ${allowed.join('; ')}.` : '',
    'For anything else you would normally check with the user first (sending, posting, deleting, paying, inviting, or any change outside this Mac that is hard to take back), do not do it and do not skip it quietly: stop there, say what is ready and what you would do next, and ask the user to confirm.',
    'When you stop to ask, make the very last line of your reply exactly this form, so the app can offer to allow it for next time: Needs: <App> · <the action in two or three words>]',
  ].filter(Boolean).join(' ');
}

// The model's closing "Needs: Gmail · Send email" line, lifted off the reply.
//
// Always allow writes a standing permission, and a sentence a model wrote is
// not a thing to write one from (board 29.8; the rule from section 17, that
// nothing is computed from the model's own report). So the line only picks
// from two closed lists: the app has to be one this Mac actually has, or one
// the turn itself touched, and the action has to be one of the connector
// rows' own verbs. What is kept is the list's spelling, never the model's.
// No match, no offer; the line still comes off the reply either way.
const ACTIONS = [
  ['Create draft', /^(?:(?:create|save|write|make|prepare)\s+)?(?:an?\s+|the\s+)?drafts?\b/],
  ['Send', /^(?:send|reply|respond|message|dm|email)\b/],
  ['Read', /^(?:read|view|open|check|get|fetch|list|look)\b/],
  ['Search', /^(?:search|find|query)\b/],
  ['Create', /^(?:create|add|make|new)\b/],
  ['Update', /^(?:update|edit|change|modify|move|label|tag)\b/],
  ['Schedule', /^(?:schedule|book|invite)\b/],
  ['Publish', /^(?:publish|post|share)\b/],
  ['Upload', /^(?:upload|attach)\b/],
  ['Delete', /^(?:delete|remove|archive|trash)\b/],
];
const appKey = (value) => String(value || '').replace(/^claude\.ai\s+/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchAllowed(needs, knownApps = []) {
  const wanted = appKey(needs?.app);
  if (!wanted) return null;
  const app = (knownApps || []).map((name) => String(name || '').replace(/^claude\.ai\s+/i, '').trim()).find((name) => name && appKey(name) === wanted);
  const said = String(needs?.action || '').trim().toLowerCase();
  const action = ACTIONS.find(([, words]) => words.test(said));
  return app && action ? { app, action: action[0] } : null;
}

const NEEDS = /\n?[ \t]*\**Needs:\**[ \t]*([^\n·|]{1,40}?)[ \t]*[·|][ \t]*([^\n]{1,60}?)[ \t]*\**[ \t]*$/i;
export function takeNeeds(content, knownApps = []) {
  const text = String(content || '').replace(/\s+$/, '');
  const match = NEEDS.exec(text);
  if (!match) return { content: String(content || ''), needs: null };
  const needs = matchAllowed({ app: match[1].replace(/[<>*_`]/g, ''), action: match[2].replace(/[<>*_`\]]/g, '') }, knownApps);
  return { content: text.slice(0, match.index).replace(/\s+$/, ''), needs };
}
