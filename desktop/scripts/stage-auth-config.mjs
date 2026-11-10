import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP_DIR, '..');
const OUTPUT_DIR = path.join(DESKTOP_DIR, '.generated');
const OUTPUT_FILE = path.join(OUTPUT_DIR, '.env.local');
// Only non-secret account configuration may be copied into a desktop bundle.
const PUBLIC_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TESTFLIGHT_INVITE_URL'];
const REQUIRED_PUBLIC_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

function readEnvFile(file) {
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
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (PUBLIC_KEYS.includes(key)) values[key] = value;
  }
  return values;
}

const fileValues = {
  ...readEnvFile(path.join(ROOT, '.env')),
  ...readEnvFile(path.join(ROOT, '.env.local')),
};
const values = Object.fromEntries(PUBLIC_KEYS.map((key) => [key, process.env[key] || fileValues[key] || '']));
const configured = REQUIRED_PUBLIC_KEYS.every((key) => values[key]);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const output = configured
  ? `${PUBLIC_KEYS.filter((key) => values[key]).map((key) => `${key}=${values[key]}`).join('\n')}\n`
  : '# Supabase accounts are not configured for this build.\n';
fs.writeFileSync(OUTPUT_FILE, output, { mode: 0o600 });
console.log(`Desktop account configuration staged: ${configured ? 'configured' : 'disabled'}.`);
