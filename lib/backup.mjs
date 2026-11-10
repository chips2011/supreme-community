// A daily copy of everything ~/.workbench holds, kept on this Mac.
//
// The cloud mirror (lib/sync.mjs) is a push that drops on failure and a
// Supabase plan that may or may not keep its own backups; until 2026-10-11
// the only local copy was one hand-made folder from August. So the service
// writes one bundle a day into ~/.workbench/backups: every top-level JSON
// file (repos, settings, schedules, plays, evals, push, email handoffs) and
// every workstream under tasks/, as their raw text, gzipped. Fourteen days
// are kept. scripts/restore-backup.mjs puts a bundle back.
//
// Attachments (images pasted into prompts) are not in the bundle; they do
// not compress and the transcript still reads without them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { DATA_DIR } from './store.mjs';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const KEEP = Math.max(1, Number(process.env.WB_BACKUP_KEEP || 14));
const FIRST_MS = Number(process.env.WB_BACKUP_FIRST_MS ?? 2 * 60_000);
const CHECK_MS = Number(process.env.WB_BACKUP_CHECK_MS ?? 60 * 60_000);
const ON = process.env.WB_BACKUP_OFF !== '1';
const NAME = /^workbench-(\d{4}-\d{2}-\d{2})\.json\.gz$/;

export function backupDir(home = DATA_DIR) {
  return path.join(home, 'backups');
}

// Named by the local calendar day, so "today's" means what the person means.
export function bundleName(at = new Date()) {
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return `workbench-${local.toISOString().slice(0, 10)}.json.gz`;
}

// Raw text of every file worth keeping, keyed by its path under the home.
export async function collect(home = DATA_DIR) {
  const files = {};
  const read = async (relative) => { files[relative] = await fs.promises.readFile(path.join(home, relative), 'utf8'); };
  for (const entry of await fs.promises.readdir(home, { withFileTypes: true })) {
    if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name)) await read(entry.name);
  }
  const tasks = path.join(home, 'tasks');
  if (fs.existsSync(tasks)) {
    for (const name of await fs.promises.readdir(tasks)) if (name.endsWith('.json')) await read(`tasks/${name}`);
  }
  return files;
}

export function listBackups(home = DATA_DIR) {
  const dir = backupDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => NAME.test(name))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      let bytes = 0;
      try { bytes = fs.statSync(file).size; } catch {}
      return { name, file, day: name.match(NAME)[1], bytes };
    });
}

function prune(home) {
  const extra = listBackups(home).slice(0, -KEEP);
  for (const old of extra) { try { fs.unlinkSync(old.file); } catch {} }
  return extra.length;
}

// One bundle for today. Reads are async and the gzip runs off the loop, so
// a run in flight feels nothing; the one synchronous step is the stringify
// (about 50ms for 30MB of workstreams).
export async function writeBackup({ home = DATA_DIR, at = new Date() } = {}) {
  const files = await collect(home);
  const count = Object.keys(files).length;
  if (!count) return null;
  const bundle = { version: 1, at: at.toISOString(), home, files };
  const packed = await gzip(Buffer.from(JSON.stringify(bundle)));
  const dir = backupDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, bundleName(at));
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, packed, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  const pruned = prune(home);
  return { file, bytes: packed.length, files: count, pruned };
}

export async function readBackup(file) {
  const bundle = JSON.parse((await gunzip(await fs.promises.readFile(file))).toString('utf8'));
  if (bundle?.version !== 1 || !bundle.files || typeof bundle.files !== 'object') throw new Error('not a Supreme backup bundle');
  return bundle;
}

// Puts every file in the bundle back under `home`, each through a temp file
// and a rename. Files the home has that the bundle does not are left alone.
export async function restore(file, { home = DATA_DIR } = {}) {
  const bundle = await readBackup(file);
  let written = 0;
  for (const [relative, text] of Object.entries(bundle.files)) {
    if (relative.includes('..') || path.isAbsolute(relative)) continue;
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, target);
    written += 1;
  }
  return { written, at: bundle.at };
}

let timer = null;
let inFlight = null;

export function status(home = DATA_DIR) {
  const backups = listBackups(home);
  const latest = backups.at(-1) || null;
  return { enabled: ON, dir: backupDir(home), count: backups.length, latest: latest ? { day: latest.day, bytes: latest.bytes } : null, keep: KEEP };
}

// Once today's bundle exists nothing more happens until tomorrow; a Mac
// that was shut all day writes one a couple of minutes after the next boot.
export function tick(home = DATA_DIR) {
  if (!ON || inFlight) return inFlight;
  if (fs.existsSync(path.join(backupDir(home), bundleName()))) return null;
  inFlight = writeBackup({ home })
    .then((result) => { if (result) console.info(`[backup] ${path.basename(result.file)}: ${result.files} files, ${Math.round(result.bytes / 1024)}KB${result.pruned ? `, ${result.pruned} old bundle(s) removed` : ''}`); })
    .catch((err) => console.error('[backup] failed:', err.message))
    .finally(() => { inFlight = null; });
  return inFlight;
}

export function start(home = DATA_DIR) {
  if (!ON || timer) return;
  setTimeout(() => { void tick(home); }, FIRST_MS).unref?.();
  timer = setInterval(() => { void tick(home); }, CHECK_MS);
  timer.unref?.();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}
