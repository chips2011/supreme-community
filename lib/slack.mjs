import { getSettings } from './store.mjs';

const API_BASE = () => process.env.WB_SLACK_API_BASE || 'https://slack.com/api';

const OAUTH_SCOPES = ['chat:write', 'im:write', 'im:history', 'users:read', 'users:read.email', 'reactions:write', 'mpim:read', 'mpim:history', 'channels:read', 'channels:history', 'groups:read', 'groups:history'];
const DEFAULT_REDIRECT_URL = '';
export function slackOAuthConfig() {
  const clientId = String(process.env.SLACK_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.SLACK_CLIENT_SECRET || '').trim();
  const redirectUrl = String(process.env.SLACK_REDIRECT_URL || DEFAULT_REDIRECT_URL).trim();
  return { configured: !!(clientId && clientSecret && redirectUrl), clientId, redirectUrl };
}
export function slackAuthorizeUrl(state) {
  const { clientId, redirectUrl } = slackOAuthConfig();
  const url = new URL(process.env.WB_SLACK_AUTHORIZE_URL || 'https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', OAUTH_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUrl);
  url.searchParams.set('state', state);
  return url.toString();
}
export async function slackExchangeCode(code) {
  const { clientId, redirectUrl } = slackOAuthConfig();
  const response = await fetch(`${API_BASE()}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: String(process.env.SLACK_CLIENT_SECRET || ''), code, redirect_uri: redirectUrl }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok || !data.access_token) throw new Error(`Slack oauth.v2.access: ${data.error || response.status}`);
  return { token: String(data.access_token), team: String(data.team?.name || '') };
}
const userIdByEmail = new Map();

export function slackPrefs(settings = getSettings()) {
  const raw = settings.slack && typeof settings.slack === 'object' ? settings.slack : {};
  return {
    botToken: typeof raw.botToken === 'string' ? raw.botToken : '',
    // The app-level token (xapp-…, scope connections:write) for Socket
    // Mode, so @Supreme in Slack reaches the service (2026-09-16).
    appToken: typeof raw.appToken === 'string' ? raw.appToken : '',
    selfEmail: typeof raw.selfEmail === 'string' ? raw.selfEmail.trim().toLowerCase() : '',
    selfUserId: typeof raw.selfUserId === 'string' ? raw.selfUserId.trim() : '',
    startNewThreads: raw.startNewThreads !== false,
    notifyMentions: raw.notifyMentions !== false,
    notifyCompleted: raw.notifyCompleted !== false,
    notifyFailures: raw.notifyFailures !== false,
    minRunSeconds: Number.isFinite(Number(raw.minRunSeconds)) ? Math.max(0, Number(raw.minRunSeconds)) : 120,
  };
}

async function call(method, token, payload) {
  const response = await fetch(`${API_BASE()}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
    signal: AbortSignal.timeout(8_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    const error = new Error(`Slack ${method}: ${data.error || response.status}`);
    error.code = String(data.error || '');
    error.needed = String(data.needed || '');
    throw error;
  }
  return data;
}

const AUTH_ERRORS = /invalid_auth|not_authed|account_inactive|token_revoked|token_expired|invalid_token/i;
const HEALTH_TTL_MS = 10 * 60_000;
let health = { token: '', state: 'unset', team: '', error: '', checkedAt: 0 };
let healthCheck = null;

function publicHealth() {
  return { state: health.state, team: health.team, error: health.error, checkedAt: health.checkedAt ? new Date(health.checkedAt).toISOString() : null };
}

async function verifyToken(token) {
  try {
    const data = await call('auth.test', token, {});
    health = { token, state: 'ok', team: String(data.team || ''), error: '', checkedAt: Date.now() };
  } catch (err) {
    const message = String(err.message || '').replace(/^Slack auth\.test: /, '');
    health = { token, state: AUTH_ERRORS.test(message) ? 'rejected' : 'unreachable', team: '', error: message, checkedAt: Date.now() };
  }
  return publicHealth();
}

// force: wait for a fresh verdict (a token was just pasted, the person is
// watching). Otherwise answer from the cache at once and refresh in the
// background when stale, so a settings read never stalls on Slack.
export async function slackHealth({ force = false } = {}) {
  const { botToken } = slackPrefs();
  if (!botToken) {
    health = { token: '', state: 'unset', team: '', error: '', checkedAt: Date.now() };
    return publicHealth();
  }
  const stale = health.token !== botToken || Date.now() - health.checkedAt > HEALTH_TTL_MS;
  if (!stale && !force) return publicHealth();
  if (!healthCheck) healthCheck = verifyToken(botToken).finally(() => { healthCheck = null; });
  if (force || health.token !== botToken) return healthCheck;
  return publicHealth();
}

// A DM that Slack refused for auth reasons is the same verdict as a failed
// auth.test: flip the cached state so the Connectors page tells the truth
// without waiting for its next check.
function noteSlackFailure(err) {
  const message = String(err?.message || '');
  if (!AUTH_ERRORS.test(message)) return;
  const { botToken } = slackPrefs();
  health = { token: botToken, state: 'rejected', team: '', error: message.replace(/^Slack [\w.]+: /, ''), checkedAt: Date.now() };
}

// Inbound @Supreme (2026-09-16): the pieces the mention handler needs from
// the Web API, each with the bot token. Names, the message a thread
// answers, a channel's name, a file as an attachment, and the reply.
export async function slackCall(method, payload = {}) {
  const prefs = slackPrefs();
  if (!prefs.botToken) throw new Error('Slack is not connected.');
  try { return await call(method, prefs.botToken, payload); } catch (err) { noteSlackFailure(err); throw err; }
}

const userNames = new Map();
export async function slackUserName(userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  if (userNames.has(id)) return userNames.get(id);
  try {
    const found = await slackCall('users.info', { user: id });
    const name = found.user?.real_name || found.user?.profile?.display_name || found.user?.name || id;
    userNames.set(id, name);
    return name;
  } catch { return id; }
}

const userEmails = new Map();
// The person's Slack address (users:read.email), to tell who may use which tabs.
export async function slackUserEmail(userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  if (userEmails.has(id)) return userEmails.get(id);
  try {
    const found = await slackCall('users.info', { user: id });
    const email = String(found.user?.profile?.email || '').trim().toLowerCase();
    userEmails.set(id, email);
    return email;
  } catch { return ''; }
}

const conversations = new Map();
export async function slackConversationInfo(channel) {
  const id = String(channel || '').trim();
  const token = slackPrefs().botToken;
  const cached = conversations.get(id);
  if (cached?.token === token && Date.now() - cached.at < 30_000) return cached.value;
  const found = await slackCall('conversations.info', { channel: id });
  const value = found.channel;
  if (!value || value.id !== id) throw new Error('Slack returned a different conversation.');
  conversations.set(id, { token, at: Date.now(), value });
  while (conversations.size > 128) conversations.delete(conversations.keys().next().value);
  return value;
}
export async function slackMemberPage(channel, { cursor = '', limit = 20 } = {}) {
  const found = await slackCall('conversations.members', { channel, limit: String(limit), ...(cursor ? { cursor } : {}) });
  return { members: Array.isArray(found.members) ? found.members : [], nextCursor: found.response_metadata?.next_cursor || '' };
}
export async function slackUserProfile(userId) {
  const found = await slackCall('users.info', { user: userId });
  return found.user;
}
export async function slackChannelName(channel) {
  const id = String(channel || '').trim();
  if (!id) return '';
  try {
    const found = await slackConversationInfo(id);
    return found.name || (found.is_mpim ? 'group chat' : found.is_im ? 'direct message' : id);
  } catch { return id; }
}

// The bot's own user id, for telling its posts from everyone else's.
let botUser = { token: '', id: '' };
export async function slackBotUserId() {
  const { botToken } = slackPrefs();
  if (!botToken) return '';
  if (botUser.token === botToken && botUser.id) return botUser.id;
  try {
    const data = await slackCall('auth.test');
    botUser = { token: botToken, id: String(data.user_id || '') };
  } catch { return ''; }
  return botUser.id;
}

// A channel's recent top-level messages, newest first as Slack gives them.
export async function slackHistoryPage(channel, { oldest = '', latest = '', limit = 15 } = {}) {
  const found = await slackCall('conversations.history', { channel, limit: String(limit), ...(oldest ? { oldest: String(oldest) } : {}), ...(latest ? { latest: String(latest) } : {}) });
  return { messages: Array.isArray(found.messages) ? found.messages : [], hasMore: !!found.has_more || !!found.response_metadata?.next_cursor };
}
export async function slackChannelHistory(channel, { oldest = '', latest = '', limit = 200 } = {}) {
  if (!channel) return [];
  return (await slackHistoryPage(channel, { oldest, latest, limit })).messages;
}

export async function slackThreadPage(channel, threadTs, { latest = '', limit = 15 } = {}) {
  const found = await slackCall('conversations.replies', { channel, ts: threadTs, limit: String(limit), ...(latest ? { latest: String(latest) } : {}) });
  return { messages: Array.isArray(found.messages) ? found.messages : [], hasMore: !!found.has_more || !!found.response_metadata?.next_cursor };
}

// A whole thread, the first message first.
export async function slackThreadMessages(channel, threadTs, { limit = 200 } = {}) {
  if (!channel || !threadTs) return [];
  const found = await slackCall('conversations.replies', { channel, ts: threadTs, limit: String(limit), inclusive: true });
  return Array.isArray(found.messages) ? found.messages : [];
}

// The first message of a thread, the one a reply answers.
export async function slackThreadParent(channel, threadTs) {
  if (!channel || !threadTs) return null;
  try {
    const found = await slackCall('conversations.replies', { channel, ts: threadTs, limit: 1, inclusive: true });
    const parent = (found.messages || [])[0];
    return parent ? { ...parent, user: parent.user || '', text: String(parent.text || ''), files: Array.isArray(parent.files) ? parent.files : [] } : null;
  } catch { return null; }
}

// A file Slack holds, brought over as an attachment for the run: name,
// type, and the bytes as a data URL, the shape the run route takes.
const SLACK_FILE_MAX = 10 * 1024 * 1024;
export async function slackFileAttachment(file) {
  const url = file?.url_private_download || file?.url_private;
  const prefs = slackPrefs();
  if (!url || !prefs.botToken) return null;
  if (Number(file.size) > SLACK_FILE_MAX) return null;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${prefs.botToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > SLACK_FILE_MAX) return null;
  const mimeType = String(file.mimetype || 'application/octet-stream');
  return { kind: 'file', name: String(file.name || file.title || 'slack-file'), mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}` };
}

export async function slackPostInThread(channel, threadTs, text, blocks = null) {
  const payload = { channel, thread_ts: threadTs, text: String(text || '').slice(0, 3_900) };
  // Buttons ride as Block Kit; the plain text stays as what notifications
  // and older clients show.
  if (Array.isArray(blocks) && blocks.length) payload.blocks = JSON.stringify(blocks);
  return slackCall('chat.postMessage', payload);
}

let reactionScopeLogged = false;
export async function slackReact(channel, ts, name, on = true) {
  if (!channel || !ts) return;
  try {
    await slackCall(on ? 'reactions.add' : 'reactions.remove', { channel, timestamp: ts, name });
  } catch (err) {
    const message = String(err?.message || '');
    if (/already_reacted|no_reaction|message_not_found/.test(message)) return;
    if (/missing_scope/.test(message)) {
      if (!reactionScopeLogged) console.warn('[slack] reactions need the reactions:write scope; add it to the Slack app and reinstall');
      reactionScopeLogged = true;
      return;
    }
    console.warn(`[slack] reaction: ${message}`);
  }
}

// Rewrite one of the bot's own messages: the buttons come off once one is
// pressed, and the line says what was chosen.
export async function slackUpdateMessage(channel, ts, text, blocks = null) {
  const payload = { channel, ts, text: String(text || '').slice(0, 3_900) };
  payload.blocks = JSON.stringify(Array.isArray(blocks) && blocks.length ? blocks : [{ type: 'section', text: { type: 'mrkdwn', text: String(text || '').slice(0, 2_900) } }]);
  return slackCall('chat.update', payload);
}

// Slack's message text, readable: the bot's own mention gone, links as
// their label or address, entities unescaped.
export function slackPlainText(text, botUserId = '') {
  let out = String(text || '');
  if (botUserId) out = out.split(`<@${botUserId}>`).join(' ');
  out = out.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, (match) => { const label = match.slice(2, -1).split('|')[1]; return label ? `@${label}` : '@someone'; });
  out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1');
  out = out.replace(/<(https?:[^>|]+)\|([^>]*)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1');
  out = out.replace(/<(?:mailto|tel):[^>|]+\|([^>]*)>/g, '$1').replace(/<(?:mailto|tel):([^>]+)>/g, '$1');
  out = out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// Report apps often put the meaningful text and evidence links in blocks or
// attachments, leaving only "New report" in text. Read those as source text,
// without fetching arbitrary embedded URLs or treating them as commands.
export function slackMessageText(message) {
  const parts = [String(message?.text || '')];
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (typeof node.text === 'string') parts.push(node.text);
    else if (node.text) walk(node.text, depth + 1);
    if (node.type === 'link' && node.url) parts.push(node.url);
    if (node.image_url) parts.push(`Image: ${node.alt_text || node.title?.text || 'attached image'} (${node.image_url})`);
    for (const child of [...(Array.isArray(node.elements) ? node.elements : []), ...(Array.isArray(node.fields) ? node.fields : [])]) walk(child, depth + 1);
  };
  for (const block of (message?.blocks || []).slice(0, 50)) walk(block);
  for (const attachment of (message?.attachments || []).slice(0, 20)) {
    for (const key of ['pretext', 'title', 'title_link', 'text', 'from_url']) if (attachment[key]) parts.push(String(attachment[key]));
    walk(attachment);
    for (const field of (attachment.fields || []).slice(0, 20)) if (field.value) parts.push(String(field.value));
  }
  const kept = [];
  for (const part of parts.map((text) => slackPlainText(text)).filter(Boolean)) {
    if (!kept.some((previous) => previous.includes(part))) kept.push(part);
  }
  return kept.join('\n').slice(0, 20_000);
}

export function slackMrkdwn(text) {
  const parts = String(text || '').split(/(```[\s\S]*?```)/);
  return parts.map((part, index) => {
    if (index % 2) return part.replace(/^```[^\n]*\n?/, '```\n');
    let out = part;
    out = out.replace(/^```[A-Za-z0-9_+-]+[ \t]*$/gm, '```');
    out = out.replace(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$2*');
    out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
    out = out.replace(/__(.+?)__/g, '_$1_');
    out = out.replace(/~~(.+?)~~/g, '~$1~');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    return out;
  }).join('');
}

export async function slackDmByEmail(email, text) {
  const prefs = slackPrefs();
  if (!prefs.botToken || !email) return false;
  const key = String(email).toLowerCase();
  let userId = userIdByEmail.get(key);
  try {
    if (!userId) {
      const found = await call('users.lookupByEmail', prefs.botToken, { email: key });
      userId = found.user?.id;
      if (!userId) return false;
      userIdByEmail.set(key, userId);
    }
    await call('chat.postMessage', prefs.botToken, { channel: userId, text });
  } catch (err) {
    noteSlackFailure(err);
    throw err;
  }
  return true;
}
