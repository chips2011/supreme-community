// Connectors as the product sees them (Paper section 15): one row per
// connector across providers, plus how much it gets used. `claude mcp list` and
// `codex mcp list` each report their own copy of a connector, under their own
// casing; this module gives the two copies one identity and keeps the usage
// ledger that orders the page and the Context list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const USAGE_FILE = path.join(DATA_DIR, 'connector-usage.json');
// Provider-internal servers that are not connectors from the user's point of view.
const JUNK = /^(?:plugin|workspace|codex_apps?|node_repl|openaideveloperdocs)$/i;
// Computer use is a real plugin (Claude in Chrome for Claude, the Codex Chrome
// extension for ChatGPT). Each provider lists it under its own server name;
// the page shows one row, "Computer use", whose connected state is whether the
// extension is installed and whose uses count the turns that drove Chrome.
const COMPUTER_USE = /^(?:computer[-_ ]use|claude[-_ ]in[-_ ]chrome)$/i;
export const COMPUTER_USE_KEY = 'computer use';
// A connector counts as new for this long after it first shows up in a scan
// made after the baseline scan; using it once ends that early.
const NEW_FOR_MS = 7 * 24 * 3_600_000;
const MOST_USED = 5;
const MAX_HISTORY_FILE_BYTES = 32 * 1024 * 1024;

export function connectorKey(name) {
  return String(name || '').replace(/^claude\.ai\s+/i, '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function alnum(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The nicest of the names the providers report for one connector: Claude's
// casing when it has it, otherwise the variant with the most capitals.
function displayName(names) {
  const claude = names.find((candidate) => candidate.provider !== 'codex');
  if (claude) return claude.name;
  return [...names].sort((a, b) => (b.name.replace(/[^A-Z]/g, '').length - a.name.replace(/[^A-Z]/g, '').length))[0].name;
}

export function groupConnectors(list) {
  const groups = new Map();
  for (const connector of Array.isArray(list) ? list : []) {
    if (!connector || typeof connector !== 'object') continue;
    const name = String(connector.name || '').trim();
    // The computer-use servers become the synthetic row in connectorOverview.
    if (!name || JUNK.test(name) || COMPUTER_USE.test(name)) continue;
    const key = connectorKey(name);
    if (!key) continue;
    const group = groups.get(key) || { key, names: [], providers: {} };
    const provider = connector.provider === 'codex' ? 'codex' : 'claude';
    group.names.push({ name, provider });
    group.providers[provider] = {
      connected: connector.connected !== false,
      status: String(connector.status || ''),
      url: String(connector.url || ''),
      // The raw Codex config name, so Sign in can run `codex mcp login <it>`.
      server: String(connector.server || ''),
    };
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    name: displayName(group.names),
    names: [...new Set(group.names.map((candidate) => candidate.name))],
    providers: group.providers,
    connected: Object.values(group.providers).some((provider) => provider.connected),
    signIn: Object.entries(group.providers)
      .filter(([, provider]) => /sign-in required|needs auth/i.test(provider.status))
      .map(([provider]) => provider),
  }));
}

// ---------------------------------------------------------------------------
// Usage ledger. Product uses are counted per turn a connector took part in;
// the seed is a one-time read of the local Claude Code and Codex session logs,
// kept separate so the page can say which is which.

function emptyUsage() {
  // seenBy: which model a connector actually worked through in a real turn,
  // and names: how it called itself, so the page can list connectors the
  // CLIs' own inventories do not report (ChatGPT's account apps).
  return { version: 1, checkedAt: null, baselineAt: null, seededAt: null, rebuiltAt: null, seen: {}, seed: {}, uses: {}, seenBy: {}, names: {} };
}

export function loadConnectorUsage() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return { ...emptyUsage(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return emptyUsage();
  }
}

export function saveConnectorUsage(usage) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  const tmp = `${USAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
  fs.renameSync(tmp, USAGE_FILE);
  return usage;
}

// After a real scan: remember when, and which connectors are being seen for
// the first time. The very first scan is the baseline, so an install does not
// start with everything tagged new.
export function noteConnectorScan(list, { now = new Date() } = {}) {
  const usage = loadConnectorUsage();
  const at = now.toISOString();
  usage.checkedAt = at;
  if (!usage.baselineAt) usage.baselineAt = at;
  for (const group of groupConnectors(list)) {
    if (!usage.seen[group.key]) usage.seen[group.key] = at;
  }
  return saveConnectorUsage(usage);
}

function bump(usage, key, at) {
  const entry = usage.uses[key] || { count: 0, lastUsedAt: null };
  entry.count += 1;
  if (!entry.lastUsedAt || at > entry.lastUsedAt) entry.lastUsedAt = at;
  usage.uses[key] = entry;
}

// One use per connector per assistant turn it took part in. A turn that drove
// Chrome (message.computer) is one use of Computer use.
// Every connector this tab's transcript shows it actually used.
export function keysUsedByTab(tab) {
  const keys = new Map();
  for (const message of tab?.messages || []) {
    for (const [key, name] of keysUsedByMessage(message)) if (!keys.has(key)) keys.set(key, name);
  }
  return keys;
}

// The one-button trim behind Sum up: a tab scoped to the connectors it has
// used runs without the rest. Claude can drop everything (strict empty MCP
// config) or keep a purely local subset re-declared via --mcp-config; an
// account connector cannot be re-declared per run (its auth lives with the
// account), so a scope that needs one keeps the full set. Codex disables
// configured local servers by name; account plugins are outside our reach.
function configuredCodexMcpServers(codexHome) {
  let source = '';
  try { source = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch { return new Set(); }
  const servers = new Set();
  const serverTable = /^\s*\[\s*mcp_servers\.((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(serverTable);
    if (!match) continue;
    const rawName = match[1];
    if (rawName.startsWith('"')) {
      try { servers.add(JSON.parse(rawName)); } catch { /* malformed TOML is Codex's error to report */ }
    } else if (rawName.startsWith("'")) {
      servers.add(rawName.slice(1, -1));
    } else {
      servers.add(rawName);
    }
  }
  return servers;
}

export function mcpTrimFor(keys, {
  claudeHome = process.env.WB_CLAUDE_CONFIG_HOME || os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  connectors = [],
} = {}) {
  const scoped = new Set(keys);
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(claudeHome, '.claude.json'), 'utf8')).mcpServers || {}; } catch { /* no local config */ }
  const localByKey = new Map(Object.entries(local).map(([name, def]) => [connectorKey(name), { name, def }]));
  let claude;
  if (!scoped.size) {
    claude = { mode: 'empty' };
  } else if ([...scoped].every((key) => localByKey.has(key))) {
    const servers = {};
    for (const key of scoped) { const { name, def } = localByKey.get(key); servers[name] = def; }
    claude = { mode: 'config', servers };
  } else {
    claude = { mode: 'none' };
  }
  // `codex mcp list` also includes servers supplied by plugins. An `enabled`
  // override is only valid for a server that already has a command or URL in
  // config.toml; otherwise it creates an incomplete server and Codex refuses
  // to start with "invalid transport".
  const configuredCodexServers = configuredCodexMcpServers(codexHome);
  const disable = [...new Set(connectors
    .filter((row) => row.provider === 'codex'
      && row.server
      && configuredCodexServers.has(String(row.server))
      && row.connected
      && !scoped.has(connectorKey(row.name)))
    .map((row) => String(row.server)))];
  return { claude, codex: { disable } };
}

function keysUsedByMessage(message) {
  const keys = new Map(); // key -> display name
  for (const activity of message?.connectors || []) {
    if (!activity || typeof activity !== 'object') continue;
    if (activity.state && !['done', 'complete', 'active'].includes(activity.state)) continue;
    const name = String(activity.connector || activity.name || '').trim();
    if (!name || JUNK.test(name)) continue;
    if (COMPUTER_USE.test(name)) { keys.set(COMPUTER_USE_KEY, 'Computer use'); continue; }
    const key = connectorKey(name);
    if (key && !keys.has(key)) keys.set(key, name.replace(/\s+connector$/i, ''));
  }
  const computer = message?.computer;
  if (computer && typeof computer === 'object' && (computer.steps?.length || computer.state)) keys.set(COMPUTER_USE_KEY, 'Computer use');
  return keys;
}

export function recordConnectorUses(message, { usage = null, save = true, provider = null } = {}) {
  const ledger = usage || loadConnectorUsage();
  const keys = keysUsedByMessage(message);
  if (!keys.size) return ledger;
  const at = String(message?.ts || new Date().toISOString());
  ledger.seenBy = ledger.seenBy || {};
  ledger.names = ledger.names || {};
  for (const [key, name] of keys) {
    bump(ledger, key, at);
    if (!ledger.names[key]) ledger.names[key] = name;
    if (provider === 'claude' || provider === 'codex') {
      const seen = ledger.seenBy[key] || {};
      if (!seen[provider] || at > seen[provider]) seen[provider] = at;
      ledger.seenBy[key] = seen;
    }
  }
  return save ? saveConnectorUsage(ledger) : ledger;
}

// First run on an install that already has transcripts: count what happened
// before the ledger existed, from the saved messages themselves.
export function rebuildConnectorUsage(tasks, { now = new Date(), providerOf = null } = {}) {
  const usage = loadConnectorUsage();
  usage.uses = {};
  usage.seenBy = {};
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const tab of [...(task?.tabs || []), ...(task?.archivedTabs || [])]) {
      for (const message of tab?.messages || []) {
        if (message?.role !== 'assistant') continue;
        const provider = typeof providerOf === 'function' ? providerOf(message.model) || null : null;
        recordConnectorUses(message, { usage, save: false, provider });
      }
    }
  }
  usage.rebuiltAt = now.toISOString();
  return saveConnectorUsage(usage);
}

function jsonlFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 6) walk(full, depth + 1); continue; }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function readCapped(file) {
  try {
    if (fs.statSync(file).size > MAX_HISTORY_FILE_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Claude Code names MCP tools mcp__<server>__<tool>; Codex logs the server on
// each call. Both map onto connector names loosely (claude_ai_Apollo_io ->
// Apollo.io), so seeds are matched to connectors on letters and digits only.
function serverToSeedKey(server) {
  return connectorKey(String(server || '').replace(/^claude_ai_/i, '').replace(/^codex_apps__/i, ''));
}

// One-time seed from the histories the model CLIs already keep on this Mac.
// There is no account-level usage API on either side; this is the honest
// version of "what you have already been using".
export function seedConnectorUsageFromHistory({ home = os.homedir(), force = false, now = new Date() } = {}) {
  const usage = loadConnectorUsage();
  if (usage.seededAt && !force) return usage;
  const seed = {};
  const add = (provider, server) => {
    const key = COMPUTER_USE.test(String(server || '')) ? COMPUTER_USE_KEY : serverToSeedKey(server);
    if (!key || JUNK.test(key)) return;
    const entry = seed[key] || { claude: 0, codex: 0 };
    entry[provider] += 1;
    seed[key] = entry;
  };
  for (const file of jsonlFiles(path.join(home, '.claude', 'projects'))) {
    const text = readCapped(file);
    for (const match of text.matchAll(/"name":\s*"mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__[^"]*"/g)) add('claude', match[1]);
  }
  for (const file of jsonlFiles(path.join(home, '.codex', 'sessions'))) {
    const text = readCapped(file);
    for (const match of text.matchAll(/"server":\s*"([A-Za-z0-9_-]+)"/g)) add('codex', match[1]);
  }
  usage.seed = seed;
  usage.seededAt = now.toISOString();
  return saveConnectorUsage(usage);
}

// ---------------------------------------------------------------------------
// The page.

// The Computer use row: which model reaches Chrome (its extension installed
// and on in the active profile), and how often turns have driven it. `chrome`
// is the server's chromeExtensionStatus(); without it the row only appears
// when there is usage to show.
function computerUseRow(usage, chrome, seededUses) {
  const use = usage?.uses?.[COMPUTER_USE_KEY] || { count: 0, lastUsedAt: null };
  const providers = {};
  const install = [];
  for (const provider of ['claude', 'codex']) {
    const status = chrome?.providers?.[provider];
    if (!status || typeof status !== 'object') continue;
    const installed = !!status.installed;
    const on = installed && status.activeProfileEnabled !== false;
    providers[provider] = {
      connected: on,
      status: !installed ? 'extension not installed'
        : on ? `installed${status.profiles?.[0] ? ` in ${status.profiles[0]}` : ''}`
          : 'installed, turned off in the active Chrome profile',
      url: String(status.installUrl || ''),
    };
    if (!installed) install.push(provider);
  }
  if (!Object.keys(providers).length && use.count === 0 && seededUses === 0) return null;
  return {
    key: COMPUTER_USE_KEY,
    name: 'Computer use',
    names: ['Computer use', 'Claude in Chrome', 'Codex Chrome extension', 'Chrome'],
    kind: 'computer',
    providers,
    connected: Object.values(providers).some((provider) => provider.connected),
    signIn: [],
    install,
    uses: use.count,
    seededUses,
    totalUses: use.count + seededUses,
    lastUsedAt: use.lastUsedAt,
    isNew: false,
  };
}

// A connector that worked in a real turn is on the page even when the CLI's
// own inventory does not list it (ChatGPT's account apps never appear in
// `codex plugin list`), and a listed one also shows the model it worked
// through. What has actually run beats what a listing claims.
const USED_STATUS = 'Used in a run';
function withUsedConnectors(rows, usage) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const [key, seen] of Object.entries(usage?.seenBy || {})) {
    if (!seen || typeof seen !== 'object' || key === COMPUTER_USE_KEY) continue;
    const providers = Object.keys(seen).filter((provider) => provider === 'claude' || provider === 'codex');
    if (!providers.length) continue;
    let row = byKey.get(key);
    if (!row) {
      const name = String(usage?.names?.[key] || key).trim() || key;
      row = { key, name, names: [name], providers: {}, connected: true, signIn: [] };
      rows.push(row);
      byKey.set(key, row);
    }
    for (const provider of providers) {
      if (!row.providers[provider]) row.providers[provider] = { connected: true, status: USED_STATUS, url: '' };
    }
    row.connected = Object.values(row.providers).some((provider) => provider.connected);
  }
  return rows;
}

export function connectorOverview(list, usage, { now = Date.now(), chrome = null } = {}) {
  const rows = withUsedConnectors(groupConnectors(list), usage);
  const seedFor = (key) => {
    let total = 0;
    for (const [seedKey, perProvider] of Object.entries(usage?.seed || {})) {
      if (alnum(seedKey) === alnum(key)) total += (Number(perProvider?.claude) || 0) + (Number(perProvider?.codex) || 0);
    }
    return total;
  };
  const decorated = rows.map((row) => {
    const use = usage?.uses?.[row.key] || { count: 0, lastUsedAt: null };
    const seededUses = seedFor(row.key);
    const firstSeen = usage?.seen?.[row.key] || null;
    const isNew = !!(firstSeen && usage?.baselineAt && firstSeen > usage.baselineAt
      && use.count === 0 && now - Date.parse(firstSeen) < NEW_FOR_MS);
    return { ...row, kind: 'connector', uses: use.count, seededUses, totalUses: use.count + seededUses, lastUsedAt: use.lastUsedAt, isNew };
  });
  const computer = computerUseRow(usage, chrome, seedFor(COMPUTER_USE_KEY));
  if (computer) decorated.push(computer);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const mostUsed = decorated
    .filter((row) => row.totalUses > 0)
    .sort((a, b) => b.totalUses - a.totalUses || byName(a, b))
    .slice(0, MOST_USED);
  const rest = decorated.filter((row) => !mostUsed.includes(row)).sort(byName);
  return {
    checkedAt: usage?.checkedAt || null,
    seededAt: usage?.seededAt || null,
    mostUsed,
    rest,
    count: decorated.length,
    connectedCount: decorated.filter((row) => row.connected).length,
  };
}

// Connector keys in page order: what Context follows. Computer use is a
// plugin, not a place Context can read from, so it stays off that list.
export function connectorOrder(overview) {
  return [...(overview?.mostUsed || []), ...(overview?.rest || [])].filter((row) => row.kind !== 'computer').map((row) => row.key);
}
