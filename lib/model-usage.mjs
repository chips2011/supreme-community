import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { resolveCliBinary } from './cli-binaries.mjs';

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_MS = 30_000;

let cache = { at: 0, value: null, pending: null };

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function isoFromSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function publicFailure(provider, message) {
  return {
    provider,
    available: false,
    fetchedAt: new Date().toISOString(),
    windows: [],
    message,
  };
}

function claudeWindowLabel(limit) {
  if (limit.kind === 'session') return 'Current session';
  if (limit.kind === 'weekly_all') return 'Weekly · all models';
  if (limit.kind === 'weekly_scoped') {
    const model = String(limit.scope?.model?.display_name || '').trim();
    return model ? `Weekly · ${model}` : 'Weekly · scoped model';
  }
  return String(limit.kind || 'Usage limit').replaceAll('_', ' ');
}

function normalizeClaudeUsage(raw) {
  let windows = Array.isArray(raw?.limits)
    ? raw.limits.flatMap((limit) => {
      const usedPercent = percent(limit?.percent);
      if (usedPercent == null) return [];
      return [{
        id: String(limit.kind || limit.group || 'limit'),
        label: claudeWindowLabel(limit),
        usedPercent,
        resetsAt: limit.resets_at || null,
        scopeModel: limit.scope?.model?.display_name || null,
      }];
    })
    : [];

  // Older Claude usage responses predate the normalized `limits` array.
  if (!windows.length) {
    const fallbacks = [
      ['session', 'Current session', raw?.five_hour],
      ['weekly_all', 'Weekly · all models', raw?.seven_day],
      ['weekly_opus', 'Weekly · Opus', raw?.seven_day_opus],
      ['weekly_sonnet', 'Weekly · Sonnet', raw?.seven_day_sonnet],
    ];
    windows = fallbacks.flatMap(([id, label, value]) => {
      const usedPercent = percent(value?.utilization);
      return usedPercent == null ? [] : [{ id, label, usedPercent, resetsAt: value?.resets_at || null }];
    });
  }

  const spend = raw?.spend;
  const extra = raw?.extra_usage;
  const credits = spend || extra ? {
    enabled: spend?.enabled ?? extra?.is_enabled ?? false,
    usedMinor: Number.isFinite(Number(spend?.used?.amount_minor))
      ? Number(spend.used.amount_minor)
      : Number.isFinite(Number(extra?.used_credits)) ? Number(extra.used_credits) : null,
    limitMinor: Number.isFinite(Number(spend?.limit?.amount_minor))
      ? Number(spend.limit.amount_minor)
      : Number.isFinite(Number(extra?.monthly_limit)) ? Number(extra.monthly_limit) : null,
    currency: spend?.limit?.currency || spend?.used?.currency || extra?.currency || 'USD',
    exponent: Number.isFinite(Number(spend?.limit?.exponent))
      ? Number(spend.limit.exponent)
      : Number.isFinite(Number(extra?.decimal_places)) ? Number(extra.decimal_places) : 2,
  } : null;

  return {
    provider: 'claude',
    available: windows.length > 0 || !!credits,
    source: 'Claude account',
    fetchedAt: new Date().toISOString(),
    windows,
    credits,
  };
}

async function fetchClaudeUsage() {
  let credentials = null;

  // Current Claude Code releases keep the OAuth payload in macOS Keychain.
  // Prefer that entry so a newly connected account is visible immediately,
  // then retain the legacy file as a compatibility fallback for older installs
  // and non-macOS workers. The token is kept in this function and never logged,
  // cached in Supreme state, or returned to the renderer.
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s', CLAUDE_KEYCHAIN_SERVICE,
        '-w',
      ], {
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      credentials = JSON.parse(raw);
    } catch {
      // Fall through to the older on-disk credential location.
    }
  }
  if (!credentials) {
    try {
      credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    } catch {
      return publicFailure('claude', 'Connect Claude to see live usage.');
    }
  }
  const accessToken = credentials?.claudeAiOauth?.accessToken;
  if (!accessToken) return publicFailure('claude', 'Connect Claude to see live usage.');

  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(7_000),
    });
    if (response.status === 401 || response.status === 403) {
      return publicFailure('claude', 'Reconnect Claude to refresh live usage.');
    }
    if (!response.ok) return publicFailure('claude', 'Claude usage is temporarily unavailable.');
    return normalizeClaudeUsage(await response.json());
  } catch {
    return publicFailure('claude', 'Claude usage is temporarily unavailable.');
  }
}

function readCodexRateLimits() {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliBinary('codex') || 'codex', ['app-server', '--stdio'], {
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    let finished = false;
    let requested = false;

    const settle = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already closed */ }
      fn(value);
    };
    const write = (message) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* handled by timeout/close */ }
    };
    const timer = setTimeout(() => settle(reject, new Error('Codex usage timed out')), 8_000);

    child.stdin.on('error', () => {});
    child.on('error', () => settle(reject, new Error('Codex is unavailable')));
    child.on('close', () => {
      if (!finished) settle(reject, new Error('Codex usage closed early'));
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && !requested) {
          requested = true;
          write({ jsonrpc: '2.0', method: 'initialized' });
          write({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null });
        } else if (message.id === 2) {
          if (message.error) settle(reject, new Error('Codex usage request failed'));
          else settle(resolve, message.result || {});
        }
      }
    });

    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'workbench', title: 'Workbench', version: '0.1.0' } },
    });
  });
}

function codexWindowLabel(window) {
  const minutes = Number(window?.windowDurationMins);
  if (minutes === 300) return '5-hour limit';
  if (minutes === 10_080) return 'Weekly limit';
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`;
  if (Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return 'Usage limit';
}

function normalizeCodexUsage(raw) {
  const rateLimits = raw?.rateLimits || {};
  const windows = [['primary', rateLimits.primary], ['secondary', rateLimits.secondary]].flatMap(([id, window]) => {
    const usedPercent = percent(window?.usedPercent);
    if (usedPercent == null) return [];
    return [{
      id,
      label: codexWindowLabel(window),
      usedPercent,
      resetsAt: isoFromSeconds(window?.resetsAt),
      windowDurationMins: Number(window?.windowDurationMins) || null,
    }];
  });
  const reset = raw?.rateLimitResetCredits;
  return {
    provider: 'codex',
    available: windows.length > 0 || !!rateLimits.credits,
    source: 'ChatGPT account',
    fetchedAt: new Date().toISOString(),
    windows,
    credits: rateLimits.credits ? {
      hasCredits: !!rateLimits.credits.hasCredits,
      unlimited: !!rateLimits.credits.unlimited,
      balance: rateLimits.credits.balance == null ? null : String(rateLimits.credits.balance),
    } : null,
    resetCredits: reset ? {
      availableCount: Number(reset.availableCount) || 0,
      credits: (Array.isArray(reset.credits) ? reset.credits : []).map((credit) => ({
        title: String(credit.title || 'Rate limit reset'),
        description: String(credit.description || ''),
        status: String(credit.status || ''),
        grantedAt: isoFromSeconds(credit.grantedAt),
        expiresAt: isoFromSeconds(credit.expiresAt),
      })),
    } : null,
  };
}

async function fetchCodexUsage() {
  try {
    return normalizeCodexUsage(await readCodexRateLimits());
  } catch {
    return publicFailure('codex', 'ChatGPT usage is temporarily unavailable.');
  }
}

async function loadUsage() {
  if (process.env.WB_MODEL_USAGE_FIXTURE === '1') {
    const fetchedAt = new Date().toISOString();
    return {
      fetchedAt,
      providers: {
        claude: {
          provider: 'claude', available: true, source: 'Claude account', fetchedAt,
          windows: [
            { id: 'session', label: 'Current session', usedPercent: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
            { id: 'weekly_all', label: 'Weekly · all models', usedPercent: 27, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
          ],
          credits: { enabled: true, usedMinor: 0, limitMinor: 4_000, currency: 'USD', exponent: 2 },
        },
        codex: {
          provider: 'codex', available: true, source: 'ChatGPT account', fetchedAt,
          windows: [{ id: 'primary', label: 'Weekly limit', usedPercent: 35, resetsAt: new Date(Date.now() + 86_400_000).toISOString(), windowDurationMins: 10_080 }],
          credits: { hasCredits: false, unlimited: false, balance: '0' },
          resetCredits: { availableCount: 1, credits: [{ title: 'Full reset', description: 'One full rate-limit reset.', status: 'available', grantedAt: fetchedAt, expiresAt: new Date(Date.now() + 604_800_000).toISOString() }] },
        },
        grok: publicFailure('grok', 'Grok does not currently expose account usage to Workbench.'),
      },
    };
  }
  const [claude, codex] = await Promise.all([fetchClaudeUsage(), fetchCodexUsage()]);
  return {
    fetchedAt: new Date().toISOString(),
    providers: {
      claude,
      codex,
      grok: publicFailure('grok', 'Grok does not currently expose account usage to Workbench.'),
    },
  };
}

export async function getModelUsage({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (cache.pending) return cache.pending;
  cache.pending = loadUsage().then((value) => {
    cache = { at: Date.now(), value, pending: null };
    return value;
  }).catch((error) => {
    cache.pending = null;
    throw error;
  });
  return cache.pending;
}

export function invalidateModelUsage() {
  cache = { at: 0, value: null, pending: null };
}
