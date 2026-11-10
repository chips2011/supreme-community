// Connection evidence comes from tool failures and browser metadata, never
// from the assistant's prose or a web page saying a connection was restored.
const LOST = /Browser is not available:\s*(chrome|edge)\b|No browser is available|(?:cannot|could not|unable to) communicate with (?:the )?ChatGPT browser extension|(?:chrome|edge|browser|extension)[^\n]{0,70}(?:disconnected|connection (?:closed|lost)|transport (?:closed|unavailable))/i;
const RETRY_MS = 30_000;
const browserLabel = family => family === 'edge' ? 'Edge' : family === 'chrome' ? 'Chrome' : 'Browser';

function object(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.length <= 200_000) {
    try { return JSON.parse(value); } catch {}
  }
  return null;
}

function textResult(value) {
  if (typeof value === 'string') return value.slice(0, 20_000);
  if (Array.isArray(value)) return value.filter(row => row?.type === 'text' || row?.type === 'input_text').map(row => row.text || '').join('\n').slice(0, 20_000);
  return typeof value?.message === 'string' ? value.message.slice(0, 20_000) : '';
}

export function browserConnectionEvidence(item) {
  const result = object(item?.result) || object(item?.output);
  const server = String(item?.server || item?.server_name || '');
  const tool = String(item?.tool || item?.name || '');
  const meta = result?._meta?.['codex/toolSurface'] || result?._meta?.browser_use;
  if (!(/node[_ -]?repl|browser|chrome|computer|playwright/i.test(server) && /js|browser|chrome|computer|playwright/i.test(tool)) && meta?.kind !== 'browserUse') return null;
  const explicitError = textResult(item?.error) || textResult(result?.error);
  const output = textResult(result?.content) || textResult(item?.output) || textResult(item?.result);
  // Node REPL can return a thrown Error inside a text block without isError.
  // Match only the error envelope, not arbitrary page text containing it.
  const thrown = output.match(/^(?:(?:Elapsed(?: time)?:[^\n]*|Wall time:[^\n]*|Output:)\s*\n)*(?:Error|BrowserUnavailableError):\s*([^\n]+)/)?.[1] || '';
  const failed = item?.status === 'failed' || result?.isError === true || !!explicitError;
  const message = failed ? explicitError || output : thrown;
  const match = message.match(LOST);
  if (match) {
    const input = object(item.arguments) || object(item.input);
    const selected = String(input?.code || '').match(/\.browsers\.get\(\s*['"](chrome|edge)['"]\s*\)/)?.[1];
    return { state: 'unavailable', family: /\bedge\b/i.test(match[0]) ? 'edge' : /\bchrome\b/i.test(match[0]) ? 'chrome' : selected || 'browser' };
  }
  if (!failed && !thrown && (meta?.backend === 'chrome' || meta?.backend === 'edge')) {
    return { state: 'connected', family: meta.backend };
  }
  return null;
}

export function browserRecoveryPrompt(family) {
  const name = family === 'browser' ? 'the selected browser' : browserLabel(family);
  return [
    '<supreme_browser_recovery>',
    `Supreme observed a failed ${name} control call in this exact turn. This is a connection recovery request, not a new task or permission to repeat an external action.`,
    'Keep the existing browser runtime and task context. Read its bootstrap-troubleshooting and chrome-troubleshooting documentation. Follow only their supported recovery steps.',
    `Keep ${name} and the already selected profile/account. Never substitute another browser or profile. Before reopening, use the documented dry-run to verify the selected profile matches the task; if the match is unknown, ask instead of guessing. Use existing task or saved user authorization for routine non-destructive reopen/reconnect; otherwise ask. This recovery request grants no new permissions and does not authorize native-host repair, reinstalling, or restarting shared apps.`,
    'Use a lightweight read-only browser call to check the connection, wait two seconds and retry once if that has not already been done. If needed, run the documented diagnostics, then the documented same-profile reopen once. Do not repeat a recovery step already attempted in this turn.',
    'A passing install/manifest check is not proof of a live connection. Verify with a real browser call. If still unavailable, stop browser-dependent work, state what remains unfinished, and direct the user to Settings > Computer Use to repair the Browser plugin. Do not report the business task as completed.',
    'If the connection returns, inspect the current page and reconcile any pending send, upload, invite, purchase or other change before continuing. Never replay a possibly completed mutation. Resume from the observed state, retaining the original goal and all user follow-ups.',
    '</supreme_browser_recovery>',
  ].join('\n');
}

export const BROWSER_CONNECTION_POLICY = [
  '<supreme_browser_connection_policy>',
  'Only when this task requires browser control: follow the installed browser skill and use a lightweight read-only call before making changes. Extension installation or a running browser alone does not prove control is connected.',
  'Preserve the requested browser, selected profile and account. Use only documented non-destructive recovery. Never repair a native host, silently switch browser/profile, restart shared apps, or repeat a possibly completed external action.',
  'If a browser action loses its connection, retain your place and verify the current external state after recovery before continuing. If documented recovery fails, explain the blocked work rather than claiming it completed.',
  '</supreme_browser_connection_policy>',
].join('\n');

export function createBrowserConnectionMonitor({ emit, recover, timeoutMs = RETRY_MS, timers = { setTimeout, clearTimeout } }) {
  let state = null, family = 'browser', attempted = false, closed = false, timer = null;
  const seen = new Set();
  const clearTimer = () => { if (timer) timers.clearTimeout(timer); timer = null; };
  const publish = (next) => {
    state = next;
    const label = browserLabel(family);
    emit({ type: 'computer', phase: next === 'connected' ? 'connected' : next === 'recovering' ? 'recovering' : 'blocked', connection: next,
      surface: family === 'chrome' ? 'Chrome' : 'browser', app: label,
      step: next === 'connected' ? `${label} connected` : next === 'recovering' ? `Reconnecting to ${label}` : `${label} isn't connected. Repair the Browser plugin in Settings > Computer Use.` });
  };
  return {
    observe(item) {
      if (closed) return false;
      const evidence = browserConnectionEvidence(item);
      if (!evidence) return false;
      if (evidence.state === 'connected') {
        // An unrelated browser succeeding cannot clear this browser's failure.
        if (state && family !== 'browser' && family !== evidence.family) return false;
        family = evidence.family;
        clearTimer();
        if (state && state !== 'connected') publish('connected');
        return false;
      }
      const id = item?.id || item?.call_id;
      if (id && seen.has(id)) return true;
      if (id) { seen.add(id); if (seen.size > 128) seen.delete(seen.values().next().value); }
      if (evidence.family !== 'browser' || !state) family = evidence.family;
      clearTimer();
      publish('unavailable');
      if (attempted || !recover) return true;
      attempted = true;
      publish('recovering');
      timer = timers.setTimeout(() => { timer = null; if (!closed && state === 'recovering') publish('unavailable'); }, timeoutMs);
      timer?.unref?.();
      // The callback sends a native turn/steer to this exact provider turn.
      // A rejection, timeout or completed-turn race never starts a new turn.
      void Promise.resolve().then(() => closed ? false : recover(browserRecoveryPrompt(family)))
        .then(accepted => { if (!closed && state === 'recovering' && !accepted) { clearTimer(); publish('unavailable'); } })
        .catch(() => { if (!closed && state === 'recovering') { clearTimer(); publish('unavailable'); } });
      return true;
    },
    finish() {
      if (closed) return;
      clearTimer();
      if (state === 'recovering') publish('unavailable');
      closed = true;
    },
  };
}
