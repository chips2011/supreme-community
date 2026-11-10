// Section 33, the phone buzzes when a scheduled task lands (2026-09-26).
// The Mac never holds an APNs key: it posts the landing to the phone-push
// function with its signed-in user's token, and the function sends to that
// account's phones (supabase/functions/phone-push). Best effort, like Web
// Push: a push is never allowed to break or slow a run.
import * as sb from './supabase.mjs';

// The words on the lock screen. The schedule's own name leads, since that
// is what was set to run; the body is the reply's first sentence, or why
// it did not get one.
export function phoneMessage({ name, outcome, line = '', error = '' }) {
  const who = String(name || 'A scheduled task').trim();
  const titles = {
    done: `${who} is done`,
    waiting: `${who} needs you`,
    failed: `${who} failed`,
    missed: `${who} did not run`,
  };
  const title = titles[outcome] || titles.done;
  const body = String((outcome === 'failed' || outcome === 'missed' ? error || line : line) || '').replace(/\s+/g, ' ').trim();
  return { title, body: body.length > 180 ? `${body.slice(0, 179)}…` : body };
}

export async function pushToPhone(session, { title, body = '', threadId = null, tabId = null, kind = 'done' }) {
  if (!session?.token || !sb.isConfigured() || process.env.WB_PHONE_PUSH === '0') return { sent: 0, skipped: true };
  const { url, anonKey } = sb.config();
  const base = (process.env.WB_PHONE_PUSH_URL || `${url}/functions/v1/phone-push`).replace(/\/+$/, '');
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, threadId, tabId, kind }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) console.warn(`[phone-push] ${res.status} ${result?.error || ''}`.trim());
    return { sent: Number(result?.sent) || 0, status: res.status };
  } catch (err) {
    console.warn('[phone-push] not sent:', err.message);
    return { sent: 0, error: err.message };
  }
}
