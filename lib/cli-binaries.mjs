import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP_BUNDLE_BINARIES = {
  codex: (home) => [
    path.join(home, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    path.join('/Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
  ],
};

// Codex Desktop updates its working CLI independently from the binary baked
// into Codex.app. Use that managed "current" binary first so Supreme shares
// the same auth refresh behavior as the Codex sessions the user is running.
const AUTO_UPDATED_BINARIES = {
  codex: (home) => [
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'),
  ],
};

const shellResolutionCache = new Map();

function addCandidate(list, seen, value, home) {
  let candidate = String(value || '').trim();
  if (!candidate) return;
  if (candidate === '~') candidate = home;
  else if (candidate.startsWith(`~${path.sep}`)) candidate = path.join(home, candidate.slice(2));
  if (!path.isAbsolute(candidate)) candidate = path.resolve(candidate);
  if (seen.has(candidate)) return;
  seen.add(candidate);
  list.push(candidate);
}

function executableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

// Desktop apps do not inherit the PATH assembled by an interactive shell.
// Resolve provider tools to absolute executables so status, auth, usage, and
// model runs all agree about what is installed. Codex.app ships the supported
// CLI inside its application bundle rather than a normal bin directory.
export function cliBinaryCandidates(binary, {
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const name = String(binary || '').trim();
  if (!name) return [];
  const candidates = [];
  const seen = new Set();
  const key = name.replace(/[^a-z0-9]/gi, '_').toUpperCase();

  addCandidate(candidates, seen, env[`SUPREME_${key}_BINARY`], home);
  addCandidate(candidates, seen, env[`WORKBENCH_${key}_BINARY`], home);

  if (path.isAbsolute(name) || name.includes(path.sep)) {
    addCandidate(candidates, seen, name, home);
    return candidates;
  }

  for (const candidate of AUTO_UPDATED_BINARIES[name]?.(home) || []) {
    addCandidate(candidates, seen, candidate, home);
  }

  // Prefer a native application's bundled CLI over guessed shell locations
  // when there is no auto-updated provider binary.
  // GUI launchers commonly add ~/.local/bin themselves, where an obsolete
  // wrapper can still look executable even though its shebang target is gone.
  if (platform === 'darwin') {
    for (const candidate of APP_BUNDLE_BINARIES[name]?.(home) || []) {
      addCandidate(candidates, seen, candidate, home);
    }
  }

  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (directory) addCandidate(candidates, seen, path.join(directory, name), home);
  }

  const shellManagedDirectories = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    env.NVM_BIN,
    env.PNPM_HOME,
  ];
  for (const directory of shellManagedDirectories) {
    if (directory) addCandidate(candidates, seen, path.join(directory, name), home);
  }

  return candidates;
}

function resolveFromLoginShell(binary, {
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  if (platform === 'win32') return null;
  const shell = String(env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')).trim();
  if (!path.isAbsolute(shell) || !executableFile(shell)) return null;

  const cacheKey = `${home}\0${shell}\0${binary}`;
  const cached = shellResolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.path || executableFile(cached.path)) return cached.path;
  }

  let resolved = null;
  try {
    const stdout = execFileSync(shell, ['-ilc', 'command -v "$1"', 'supreme-cli-resolver', binary], {
      encoding: 'utf8',
      timeout: 2_500,
      maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, HOME: home },
    });
    const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    resolved = lines.reverse().find((candidate) => path.isAbsolute(candidate) && executableFile(candidate)) || null;
  } catch {
    resolved = null;
  }
  shellResolutionCache.set(cacheKey, {
    path: resolved,
    expiresAt: Date.now() + (resolved ? 60_000 : 5_000),
  });
  return resolved;
}

export function resolveCliBinary(binary, options = {}) {
  const direct = cliBinaryCandidates(binary, options).find(executableFile) || null;
  if (direct || options.shellLookup === false) return direct;
  return resolveFromLoginShell(String(binary || '').trim(), options);
}
