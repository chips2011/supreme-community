// Run the original API acceptance suite against synthetic model CLIs only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'supreme-community-smoke-parent-'));
try {
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, WORKBENCH_HOME: scratch, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', WB_MODEL_USAGE_FIXTURE: '1', WB_PLAYS_FIXTURE: '1', WB_SCHEDULED: '0' },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status === 0 ? 0 : 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
