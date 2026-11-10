// Git worktree operations for Conductor tasks. Each task lives on its own
// branch in its own worktree, so any number of agents can edit the same repo
// in parallel without stepping on each other. Everything shells out to git.

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const WORKTREES_DIR = path.join(process.env.WORKBENCH_HOME || path.join(os.homedir(), '.workbench'), 'worktrees');
const MANAGED_PROJECTS_DIR = path.join(process.env.WORKBENCH_HOME || path.join(os.homedir(), '.workbench'), 'projects');
fs.mkdirSync(WORKTREES_DIR, { recursive: true });
fs.mkdirSync(MANAGED_PROJECTS_DIR, { recursive: true });

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error((stderr || err.message).trim()));
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Is `dir` the top level of a git repo? Returns the toplevel path or null.
export async function repoRoot(dir) {
  try {
    const { stdout } = await git(dir, ['rev-parse', '--show-toplevel']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function currentBranch(repo) {
  const { stdout } = await git(repo, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
  return stdout.trim() || 'main';
}

export async function listBranches(repo) {
  const { stdout } = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function hasRemote(repo) {
  const { stdout } = await git(repo, ['remote'], { allowFail: true });
  return !!stdout.trim();
}

function slug(s) {
  return (s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
}

// Non-coding projects are name-first in the product. Internally we still keep
// a tiny managed git repository so the existing task/worktree isolation model
// works without ever asking the user for a filesystem path.
export async function createManagedProject({ name, id }) {
  // The id names a folder under the data dir. Local ids are UUIDs; one that
  // arrived through sync is checked the same way before it touches a path.
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('bad project id');
  const repo = path.join(MANAGED_PROJECTS_DIR, `${slug(name || 'project')}-${String(id).slice(0, 8)}`);
  if (fs.existsSync(repo)) {
    const existing = await repoRoot(repo);
    if (existing) return fs.realpathSync(existing);
    // A directory left behind by an earlier attempt that failed before git
    // could initialise it (a new Mac whose Command Line Tools were still
    // installing): finish the job in place rather than refusing forever.
    if (fs.readdirSync(repo).length) throw new Error('managed project storage exists but is not usable');
  } else {
    fs.mkdirSync(repo, { recursive: false, mode: 0o700 });
  }
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, [
    '-c', 'user.name=Workbench',
    '-c', 'user.email=workbench@local',
    'commit', '--allow-empty', '-m', 'Initialize project',
  ]);
  // Keep the project path identical to the canonical path returned by git.
  // This matters on macOS where /tmp resolves to /private/tmp; otherwise a
  // freshly-created thread can become detached from its project in the rail.
  return fs.realpathSync(repo);
}

// Create an isolated worktree + branch for a task. Returns {branch, worktreePath, base}.
export async function createWorktree({ repo, title, base, id }) {
  // The base goes into git's argv as a ref name; a leading dash would read
  // as an option (`--detach` made it through worktree add and was later
  // run as `git checkout --detach` in the person's main checkout).
  if (base != null && base !== '' && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(base))) throw new Error('bad base branch');
  const baseRef = base || (await currentBranch(repo));
  const branch = `conductor/${slug(title)}-${id.slice(0, 6)}`;
  const worktreePath = path.join(WORKTREES_DIR, id);
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  return { branch, worktreePath, base: baseRef };
}

// Everything the agent changed in the worktree vs its base: a unified diff plus
// a per-file summary. Intent-to-add makes brand-new files show up in the diff.
export async function worktreeDiff(worktreePath, base) {
  if (!fs.existsSync(worktreePath)) return { files: [], patch: '', stat: '' };
  await git(worktreePath, ['add', '-A', '-N'], { allowFail: true });
  const mergeBase = (await git(worktreePath, ['merge-base', base, 'HEAD'], { allowFail: true })).stdout.trim() || base;
  const stat = (await git(worktreePath, ['--no-pager', 'diff', '--stat', mergeBase], { allowFail: true })).stdout;
  const patch = (await git(worktreePath, ['--no-pager', 'diff', mergeBase], { allowFail: true })).stdout;
  const nameStatus = (await git(worktreePath, ['--no-pager', 'diff', '--name-status', mergeBase], { allowFail: true })).stdout;
  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status.trim(), file: rest.join('\t').trim() };
    });
  return { files, patch, stat };
}

// True if the worktree has anything uncommitted.
export async function isDirty(worktreePath) {
  const { stdout } = await git(worktreePath, ['status', '--porcelain'], { allowFail: true });
  return !!stdout.trim();
}

// Commit whatever the agent left in the worktree.
export async function commitAll(worktreePath, message) {
  await git(worktreePath, ['add', '-A']);
  const dirty = await isDirty(worktreePath);
  if (!dirty) return { committed: false };
  await git(worktreePath, ['commit', '-m', message || 'conductor: task changes']);
  return { committed: true };
}

// Merge a task's branch back into its base branch in the main repo.
export async function mergeToBase({ repo, branch, base, message }) {
  // Merging switches/updates the main checkout, so refuse if the user has
  // uncommitted work there rather than moving it around under them.
  if (await isDirty(repo)) {
    throw new Error(`the ${path.basename(repo)} checkout has uncommitted changes — commit or stash them first, or use Open PR instead`);
  }
  const cur = await currentBranch(repo);
  // The base branch may be checked out in the main repo; if not, check it out.
  if (cur !== base) {
    const r = await git(repo, ['checkout', base], { allowFail: true });
    if (r.code !== 0) throw new Error(`could not check out ${base}: ${r.stderr.trim()}`);
  }
  const r = await git(repo, ['merge', '--no-ff', '-m', message || `Merge ${branch}`, branch], { allowFail: true });
  if (r.code !== 0) {
    // Leave the conflicted state for the user rather than guessing.
    throw new Error(`merge conflict or failure: ${(r.stderr || r.stdout).trim()}`);
  }
  return { ok: true };
}

// Push the branch and open a PR with gh, if a remote and gh are available.
export async function openPr({ repo, branch, base, title, body }) {
  const push = await git(repo, ['push', '-u', 'origin', branch], { allowFail: true });
  if (push.code !== 0) throw new Error(`push failed: ${push.stderr.trim()}`);
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['pr', 'create', '--repo', '.', '--base', base, '--head', branch, '--title', title || branch, '--body', body || ''],
      { cwd: repo },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve({ url: stdout.trim() });
      }
    );
  });
}

// Tear down a task's worktree and delete its branch.
export async function removeWorktree({ repo, worktreePath, branch }) {
  await git(repo, ['worktree', 'remove', worktreePath, '--force'], { allowFail: true });
  if (branch) await git(repo, ['branch', '-D', branch], { allowFail: true });
  // Clean up any stale worktree admin entry.
  await git(repo, ['worktree', 'prune'], { allowFail: true });
}

export { WORKTREES_DIR };
