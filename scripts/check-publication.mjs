// Guard the source export against production configuration and private artifacts.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const excluded = new Set(['node_modules', '.git', '.generated', 'dist', '.private']);
const textExtensions = /\.(?:mjs|cjs|ts|tsx|js|json|md|toml|yml|yaml|html|css|sql)$/;
let count = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(dir, entry.name), rel = relative(root, path);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${rel}`);
    if (entry.isDirectory()) { walk(path); continue; }
    assert(!/^\.env(?:\.|$)/.test(entry.name) || entry.name === '.env.example', `Private env file: ${rel}`);
    assert(!/\.(?:p12|p8|pem|dmg|zip)$/.test(entry.name), `Private/build artifact: ${rel}`);
    if (!textExtensions.test(entry.name)) continue;
    const text = readFileSync(path, 'utf8');
    const forbidden = [new RegExp('phc_' + '[A-Za-z0-9]{20,}'), new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), new RegExp('/Users/' + 'wayne', 'i'), new RegExp('getvime' + '\\.com', 'i')];
    for (const pattern of forbidden) assert(!pattern.test(text), `Private/production content: ${rel}`);
    count++;
  }
}
walk(root);
const desktop = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8'));
assert.equal(desktop.version, '0.1.119');
assert.equal(desktop.license, 'Apache-2.0');
assert(readFileSync(join(root, 'LICENSE'), 'utf8').includes('Apache License'));
console.log(`Publication guard passed (${count} text files). Run Gitleaks separately for secret detection.`);
