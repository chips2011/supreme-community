// Native Slack working state, independent of the model and message transport.
// New agent sessions last an hour; older workspaces use the two-minute status
// API. Only live work refreshes either. A journal clears interrupted work on
// the next launch without retaining prompts, credentials or report contents.
import fs from 'node:fs';
import path from 'node:path';

const UNSUPPORTED = /unknown_method|method_not_supported|feature_disabled|missing_scope|not_an_agent|app_not_configured_as_agent/;

export function createSlackActivity({ call, identity, home, warn = console.warn, timers = globalThis,
  modernRefreshMs = 30 * 60_000, legacyRefreshMs = 60_000 }) {
  const live = new Map();
  const compatibility = new Map();
  let stopping = false;
  let recovering = Promise.resolve();
  const journalPath = path.join(home, 'slack-activity.json');
  const readJournal = () => {
    try {
      const found = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      return found && typeof found === 'object' && !Array.isArray(found) ? found : {};
    } catch { return {}; }
  };
  let journal = readJournal();
  function persist() {
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });
    } catch (err) { warn(`[slack] activity journal: ${err.code || 'storage error'}`); }
  }
  async function update(row, status) {
    // Never use a newly connected workspace to finish an old workspace's work.
    if (row.identity !== identity()) return false;
    const payload = { channel_id: row.channel, thread_ts: row.threadTs };
    try {
      if (compatibility.get(row.identity) !== 'legacy') {
        try {
          await call('agents.sessions.setStatus', { ...payload, status, ...(row.title ? { title: row.title.slice(0, 200) } : {}) });
          row.mode = 'modern';
          return true;
        } catch (err) {
          if (!UNSUPPORTED.test(String(err.message))) throw err;
          compatibility.set(row.identity, 'legacy');
        }
      }
      await call('assistant.threads.setStatus', { ...payload, status: status === 'processing' ? 'is working' : '' });
      row.mode = 'legacy';
      return true;
    } catch (err) {
      // The reaction and thread reply still work if Slack cannot show status.
      warn(`[slack] working status: ${err.message}`);
      return false;
    }
  }
  function serialize(row, status) {
    row.pending = row.pending.catch(() => {}).then(() => update(row, status));
    return row.pending;
  }
  function arm(row) {
    timers.clearTimeout(row.timer);
    if (stopping || !row.count || row.identity !== identity()) return;
    row.timer = timers.setTimeout(async () => {
      if (stopping || !row.count) return;
      await serialize(row, 'processing');
      if (row.count) arm(row);
    }, row.mode === 'legacy' ? legacyRefreshMs : modernRefreshMs);
    row.timer?.unref?.();
  }
  return {
    async begin({ channel, threadTs, title = '' }) {
      await recovering;
      if (stopping) return async () => {};
      const owner = identity();
      const key = JSON.stringify([owner, channel, threadTs]);
      let row = live.get(key);
      if (!row) {
        row = { identity: owner, channel, threadTs, title, count: 0, pending: Promise.resolve(), timer: null };
        live.set(key, row);
      }
      row.count += 1;
      journal[key] = { identity: owner, channel, threadTs };
      persist();
      await serialize(row, 'processing');
      arm(row);
      let finished = false;
      return async (status = 'active') => {
        if (finished || row.closed) return;
        finished = true;
        row.count -= 1;
        if (row.count) return;
        timers.clearTimeout(row.timer);
        const cleared = await serialize(row, status);
        // Another turn can begin while the clear is in flight.
        if (row.count) return;
        live.delete(key);
        if (cleared) delete journal[key];
        persist();
      };
    },
    recover() {
      recovering = recovering.catch(() => {}).then(async () => {
        const owner = identity();
        if (!owner) return;
        for (const [key, row] of Object.entries(journal)) {
          if (row.identity !== owner || live.has(key) || !row.channel || !row.threadTs) continue;
          if (await update(row, 'active')) delete journal[key];
        }
        persist();
      });
      return recovering;
    },
    async shutdown() {
      stopping = true;
      await Promise.all([...live].map(async ([key, row]) => {
        row.closed = true;
        row.count = 0;
        timers.clearTimeout(row.timer);
        if (await serialize(row, 'active')) delete journal[key];
        live.delete(key);
      }));
      persist();
    },
  };
}
