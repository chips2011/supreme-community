import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scheduledUpdateDelay,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FOCUS_DELAY_MS,
  UPDATE_RECENT_CHECK_GAP_MS,
} from '../update-schedule.mjs';

if (UPDATE_CHECK_INTERVAL_MS !== 5 * 60 * 1_000) {
  throw new Error(`Automatic update checks must run every five minutes, got ${UPDATE_CHECK_INTERVAL_MS}ms.`);
}
if (scheduledUpdateDelay({ delay: UPDATE_FOCUS_DELAY_MS }) !== UPDATE_FOCUS_DELAY_MS) {
  throw new Error('A focus check with no recent request must run promptly.');
}
if (scheduledUpdateDelay({
  delay: UPDATE_FOCUS_DELAY_MS,
  lastCheckAt: 90_000,
  now: 100_000,
  respectRecentCheck: true,
}) !== UPDATE_RECENT_CHECK_GAP_MS - 10_000) {
  throw new Error('Repeated focus events must respect the recent-check cooldown.');
}

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedBinary = process.env.CONDUCTOR_ELECTRON_BINARY
  || (process.argv.includes('--packaged') ? 'dist/mac-arm64/Supreme Community.app/Contents/MacOS/Supreme Community' : '');
const scratchData = mkdtempSync(path.join(os.tmpdir(), 'conductor-desktop-smoke-'));
let electronBinary;
if (packagedBinary) {
  // Test the bundle from outside the checkout. This prevents Node from finding
  // a missing packaged dependency in the repository's ancestor node_modules.
  const sourceBinary = path.resolve(DESKTOP_DIR, packagedBinary);
  const sourceApp = path.resolve(path.dirname(sourceBinary), '..', '..');
  const stagedApp = path.join(scratchData, 'Supreme.app');
  cpSync(sourceApp, stagedApp, { recursive: true, verbatimSymlinks: true });
  electronBinary = path.join(stagedApp, 'Contents', 'MacOS', 'Supreme Community');
} else {
  electronBinary = path.join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');
}
const smokeCallback = 'conductor://auth/callback?code=desktop-smoke';
const electronArgs = packagedBinary ? ['--smoke-test', smokeCallback] : ['.', '--smoke-test', smokeCallback];
const timeoutMs = 45_000;

let processReady = false;
let uiReady = false;
let finished = false;
let timeout;

const child = spawn(electronBinary, electronArgs, {
  cwd: DESKTOP_DIR,
  env: {
    ...process.env,
    // Exercise the clean-laptop path: the service must be considered healthy
    // before Claude or ChatGPT credentials exist in the user's home folder.
    HOME: scratchData,
    CONDUCTOR_DESKTOP_PORT: '4788',
    CONDUCTOR_DESKTOP_SMOKE: '1',
    CONDUCTOR_DESKTOP_USER_DATA: path.join(scratchData, 'electron-profile'),
    WORKBENCH_HOME: scratchData,
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    WB_MODEL_USAGE_FIXTURE: '1',
    WB_PLAYS_FIXTURE: '1',
    WB_SCHEDULED: '0',
    SUPREME_CODEX_BINARY: path.join(DESKTOP_DIR, '..', 'scripts', 'test-bin', 'codex'),
    SUPREME_CLAUDE_BINARY: path.join(DESKTOP_DIR, '..', 'scripts', 'test-bin', 'claude'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function cleanup() {
  try { rmSync(scratchData, { recursive: true, force: true }); } catch { /* best effort */ }
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (!child.killed) child.kill('SIGTERM');
  cleanup();
  if (message) (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
}

function inspect(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  if (text.includes('CONDUCTOR_DESKTOP_READY')) processReady = true;
  if (text.includes('CONDUCTOR_DESKTOP_UI_READY')) uiReady = true;
}

child.stdout.on('data', inspect);
child.stderr.on('data', inspect);
child.on('error', (error) => finish(1, `Desktop smoke failed to launch: ${error.message}`));
child.on('exit', (code, signal) => {
  if (processReady && uiReady && code === 0) finish(0, 'Desktop smoke passed.');
  else finish(1, `Desktop smoke exited before full UI readiness (${signal || code || 0}).`);
});

timeout = setTimeout(() => finish(1, `Desktop smoke timed out after ${timeoutMs / 1000}s.`), timeoutMs);

process.on('SIGINT', () => finish(130, 'Desktop smoke interrupted.'));
process.on('SIGTERM', () => finish(143, 'Desktop smoke terminated.'));
