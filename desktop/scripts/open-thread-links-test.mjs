import assert from 'node:assert/strict';
import { parseOpenThreadLink, createOpenThreadLinks } from '../open-thread-links.mjs';
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
const link = 'supreme://open?thread=thread-1&tab=tab-2';
check('email link selects its exact workstream and tab', () => assert.deepEqual(parseOpenThreadLink(link), { taskId: 'thread-1', tabId: 'tab-2' }));
check('community Slack links open the same conversation without using the official scheme', () => assert.deepEqual(parseOpenThreadLink('supreme-community://open?thread=thread-1&tab=tab-2'), { taskId: 'thread-1', tabId: 'tab-2' }));
check('query order and trailing slash are harmless', () => assert.deepEqual(parseOpenThreadLink('supreme://open/?tab=tab-2&thread=thread-1'), parseOpenThreadLink(link)));
for (const invalid of [
  null, 12, '', 'https://open?thread=a&tab=b', 'javascript:alert(1)',
  'conductor://auth/callback?code=one', 'conductor://slack/callback?code=one',
  'supreme://elsewhere?thread=a&tab=b', 'supreme://open/run?thread=a&tab=b',
  'supreme://user@open?thread=a&tab=b', 'supreme://open:99?thread=a&tab=b',
  'supreme://open?thread=a&tab=b#run', 'supreme://open?thread=a',
  'supreme://open?thread=&tab=b', 'supreme://open?thread=a&tab=b&tab=c',
  'supreme://open?thread=a&thread=c&tab=b', 'supreme://open?thread=a&tab=b&prompt=send',
  'supreme://open?thread=..%2Fa&tab=b', 'supreme://open?thread=a&tab=%0Ab',
  'supreme://open?thread=a&tab=' + 'a'.repeat(129),
  'supreme-community://open?thread=a&tab=b&prompt=send',
  'supreme-community://user@open?thread=a&tab=b',
  'supreme-community://open/run?thread=a&tab=b',
]) check('rejects unsafe or malformed link ' + String(invalid).slice(0, 90), () => assert.equal(parseOpenThreadLink(invalid), null));
const delivered = [];
let windowAvailable = true;
const links = createOpenThreadLinks(ref => { if (!windowAvailable) return false; delivered.push(ref); return true; });
check('cold start queues without navigating before boot', () => { assert(links.queue(link)); assert.equal(delivered.length, 0); });
check('invalid URL cannot replace the pending link', () => { assert.equal(links.queue('supreme://open?thread=a'), false); links.setReady(true); assert.deepEqual(delivered, [parseOpenThreadLink(link)]); });
check('ready notifications do not deliver the same link twice', () => { links.setReady(true); links.flush(); assert.equal(delivered.length, 1); });
check('hot links deliver immediately', () => { links.queue('supreme://open?thread=next&tab=second'); assert.equal(delivered.at(-1).tabId, 'second'); });
check('reload holds links until the new renderer boots', () => { links.setReady(false); links.queue(link); assert.equal(delivered.length, 2); links.setReady(true); assert.equal(delivered.length, 3); });
check('a loading or missing window retains the link', () => { windowAvailable = false; links.queue(link); assert.equal(delivered.length, 3); windowAvailable = true; links.flush(); assert.equal(delivered.length, 4); });
check('the latest queued click wins', () => { links.setReady(false); links.queue(link); links.queue('supreme://open?thread=new&tab=last'); links.setReady(true); assert.equal(delivered.at(-1).tabId, 'last'); assert.equal(delivered.length, 5); });
console.log('DESKTOP LINK UNIT: PASS (' + checks + ' checks)');
