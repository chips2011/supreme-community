import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'supreme-community-unit-'));
const tests = [
  'scripts/community-config-test.mjs',
  'scripts/community-links-test.mjs',
  'scripts/handoff-test.mjs', 'scripts/confirmation-test.mjs',
  'scripts/browser-connection-test.mjs', 'scripts/browser-connection-ui-test.mjs',
  'scripts/output-formatting-test.mjs', 'scripts/landed-keyboard-test.mjs',
  'scripts/slack-context-test.mjs', 'scripts/slack-people-test.mjs',
  'scripts/landed-slack-test.mjs', 'scripts/codex-browser-runtime-test.mjs',
  'scripts/slack-inbox-test.mjs', 'scripts/slack-thread-follow-test.mjs',
  'desktop/scripts/open-thread-links-test.mjs',
];
let failed = 0;
try {
  for (const test of tests) {
    const result = spawnSync(process.execPath, [test], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, WORKBENCH_HOME: scratch, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', WB_MODEL_USAGE_FIXTURE: '1' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status === 0) console.log(`PASS ${test}`);
    else { failed++; console.error(`FAIL ${test}\n${result.stdout}\n${result.stderr}\n${result.error || ''}`); }
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${tests.length - failed}/${tests.length} test suites passed.`);
process.exitCode = failed ? 1 : 0;
