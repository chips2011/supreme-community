// Which Codex this Mac runs, read from `codex --version` ("codex-cli 0.160.0").
// A retired model moves to its replacement only once the Codex here can run
// it (providers.mjs minCodex, currentModelId). One read per binary: an update
// lands as a new file (the standalone's `current` points at a new release),
// so the real path, size and time say when to read again.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

let known = { key: null, version: null };
let reading = null;

function keyFor(file) {
  try {
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    return `${real}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

export function parseCodexVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function versionAtLeast(version, min) {
  const want = Array.isArray(min) ? min : parseCodexVersion(min);
  if (!version || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== want[i]) return version[i] > want[i];
  }
  return true;
}

export async function codexVersion(file) {
  const key = file ? keyFor(file) : null;
  if (!key) return null;
  if (key === known.key) return known.version;
  if (reading?.key === key) return reading.promise;
  const promise = new Promise((resolve) => {
    const child = execFile(file, ['--version'], { timeout: 5_000 }, (err, stdout) => resolve(err ? null : parseCodexVersion(stdout)));
    child.stdin?.end();
  }).then((version) => {
    known = { key, version };
    if (reading?.key === key) reading = null;
    return version;
  });
  reading = { key, promise };
  return promise;
}

// The last version read for this binary, without waiting. A binary not read
// yet starts a read and answers null until it lands.
export function codexVersionKnown(file) {
  const key = file ? keyFor(file) : null;
  if (!key) return null;
  if (key === known.key) return known.version;
  codexVersion(file).catch(() => {});
  return null;
}
