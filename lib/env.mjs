// Minimal zero-dep .env loader. Reads <repo>/.env then <repo>/.env.local (if
// present) and sets any vars not already in the environment. Imported for its
// side effect at the top of server.mjs so Supabase keys are available before
// anything reads them. Real shell env always wins over the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // lib/ -> repo root

for (const name of ['.env', '.env.local']) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, name), 'utf8'); } catch { continue; }
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
