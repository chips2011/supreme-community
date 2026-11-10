import assert from 'node:assert/strict';
import { landedShortcut } from '../web/src/lib/landed-keys.ts';

const event = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, keyCode: 0, ...extra });
const reading = { typing: false, blocked: false, searchOpen: false };
const bindings = { '/': 'search', j: 'next', k: 'previous', e: 'complete', x: null, ArrowRight: 'next', ArrowLeft: 'previous', ArrowUp: 'up', ArrowDown: 'down', Escape: 'exit', Enter: null, z: null };
let checks = 0;
for (const [key, command] of Object.entries(bindings)) {
  assert.equal(landedShortcut(event(key), reading), command, key); checks++;
  for (const guard of ['typing', 'blocked', 'searchOpen']) {
    assert.equal(landedShortcut(event(key), { ...reading, [guard]: true }), guard === 'typing' && key === 'Escape' ? 'blur' : null, `${key} in ${guard}`); checks++;
  }
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
    assert.equal(landedShortcut(event(key, { [modifier]: true }), reading), key === 'Enter' && modifier === 'metaKey' ? 'complete' : null, `${key} with ${modifier}`); checks++;
  }
  assert.equal(landedShortcut(event(key, { keyCode: 229 }), reading), null, `${key} during IME`); checks++;
}
assert.equal(landedShortcut(event('Enter', { metaKey: true }), reading), 'complete'); checks++;
assert.equal(landedShortcut(event('Enter', { metaKey: true }), { ...reading, typing: true }), null); checks++;
for (const key of ['e', 'Escape', '/']) { assert.equal(landedShortcut(event(key, { repeat: true }), reading), null); checks++; }
for (const key of ['j', 'k', 'ArrowUp', 'ArrowDown']) { assert.equal(landedShortcut(event(key, { repeat: true }), reading), bindings[key]); checks++; }
console.log(`PASS all ${checks} Landed keyboard checks`);
