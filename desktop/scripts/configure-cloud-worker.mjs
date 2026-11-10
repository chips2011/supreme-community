import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP_DIR, '..');
const SERVICE = 'com.meetsupreme.community.cloud-worker';
const ACCOUNTS = {
  FLY_API_TOKEN: 'api-token',
  FLY_APP: 'fly-app',
  WORKER_IMAGE: 'worker-image',
  FLY_REGION: 'fly-region',
};

function readEnv(file) {
  let source = '';
  try { source = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const values = {};
  for (const raw of source.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!(key in ACCOUNTS)) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

if (process.platform !== 'darwin') throw new Error('Cloud-worker Keychain setup is available on macOS only.');
const values = {
  ...readEnv(path.join(ROOT, '.env')),
  ...readEnv(path.join(ROOT, '.env.local')),
};
if (!values.FLY_API_TOKEN || !values.WORKER_IMAGE) {
  throw new Error('FLY_API_TOKEN and WORKER_IMAGE must be present in the checkout environment first.');
}

const configured = [];
for (const [key, account] of Object.entries(ACCOUNTS)) {
  const value = process.env[key] || values[key];
  if (!value) continue;
  const result = spawnSync('/usr/bin/security', [
    'add-generic-password', '-U',
    '-a', account,
    '-s', SERVICE,
    '-l', `Supreme cloud worker · ${key}`,
    '-w', value,
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status !== 0) throw new Error(`Could not store ${key} in macOS Keychain.`);
  configured.push(key);
}

console.log(`Supreme cloud-worker configuration stored securely (${configured.join(', ')}).`);
