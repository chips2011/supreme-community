import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'supreme-deep-link-smoke-'));
const packaged = process.env.CONDUCTOR_ELECTRON_BINARY;
let binary = path.join(desktop, 'node_modules/.bin/electron');
if (packaged) {
  const app = path.resolve(path.dirname(packaged), '../..');
  const staged = path.join(scratch, 'Supreme.app');
  cpSync(app, staged, { recursive: true, verbatimSymlinks: true });
  binary = path.join(staged, 'Contents/MacOS/Supreme');
}
const fixtures = path.join(root, 'scripts/test-bin');
const args = [...(packaged ? [] : ['.']), '--smoke-test', '--deep-link-smoke'];
const child = spawn(binary, args, { cwd: desktop, env: { ...process.env,
  HOME: scratch, WORKBENCH_HOME: scratch,
  CONDUCTOR_DESKTOP_PORT: '4791', CONDUCTOR_DESKTOP_SMOKE: '1',
  CONDUCTOR_DESKTOP_USER_DATA: path.join(scratch, 'electron-profile'),
  SUPABASE_URL: '', SUPABASE_ANON_KEY: '', TESTFLIGHT_INVITE_URL: '',
  WB_MODEL_USAGE_FIXTURE: '1', WB_TABMAIL_WAKE: '0', WB_SCHEDULED: '0',
  SUPREME_CLI_UPDATE_MS: '0', SUPREME_CLAUDE_BINARY: path.join(fixtures, 'claude'),
  SUPREME_CODEX_BINARY: path.join(fixtures, 'codex'),
}, stdio: ['ignore', 'pipe', 'pipe'] });
let passed = false;
let timedOut = false;
const inspect = chunk => { const text = chunk.toString(); process.stdout.write(text); if (text.includes('SUPREME DEEP LINK SMOKE: PASS (7 checks)')) passed = true; };
child.stdout.on('data', inspect);
child.stderr.on('data', inspect);
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
child.on('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  process.exitCode = code === 0 && passed && !timedOut ? 0 : 1;
  console.log(process.exitCode ? 'Desktop deep-link smoke FAILED' : 'Desktop deep-link smoke passed.');
});
