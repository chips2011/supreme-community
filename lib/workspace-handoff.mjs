// Portable, private workspace snapshots for cloud handoff. The source Mac
// uploads the task worktree before the worker starts. The worker restores that
// snapshot, works inside it, then uploads a return snapshot before stopping.
//
// Only tracked files and untracked, non-ignored files are included. Credentials,
// local model state, dependency folders, and common generated output are always
// excluded even if a repository accidentally tracks them.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './store.mjs';
import * as supabase from './supabase.mjs';

const execFileAsync = promisify(execFile);
const BUCKET = 'workspace-snapshots';
const VERSION = 1;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const HANDOFF_ROOT = path.join(DATA_DIR, 'handoffs');
const RUNTIME_ROOT = path.join(HANDOFF_ROOT, 'runtime');

const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg', '.codex', '.claude',
  'node_modules', '.next', '.nuxt', '.turbo', '.cache', 'coverage',
  'DerivedData', 'Pods', 'vendor', 'dist', 'build',
]);
const SECRET_EXTENSIONS = new Set([
  '.key', '.pem', '.p8', '.p12', '.pfx', '.mobileprovision', '.cer', '.crt',
]);
const SECRET_NAMES = new Set([
  'credentials.json', 'auth.json', 'service-account.json', '.npmrc', '.netrc',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRelative(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) return null;
  const clean = path.posix.normalize(normalized);
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) return null;
  return clean;
}

function isSafeRelative(value) {
  const relative = normalizeRelative(value);
  if (!relative) return false;
  const parts = relative.split('/');
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;
  const name = parts.at(-1) || '';
  const lower = name.toLowerCase();
  if ((lower === '.env' || lower.startsWith('.env.'))
      && !['.env.example', '.env.sample', '.env.template'].includes(lower)) return false;
  if (SECRET_NAMES.has(lower) || SECRET_EXTENSIONS.has(path.extname(lower))) return false;
  if (/^(?:id_rsa|id_ed25519|authkey_)/i.test(name)) return false;
  return true;
}

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function assertNoSymlinkParents(root, candidate) {
  const relative = path.relative(path.resolve(root), path.dirname(path.resolve(candidate)));
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error('workspace path crosses a symbolic link');
    }
  }
}

async function gitFiles(root) {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function walkedFiles(root) {
  const output = [];
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isSafeRelative(relative)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, relative);
      else output.push(relative);
    }
  };
  visit(root);
  return output;
}

function safeSymlink(root, source, target) {
  if (!target || path.isAbsolute(target)) return false;
  return inside(root, path.resolve(path.dirname(source), target));
}

export async function inventoryWorkspace(root) {
  const canonical = fs.realpathSync(root);
  const candidates = (await gitFiles(canonical)) || walkedFiles(canonical);
  const unique = [...new Set(candidates.map(normalizeRelative).filter(Boolean))].sort();
  const files = [];
  let totalBytes = 0;
  for (const relative of unique) {
    if (!isSafeRelative(relative)) continue;
    const source = path.join(canonical, ...relative.split('/'));
    if (!inside(canonical, source) || !fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(source);
      if (!safeSymlink(canonical, source, linkTarget)) continue;
      files.push({ path: relative, type: 'symlink', mode: stat.mode & 0o777, linkTarget });
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`${relative} is larger than the 25 MB handoff limit`);
    }
    const content = fs.readFileSync(source);
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('this workspace is too large to hand off safely');
    files.push({
      path: relative,
      type: 'file',
      mode: stat.mode & 0o777,
      size: content.length,
      sha256: sha256(content),
    });
    if (files.length > MAX_FILES) throw new Error('this workspace has too many files to hand off safely');
  }
  return { root: canonical, files, totalBytes };
}

function copyEntry(sourceRoot, destinationRoot, entry) {
  const source = path.join(sourceRoot, ...entry.path.split('/'));
  const destination = path.join(destinationRoot, ...entry.path.split('/'));
  if (!inside(destinationRoot, destination)) throw new Error('unsafe workspace path');
  assertNoSymlinkParents(destinationRoot, destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (entry.type === 'symlink') {
    if (!safeSymlink(destinationRoot, destination, entry.linkTarget)) throw new Error('unsafe workspace symlink');
    fs.symlinkSync(entry.linkTarget, destination);
    return;
  }
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, entry.mode || 0o600);
}

async function gitHead(root) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function createArchive({ root, taskId, kind, parentId = null }) {
  const inventory = await inventoryWorkspace(root);
  const id = crypto.randomUUID();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'supreme-workspace-'));
  const stage = path.join(temp, 'stage');
  const workspace = path.join(stage, 'workspace');
  const archivePath = path.join(temp, `${id}.tgz`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const entry of inventory.files) copyEntry(inventory.root, workspace, entry);
  const manifest = {
    version: VERSION,
    id,
    taskId,
    kind,
    parentId,
    createdAt: new Date().toISOString(),
    head: await gitHead(root),
    totalBytes: inventory.totalBytes,
    files: inventory.files,
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await execFileAsync('tar', ['-czf', archivePath, '-C', stage, 'manifest.json', 'workspace'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const archive = fs.readFileSync(archivePath);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('the compressed workspace is larger than the 50 MB handoff limit');
  return {
    archive,
    manifest,
    digest: sha256(archive),
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}

function encodedObjectPath(objectPath) {
  return objectPath.split('/').map(encodeURIComponent).join('/');
}

async function storageRequest(objectPath, { method = 'GET', token, body } = {}) {
  const { url, anonKey, configured } = supabase.config();
  if (!configured || !token) throw new Error('sign in before handing off a workspace');
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodedObjectPath(objectPath)}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/gzip', 'x-upsert': 'false' } : {}),
    },
    body,
    // A workspace archive can be large; ten minutes, not forever on a
    // stalled socket.
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`workspace storage returned ${response.status}${detail ? `: ${detail.slice(0, 220)}` : ''}`);
  }
  return response;
}

function assertOwnedObject(objectPath, userId, taskId) {
  const prefix = `${userId}/${taskId}/`;
  if (!objectPath || !objectPath.startsWith(prefix) || objectPath.includes('..')) {
    throw new Error('invalid workspace snapshot path');
  }
}

export async function uploadWorkspaceSnapshot({ root, taskId, token, userId, kind, parentId = null }) {
  if (!userId || !taskId) throw new Error('workspace handoff is missing its owner or thread');
  const created = await createArchive({ root, taskId, kind, parentId });
  const objectPath = `${userId}/${taskId}/${created.manifest.id}.tgz`;
  try {
    await storageRequest(objectPath, { method: 'POST', token, body: created.archive });
    return {
      version: VERSION,
      id: created.manifest.id,
      taskId,
      kind,
      parentId,
      objectPath,
      digest: created.digest,
      createdAt: created.manifest.createdAt,
      head: created.manifest.head,
      fileCount: created.manifest.files.length,
      totalBytes: created.manifest.totalBytes,
      archiveBytes: created.archive.length,
    };
  } finally {
    created.cleanup();
  }
}

export async function deleteWorkspaceSnapshot(meta, { token, userId, taskId }) {
  if (!meta?.objectPath) return;
  assertOwnedObject(meta.objectPath, userId, taskId);
  await storageRequest(meta.objectPath, { method: 'DELETE', token });
}

async function downloadAndExtract(meta, { token, userId, taskId }) {
  if (!meta?.objectPath || !meta?.digest) throw new Error('workspace snapshot is incomplete');
  assertOwnedObject(meta.objectPath, userId, taskId);
  const response = await storageRequest(meta.objectPath, { token });
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES || sha256(archive) !== meta.digest) {
    throw new Error('workspace snapshot failed its integrity check');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'supreme-workspace-open-'));
  const archivePath = path.join(temp, 'snapshot.tgz');
  const extracted = path.join(temp, 'extracted');
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  fs.mkdirSync(extracted, { mode: 0o700 });
  const { stdout } = await execFileAsync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  for (const item of stdout.split('\n').filter(Boolean)) {
    const clean = item.endsWith('/') ? item.slice(0, -1) : item;
    if (clean === 'manifest.json' || clean === 'workspace') continue;
    if (!clean.startsWith('workspace/') || !isSafeRelative(clean.slice('workspace/'.length))) {
      throw new Error('workspace snapshot contains an unsafe path');
    }
  }
  await execFileAsync('tar', ['-xzf', archivePath, '-C', extracted], { maxBuffer: 4 * 1024 * 1024 });
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'manifest.json'), 'utf8'));
  if (manifest.version !== VERSION || manifest.id !== meta.id || manifest.taskId !== taskId) {
    throw new Error('workspace snapshot manifest does not match this thread');
  }
  const workspace = path.join(extracted, 'workspace');
  for (const entry of manifest.files || []) {
    if (!isSafeRelative(entry.path)) throw new Error('workspace manifest contains an unsafe path');
    const file = path.join(workspace, ...entry.path.split('/'));
    if (!inside(workspace, file) || !fs.existsSync(file)) throw new Error(`workspace snapshot is missing ${entry.path}`);
    const stat = fs.lstatSync(file);
    if (entry.type === 'symlink') {
      if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== entry.linkTarget || !safeSymlink(workspace, file, entry.linkTarget)) {
        throw new Error(`workspace snapshot has an invalid link at ${entry.path}`);
      }
    } else if (!stat.isFile() || sha256(fs.readFileSync(file)) !== entry.sha256) {
      throw new Error(`workspace snapshot failed verification at ${entry.path}`);
    }
  }
  return { manifest, workspace, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function runtimeStatePath(taskId) {
  return path.join(RUNTIME_ROOT, `${taskId}.json`);
}

export function runtimeWorkspacePath(task) {
  if (process.env.WB_RUNNER_KIND !== 'cloud' || !task?.id) return task?.worktreePath || task?.cwd || '';
  try {
    const state = JSON.parse(fs.readFileSync(runtimeStatePath(task.id), 'utf8'));
    if (state?.path && fs.existsSync(state.path)) return state.path;
  } catch {}
  return task?.worktreePath || task?.cwd || '';
}

export async function hydrateCloudWorkspace({ task, token, userId }) {
  const source = task?.cloudHandoff?.workspace?.source;
  if (!task?.id || !source) throw new Error('the handed-off thread has no workspace snapshot');
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  const existingState = runtimeStatePath(task.id);
  try {
    const state = JSON.parse(fs.readFileSync(existingState, 'utf8'));
    if (state.sourceId === source.id && state.path && fs.existsSync(state.path)) return state.path;
  } catch {}

  const opened = await downloadAndExtract(source, { token, userId, taskId: task.id });
  const destination = path.join(RUNTIME_ROOT, task.id);
  try {
    if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
      throw new Error('the cloud workspace already exists but does not match this handoff');
    }
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of opened.manifest.files) copyEntry(opened.workspace, destination, entry);
    await execFileAsync('git', ['-C', destination, 'init', '--initial-branch=main']);
    await execFileAsync('git', ['-C', destination, 'config', 'user.name', 'Supreme Cloud']);
    await execFileAsync('git', ['-C', destination, 'config', 'user.email', 'cloud@meetsupreme.com']);
    await execFileAsync('git', ['-C', destination, 'add', '-A']);
    await execFileAsync('git', ['-C', destination, 'commit', '--allow-empty', '-m', 'Supreme handoff baseline']);
    fs.writeFileSync(existingState, JSON.stringify({ sourceId: source.id, path: destination }), { mode: 0o600 });
    return destination;
  } finally {
    opened.cleanup();
  }
}

export async function captureCloudWorkspace({ task, token, userId }) {
  const source = task?.cloudHandoff?.workspace?.source;
  if (!source) throw new Error('the cloud thread has no source workspace snapshot');
  const root = runtimeWorkspacePath(task);
  if (!root || !fs.existsSync(root)) throw new Error('the cloud workspace is unavailable');
  return uploadWorkspaceSnapshot({
    root,
    taskId: task.id,
    token,
    userId,
    kind: 'return',
    parentId: source.id,
  });
}

function entrySignature(entry) {
  if (!entry) return '';
  return entry.type === 'symlink'
    ? `link:${entry.linkTarget}:${entry.mode || 0}`
    : `file:${entry.sha256}:${entry.mode || 0}`;
}

function entryMap(manifest) {
  return new Map((manifest?.files || []).map((entry) => [entry.path, entry]));
}

function entryAt(root, relative) {
  const candidate = path.join(root, ...relative.split('/'));
  if (!inside(root, candidate) || !fs.existsSync(candidate)) return null;
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) {
    return { path: relative, type: 'symlink', mode: stat.mode & 0o777, linkTarget: fs.readlinkSync(candidate) };
  }
  if (!stat.isFile()) return { path: relative, type: 'directory', mode: stat.mode & 0o777 };
  const content = fs.readFileSync(candidate);
  return { path: relative, type: 'file', mode: stat.mode & 0o777, sha256: sha256(content) };
}

function stageReturnedWorkspace(taskId, returned) {
  const destination = path.join(HANDOFF_ROOT, 'returns', taskId, returned.manifest.id);
  const workspace = path.join(destination, 'workspace');
  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const entry of returned.manifest.files) copyEntry(returned.workspace, workspace, entry);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(returned.manifest, null, 2), { mode: 0o600 });
  }
  return destination;
}

function backupChangedPaths(root, paths, handoffId) {
  const destination = path.join(HANDOFF_ROOT, 'backups', handoffId);
  const filesRoot = path.join(destination, 'files');
  fs.mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  for (const relative of paths) {
    const source = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    const entry = stat.isSymbolicLink()
      ? { path: relative, type: 'symlink', mode: stat.mode & 0o777, linkTarget: fs.readlinkSync(source) }
      : { path: relative, type: 'file', mode: stat.mode & 0o777 };
    if (stat.isFile()) entry.sha256 = sha256(fs.readFileSync(source));
    copyEntry(root, filesRoot, entry);
  }
  fs.writeFileSync(path.join(destination, 'paths.json'), JSON.stringify(paths, null, 2), { mode: 0o600 });
  return destination;
}

function removeEntry(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

function applyReturnedEntries(root, returned, changedPaths) {
  const remote = entryMap(returned.manifest);
  for (const relative of changedPaths) {
    const target = path.join(root, ...relative.split('/'));
    if (!inside(root, target)) throw new Error('unsafe return path');
    assertNoSymlinkParents(root, target);
    const entry = remote.get(relative);
    if (!entry) {
      removeEntry(target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    removeEntry(target);
    copyEntry(returned.workspace, root, entry);
  }
}

export async function restoreReturnedWorkspace({ task, token, userId }) {
  const workspaceMeta = task?.cloudHandoff?.workspace;
  const sourceMeta = workspaceMeta?.source;
  const returnMeta = workspaceMeta?.returned;
  if (!sourceMeta || !returnMeta) throw new Error('Supreme Cloud did not return a workspace snapshot');
  if (returnMeta.parentId !== sourceMeta.id) throw new Error('the returned workspace belongs to a different handoff');
  const originalValue = workspaceMeta.originalWorktreePath || task.worktreePath;
  if (!originalValue || !fs.existsSync(originalValue)) throw new Error('the original worktree is no longer on this Mac');
  const original = fs.realpathSync(originalValue);

  const [source, returned] = await Promise.all([
    downloadAndExtract(sourceMeta, { token, userId, taskId: task.id }),
    downloadAndExtract(returnMeta, { token, userId, taskId: task.id }),
  ]);
  try {
    const base = entryMap(source.manifest);
    const remote = entryMap(returned.manifest);
    const changedPaths = [...new Set([...base.keys(), ...remote.keys()])]
      .filter((relative) => entrySignature(base.get(relative)) !== entrySignature(remote.get(relative)))
      .sort();
    const conflicts = changedPaths.filter((relative) => {
      const baseSig = entrySignature(base.get(relative));
      const localSig = entrySignature(entryAt(original, relative));
      const remoteSig = entrySignature(remote.get(relative));
      return localSig !== baseSig && localSig !== remoteSig;
    });
    if (conflicts.length) {
      const stagedPath = stageReturnedWorkspace(task.id, returned);
      return { mode: 'staged', changedFiles: changedPaths.length, conflicts, stagedPath };
    }
    if (!changedPaths.length) return { mode: 'unchanged', changedFiles: 0, conflicts: [] };
    const backupPath = backupChangedPaths(original, changedPaths, returnMeta.id);
    applyReturnedEntries(original, returned, changedPaths);
    return { mode: 'applied', changedFiles: changedPaths.length, conflicts: [], backupPath };
  } finally {
    source.cleanup();
    returned.cleanup();
  }
}

export const WORKSPACE_HANDOFF_BUCKET = BUCKET;
