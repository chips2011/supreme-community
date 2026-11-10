import { set } from '../store';
import type { Message } from '../types';

// How much a tab opens with, how much one ask brings back, and the point
// under which a row would hide too little to be worth having.
export const OPENS_WITH = 30;
export const BRINGS_BACK = 60;
const NOT_WORTH_A_ROW = 12;

const shown = (message: Message) => !message.hiddenInTranscript;

// Where the drawn transcript starts so that at least `want` messages show.
// It moves back to the message that started that turn, so a thread never
// opens on an answer with its question cut off above it.
export function startFor(messages: Message[], want: number): number {
  let at = messages.length;
  for (let seen = 0; at > 0 && seen < want;) {
    at -= 1;
    if (shown(messages[at])) seen += 1;
  }
  for (let back = at, steps = 0; back >= 0 && steps < 12; back -= 1, steps += 1) {
    if (messages[back]?.role === 'user' && shown(messages[back])) { at = back; break; }
  }
  return earlierCount(messages, at) < NOT_WORTH_A_ROW ? 0 : at;
}

export function earlierCount(messages: Message[], start: number): number {
  let count = 0;
  for (let index = 0; index < start && index < messages.length; index += 1) if (shown(messages[index])) count += 1;
  return count;
}

// Something is about to jump to an old turn (a scheduled task's History
// row): that conversation draws its whole thread so the turn is there.
const whole = new Set<string>();
export function showWholeThread(key: string): void {
  if (whole.has(key)) return;
  whole.add(key);
  set();
}
export function wantsWholeThread(key: string): boolean { return whole.has(key); }
export function forgetWholeThread(key: string): void { whole.delete(key); }
