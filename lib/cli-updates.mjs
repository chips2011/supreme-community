import { execFile } from 'node:child_process';

const FIRST_CHECK_MS = Number(process.env.SUPREME_CLI_UPDATE_FIRST_MS || 3 * 60_000);
const EVERY_MS = process.env.SUPREME_CLI_UPDATE_MS == null ? 6 * 60 * 60_000 : Number(process.env.SUPREME_CLI_UPDATE_MS);
const RUN_TIMEOUT_MS = Number(process.env.SUPREME_CLI_UPDATE_TIMEOUT_MS || 10 * 60_000);
const BINARIES = ['claude', 'codex'];

const state = { enabled: EVERY_MS > 0, checkedAt: null, results: {} };
let timer = null;
let inFlight = null;

// The last meaningful line the CLI printed. Claude: "Claude Code is up to
// date (2.1.259)" or "Successfully updated from 2.1.258 to version 2.1.259".
export function summarize(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const said = lines.at(-1) || '';
  const updated = /updat|install/i.test(said) && !/up to date|already/i.test(said) ? said.match(/to (?:version )?v?(\d[\w.-]*)/i)?.[1] || null : null;
  const current = /up to date|already|latest/i.test(said) ? said.match(/\(v?(\d[\w.-]*)\)/)?.[1] || said.match(/v?(\d+\.\d+[\w.-]*)/)?.[1] || null : null;
  return { said: said.slice(0, 200), updated, current };
}

function runUpdate(binary, file) {
  return new Promise((resolve) => {
    execFile(file, ['update'], { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, CI: '1' } }, (error, stdout, stderr) => {
      const summary = summarize(`${stdout || ''}\n${stderr || ''}`);
      resolve({ binary, at: new Date().toISOString(), ok: !error, ...summary, error: error ? (error.killed ? 'timed out' : error.message.split('\n')[0].slice(0, 200)) : null });
    });
  });
}

// One pass over the CLIs Supreme can find. `busy()` true means a model is
// working: come back next tick rather than swap a binary under it.
export async function checkOnce({ resolveBinary, busy = () => false, afterPass = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (busy()) return { skipped: 'busy' };
    const results = {};
    for (const binary of BINARIES) {
      const file = resolveBinary ? resolveBinary(binary) : null;
      if (!file) continue;
      results[binary] = await runUpdate(binary, file);
      const r = results[binary];
      console.info(`[cli-updates] ${binary}: ${r.ok ? (r.updated ? `updated to ${r.updated}` : r.current ? `up to date (${r.current})` : r.said || 'done') : `failed: ${r.error}`}`);
    }
    state.checkedAt = new Date().toISOString();
    state.results = { ...state.results, ...results };
    // Then the model labels catch up with the CLI (providers.mjs probeClaudeAliases).
    if (afterPass) {
      try { await afterPass(results); } catch (err) { console.error('[cli-updates] after pass', err.message); }
    }
    return results;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

export function start(options) {
  if (!state.enabled || timer) return false;
  const tick = () => { checkOnce(options).catch((err) => console.error('[cli-updates]', err.message)); };
  const first = setTimeout(() => { tick(); timer = setInterval(tick, EVERY_MS); timer.unref?.(); }, FIRST_CHECK_MS);
  first.unref?.();
  timer = first;
  return true;
}

export function status() {
  return { enabled: state.enabled, everyMs: EVERY_MS, checkedAt: state.checkedAt, results: state.results };
}
