// Execute the actual card-state/copy functions without importing the app's
// browser store. No duplicate implementation or live browser is involved.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const ts = require('typescript');
const source = fs.readFileSync(new URL('../web/src/components/RunCard.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('RunCard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['cardState', 'cardCopy'].includes(node.name?.text));
assert.equal(functions.length, 2);
const js = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { cardState, cardCopy } = vm.runInNewContext(`${js}\n({cardState, cardCopy})`);
let checks = 0;
const check = (ok, label) => { assert.ok(ok, label); checks++; console.log(`ok ${label}`); };
const base = { runId: 'test', surface: 'Chrome', app: 'Chrome', steps: [], currentStep: 'Repair the Browser plugin in Settings > Computer Use.' };
const headline = computer => cardCopy(cardState({ computer }), computer, [], [], [], '', '', false).headline;
check(headline({ ...base, state: 'error', connection: 'unavailable' }) === 'Chrome disconnected', 'blocked browser never says Computer control complete');
check(headline({ ...base, state: 'active', connection: 'recovering' }) === 'Reconnecting to Chrome', 'bounded recovery is visible');
check(headline({ ...base, state: 'done', connection: 'connected' }) === 'Computer control complete', 'real recovery can finish normally');
check(headline({ ...base, app: 'Edge', surface: 'browser', state: 'error', connection: 'unavailable' }) === 'Edge disconnected', 'Edge is labelled correctly');
check(headline({ ...base, app: 'Browser', surface: 'browser', state: 'error', connection: 'unavailable' }) === 'Browser disconnected', 'unknown browser is not relabelled Chrome');
check(cardState({ computer: { ...base, state: 'error' }, runRef: {} }) === 'error', 'a live model run cannot override the browser failure');
check(cardState({ computer: { ...base, state: 'paused' } }) === 'paused', 'pause behavior is preserved');
check(headline({ ...base, state: 'stopped', connection: 'unavailable' }) === 'Computer control interrupted', 'intentional stop still wins');
console.log(`BROWSER CONNECTION UI UNITS: PASS (${checks})`);
