import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const output = new URL('../desktop/.generated/.env.local', import.meta.url);
function stage(env) {
  const result = spawnSync(process.execPath, ['desktop/scripts/stage-auth-config.mjs'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8');
}
try {
  const config = stage({ SUPABASE_URL: 'https://project.example.invalid', SUPABASE_ANON_KEY: 'public-fixture-key', SLACK_CLIENT_ID: 'fixture-client', SLACK_CLIENT_SECRET: 'never-bundle-this-sentinel', SUPABASE_SERVICE_ROLE_KEY: 'never-bundle-this-sentinel', TESTFLIGHT_INVITE_URL: '' });
  assert(config.includes('SUPABASE_URL=https://project.example.invalid'));
  assert(config.includes('SUPABASE_ANON_KEY=public-fixture-key'));
  assert(!config.includes('SLACK_'));
  assert(!config.includes('SERVICE_ROLE'));
  assert(!config.includes('never-bundle-this-sentinel'));
  console.log('PASS: desktop staging includes public config and excludes secrets.');
} finally {
  const local = stage({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '', TESTFLIGHT_INVITE_URL: '' });
  assert(!local.includes('SUPABASE_URL='));
  console.log('PASS: empty account settings produce a local-only bundle.');
}
