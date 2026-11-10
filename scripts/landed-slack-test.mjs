// Execute the actual Landed selectors with isolated state/ownership helpers.
// No service, real home, credentials, fixtures to remove, or outbound calls.
import assert from 'node:assert/strict';
import { build } from '../web/node_modules/esbuild/lib/main.js';
import { slackInboxPage } from '../lib/slack-inbox.mjs';
const state = { threads: [], cache: {}, landedCurrent: null, landedCurrentAt: 0 };
globalThis.__supremeLandedFixture = state;
const bundled = await build({ entryPoints: [new URL('../web/src/lib/landed.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'isolated-landed-state', setup(builder) {
  builder.onResolve({ filter: /^\.\.\/store$|^\.\/rail$|^\.\/vitality$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === '../store' ? 'export const state = globalThis.__supremeLandedFixture;' : args.path === './rail' ? 'export const rowReturned = (id, tab) => !!tab.waiting; export const rowCameBack = (id, tab) => !!tab.cameBack;' : 'export const tabReturnedAt = (id, tab) => Date.parse(tab.returnedAt);' }));
} }] });
const { landedRows, recentRows, landedDeck, landedPlace } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name); };
const make = (id, origin, extra = {}) => ({ id, origin, tabs: [{ id: 'main', waiting: true, cameBack: true, returnedAt: '2026-10-13T22:00:00Z' }], ...extra });
const manual = make('manual', undefined);
const slack = make('slack', 'slack', { slackInbox: { state: 'needs-you' }, pinned: true });
state.threads = [manual, slack, make('archived', undefined, { archived: true }), make('signup', 'signup')];
const before = JSON.stringify(state);
check('Unread Slack is absent from Landed and its count', () => assert.deepEqual(landedRows().map(r => r.threadId), ['manual', 'signup']));
check('Slack is also absent from recent history', () => assert.deepEqual(recentRows().map(r => r.threadId), ['manual', 'signup']));
check('Pinned Slack does not bypass exclusion', () => assert(!landedDeck().rows.some(r => r.threadId === 'slack')));
check('Manual and other-source work retain their Landed behavior', () => assert(landedDeck().rows.some(r => r.threadId === 'manual') && !landedDeck().recent));
check('Slack remains accessible in the separate Slack inbox', () => assert.equal(slackInboxPage(state.threads).counts.active, 1));
check('Projection never completes, archives, or mutates tasks', () => assert.equal(JSON.stringify(state), before));
state.cache.manual = { origin: 'slack' };
check('A cached Slack origin overrides a stale list summary', () => assert(!landedRows().some(r => r.threadId === 'manual')));
state.cache = {}; state.threads = [slack];
check('Slack-only waiting items produce an empty Landed deck', () => assert.equal(landedDeck().rows.length, 0));
manual.tabs[0].waiting = false; state.threads.push(manual);
check('An empty waiting deck falls back to normal recents, not Slack', () => { assert.equal(landedDeck().recent, true); assert.deepEqual(landedDeck().rows.map(r => r.threadId), ['manual']); });
state.landedCurrent = 'slack:main';
check('Stale Slack selection is not treated as a current Landed row', () => assert.equal(landedPlace().at, -1));
console.log(`LANDED SLACK EXCLUSION: PASS (${checks} checks)`);
