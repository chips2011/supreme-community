
const API_BASE = () => process.env.WB_SLACK_API_BASE || 'https://slack.com/api';
const SOCKET_URL = () => process.env.WB_SLACK_SOCKET_URL || '';
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

const state = {
  token: '',
  socket: null,
  status: 'off',        // off | connecting | listening | error
  error: '',
  since: null,
  attempt: 0,
  timer: null,
  onMention: null,
  onAction: null,       // a button pressed under one of the bot's messages
  stopped: true,
  seen: new Map(),      // event id -> seen at, so a redelivered envelope runs once
};

export function slackSocketStatus() {
  return { state: state.status, error: state.error, since: state.since };
}

async function openUrl(token) {
  if (SOCKET_URL()) return SOCKET_URL();
  const response = await fetch(`${API_BASE()}/apps.connections.open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(8_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok || !data.url) throw new Error(`Slack apps.connections.open: ${data.error || response.status}`);
  return data.url;
}

function scheduleReconnect(reason) {
  if (state.stopped) return;
  const delay = BACKOFF_MS[Math.min(state.attempt, BACKOFF_MS.length - 1)];
  state.attempt += 1;
  state.status = 'error';
  state.error = reason;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { void connect(); }, delay);
}

function closeSocket() {
  const socket = state.socket;
  state.socket = null;
  if (!socket) return;
  try { socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); } catch {}
}

async function connect() {
  if (state.stopped || !state.token) return;
  closeSocket();
  state.status = 'connecting';
  let url;
  try {
    url = await openUrl(state.token);
  } catch (error) {
    scheduleReconnect(error.message);
    return;
  }
  if (state.stopped) return;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    scheduleReconnect(error.message);
    return;
  }
  state.socket = socket;
  socket.onopen = () => {
    // Slack says hello first; listening begins on that.
  };
  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      state.status = 'listening';
      state.error = '';
      state.since = new Date().toISOString();
      state.attempt = 0;
      console.info('[slack] socket listening');
      return;
    }
    if (message.type === 'disconnect') {
      console.info(`[slack] socket asked to reconnect (${message.reason || 'no reason'})`);
      closeSocket();
      state.attempt = 0;
      scheduleReconnect(message.reason || 'reconnect');
      return;
    }
    if (message.envelope_id) {
      // Ack first, always: Slack redelivers what is not acked in three seconds.
      try { socket.send(JSON.stringify({ envelope_id: message.envelope_id })); } catch {}
    }
    if (message.type === 'interactive') {
      const payload = message.payload || {};
      // The Edit box's Redraft: the empty ack above closes it.
      if (payload.type === 'view_submission') {
        if (state.onAction) Promise.resolve(state.onAction(payload, null)).catch((error) => console.warn(`[slack] edit failed: ${error.message}`));
        return;
      }
      if (payload.type !== 'block_actions' || !Array.isArray(payload.actions) || !payload.actions.length) return;
      const action = payload.actions[0];
      const actionId = `${payload.container?.message_ts || payload.message?.ts || ''}:${action.action_id}:${action.value || action.selected_option?.value || ''}`;
      const now = Date.now();
      for (const [id, at] of state.seen) if (now - at > 10 * 60_000) state.seen.delete(id);
      if (state.seen.has(actionId)) return;
      state.seen.set(actionId, now);
      if (state.onAction) {
        Promise.resolve(state.onAction(payload, action))
          .catch((error) => console.warn(`[slack] action failed: ${error.message}`));
      }
      return;
    }
    if (message.type !== 'events_api') return;
    const payload = message.payload || {};
    const inner = payload.event || {};
    const human = !!inner.user && !inner.bot_id && !inner.edited && (!inner.subtype || inner.subtype === 'file_share');
    const direct = inner.type === 'message' && inner.channel_type === 'im' && human;
    // Only thread replies are candidates outside a DM. The service checks the
    // saved bot-bound route and this person's access before claiming one.
    const followup = inner.type === 'message' && human && inner.thread_ts && inner.thread_ts !== inner.ts;
    if (!human || (inner.type !== 'app_mention' && !direct && !followup)) return;
    const eventId = String(payload.event_id || `${inner.channel}:${inner.ts}`);
    const messageKey = `${inner.channel}:${inner.ts}`;
    const now = Date.now();
    for (const [id, at] of state.seen) if (now - at > 10 * 60_000) state.seen.delete(id);
    if (state.seen.has(eventId) || state.seen.has(messageKey)) return;
    state.seen.set(eventId, now);
    state.seen.set(messageKey, now);
    if (state.onMention) {
      Promise.resolve(state.onMention(inner, { teamId: payload.team_id || null, eventId }))
        .catch((error) => console.warn(`[slack] mention failed: ${error.message}`));
    }
  };
  socket.onclose = (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (state.stopped) return;
    scheduleReconnect(`closed${event?.code ? ` (${event.code})` : ''}`);
  };
  socket.onerror = () => {
    if (state.socket !== socket) return;
    state.error = 'socket error';
  };
}

// Start (or restart on a new token) the listener. A missing token stops it.
export function startSlackSocket({ token, onMention, onAction }) {
  state.onMention = onMention || state.onMention;
  state.onAction = onAction || state.onAction;
  const next = String(token || '').trim();
  if (!next) { stopSlackSocket(); return; }
  if (next === state.token && !state.stopped && state.socket) return;
  state.token = next;
  state.stopped = false;
  state.attempt = 0;
  clearTimeout(state.timer);
  void connect();
}

export function stopSlackSocket() {
  state.stopped = true;
  state.token = '';
  clearTimeout(state.timer);
  closeSocket();
  state.status = 'off';
  state.error = '';
  state.since = null;
}
