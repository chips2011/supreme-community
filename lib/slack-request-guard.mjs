// Relay rows are references, not Slack events. Prove request intent with the
// recipient's bot token, then claim the Slack identity before dispatching it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SLACK_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000;
const validId = value => typeof value === 'string' && /^[A-Z][A-Z0-9]+$/.test(value);
const validTs = value => typeof value === 'string' && /^\d{10,}\.[0-9]{6}$/.test(value);

export async function readSlackRequest({ claimed, botId, readThread, readConversation, allowFollowup, now = Date.now() }) {
  const channel = claimed?.channel;
  const ts = claimed?.ts;
  if (!validId(botId) || !validId(channel) || !validTs(ts)) return null;
  const age = now - Number(ts) * 1_000;
  if (!Number.isFinite(age) || age > SLACK_REQUEST_MAX_AGE_MS || age < -60_000) return null;
  const root = validTs(claimed.thread_ts) ? claimed.thread_ts : ts;
  let found;
  try { found = (await readThread(channel, root)).find(message => message.ts === ts); } catch { return null; }
  if (!found && root !== ts) {
    try { found = (await readThread(channel, ts)).find(message => message.ts === ts); } catch { return null; }
  }
  if (!found || !validId(found.user) || found.user === botId || found.bot_id || found.edited
      || (found.subtype && found.subtype !== 'file_share')) return null;
  const text = String(found.text || '');
  let direct = false;
  let followup = false;
  if (!text.includes(`<@${botId}>`)) {
    // Do not trust claimed type/channel_type or a channel-id prefix. Slack's
    // authenticated conversation metadata must identify this one-to-one DM.
    let conversation;
    try { conversation = await readConversation(channel); } catch { return null; }
    direct = conversation?.id === channel && conversation.is_im === true && conversation.user === found.user;
    if (!direct) {
      // The actual Slack message, not the relay row, must be a reply to an
      // already subscribed thread. Caller checks its connection and access.
      const parent = found.thread_ts;
      if (!validTs(parent) || parent === ts || parent !== root || !allowFollowup) return null;
      try { followup = (await allowFollowup({ channel, threadTs: parent, user: found.user })) === true; } catch { return null; }
      if (!followup) return null;
    }
  }
  return {
    type: direct || followup ? 'message' : 'app_mention', channel, ts,
    user: found.user, text,
    ...(direct ? { channel_type: 'im' } : {}),
    ...(validTs(found.thread_ts) && found.thread_ts !== ts ? { thread_ts: found.thread_ts } : {}),
    ...(Array.isArray(found.files) ? { files: found.files } : {}),
    ...(Array.isArray(found.attachments) ? { attachments: found.attachments } : {}),
  };
}

export function claimSlackRequest({ home, botId, channel, ts }) {
  if (!validId(botId) || !validId(channel) || !validTs(ts)) return false;
  // The authenticated bot identity plus conversation and message timestamp is
  // stable across row IDs, senders, token rotation, and process restarts. Empty
  // exclusive-create receipts carry no message text, credentials, or user data.
  const directory = path.join(home, 'slack-request-receipts');
  const key = createHash('sha256').update(JSON.stringify([botId, channel, ts])).digest('hex');
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(directory, key), 'wx', 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') console.warn(`[slack] cannot persist request receipt (${error.code || 'storage error'}); dropped`);
    return false; // Never dispatch if replay protection could not be persisted.
  }
}
