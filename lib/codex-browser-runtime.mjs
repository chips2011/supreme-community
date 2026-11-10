import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A Codex app update can replace a bundled browser version while the local
// node_repl transport still names the removed one. Repair only that missing,
// OpenAI-bundled service, per launch. Never rewrite the user's config, change
// custom services, restart another run, or download executable code.
export function codexBrowserRecoveryArgs({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  try {
    const source = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    let inEnv = false, services;
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) inEnv = /^\s*\[mcp_servers\.(?:node_repl|"node_repl"|'node_repl')\.env\]\s*(?:#.*)?$/.test(line);
      if (!inEnv) continue;
      const raw = line.match(/^\s*NODE_REPL_TRUSTED_SERVICES\s*=\s*(.+?)\s*$/)?.[1];
      if (!raw) continue;
      const json = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : JSON.parse(raw);
      services = JSON.parse(json);
      break;
    }
    if (!services || typeof services !== 'object' || Array.isArray(services) || typeof services.browser !== 'string') return [];
    if (fs.existsSync(services.browser)) return [];
    const cache = path.resolve(codexHome, 'plugins/cache/openai-bundled');
    const relative = path.relative(cache, services.browser);
    const match = relative.match(/^(browser|chrome)\/(\d+(?:\.\d+){2,3})\/scripts\/browser-service\.mjs$/);
    if (!match) return [];
    const plugin = path.join(cache, match[1]);
    const versions = fs.readdirSync(plugin, { withFileTypes: true }).filter(row => row.isDirectory() && /^\d+(?:\.\d+){2,3}$/.test(row.name)).map(row => row.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const root = path.join(plugin, version);
      const service = path.join(root, 'scripts/browser-service.mjs');
      const client = path.join(root, 'scripts/browser-client.mjs');
      const realRoot = fs.realpathSync(root);
      if (![service, client].every(file => fs.existsSync(file) && fs.realpathSync(file).startsWith(realRoot + path.sep))) continue;
      const value = JSON.stringify({ ...services, browser: service });
      return ['-c', `mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES=${JSON.stringify(value)}`];
    }
  } catch { /* Unrecognized or incomplete configuration stays Codex's to report. */ }
  return [];
}
