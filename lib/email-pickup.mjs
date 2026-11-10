// Section 32: forwarded emails wait in the cloud (inbound_emails, migration
// 0010) until this Mac picks them up. A mail service's inbound hook writes
// the row, owned by the person whose address it came from; this Mac reads
// its own unpicked rows every few seconds, hands each to the inbound path
// and stamps it picked. Off unless Settings turns email on and Supabase is
// set up; nothing here sends anything.
import * as supabase from './supabase.mjs';

const EVERY_MS = Math.max(2_000, Number(process.env.WB_EMAIL_PICKUP_MS) || 8_000);
const state = { timer: null, busy: false, lastError: null, lastPickedAt: null };

export async function pickOnce({ token, onEmail }) {
  if (state.busy || !token || !supabase.isConfigured()) return 0;
  state.busy = true;
  let picked = 0;
  try {
    const rows = await supabase.rest('inbound_emails?picked_at=is.null&order=received_at.asc&limit=20', { token }) || [];
    for (const row of rows) {
      // Stamped first, so a crash mid way never runs the same email twice.
      await supabase.rest(`inbound_emails?id=eq.${encodeURIComponent(row.id)}&picked_at=is.null`, { method: 'PATCH', token, body: { picked_at: new Date().toISOString() }, prefer: 'return=minimal' });
      await onEmail({
        to: row.to_addr,
        from: row.from_addr,
        subject: row.subject,
        text: row.text,
        messageId: row.message_id,
        inReplyTo: row.in_reply_to,
        references: row.raw_headers?.references || '',
        // Section 33: only the cloud's signed deal-reply path writes this.
        ...(row.raw_headers?.kind === 'deal_reply' && row.raw_headers.deal_reply ? { dealReply: row.raw_headers.deal_reply } : {}),
      });
      picked += 1;
    }
    state.lastError = null;
    if (picked) state.lastPickedAt = new Date().toISOString();
  } catch (err) {
    if (state.lastError !== err.message) console.error('[email] pickup:', err.message);
    state.lastError = err.message;
  } finally { state.busy = false; }
  return picked;
}

export function start({ enabled, token, onEmail }) {
  if (state.timer) return false;
  const tick = () => { if (enabled()) pickOnce({ token: token(), onEmail }).catch(() => {}); };
  state.timer = setInterval(tick, EVERY_MS);
  state.timer.unref?.();
  return true;
}

export function status() {
  return { lastError: state.lastError, lastPickedAt: state.lastPickedAt };
}
