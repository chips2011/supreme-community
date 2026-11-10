import assert from 'node:assert/strict';
import { buildHandoffPrompt } from '../lib/providers.mjs';
import { createModelHandoff, finalizeModelHandoff, lastAssistantModel } from '../lib/handoffs.mjs';

const messages = [
  { role: 'user', content: 'Map the market.' },
  { role: 'assistant', content: 'Here is the map.', model: 'sonnet' },
  { role: 'user', content: 'Focus on private credit.' },
  { role: 'assistant', content: 'Narrowed.', model: 'sonnet' },
];

assert.equal(lastAssistantModel(messages), 'sonnet');
assert.equal(createModelHandoff({ id: 'same', messages, toModel: 'sonnet' }), null, 'same exact model resumes without a handoff');
assert.equal(createModelHandoff({ id: 'first', messages: [], toModel: 'sonnet' }), null, 'a first turn is not a handoff');

const sameProvider = createModelHandoff({
  id: 'same-provider',
  messages,
  toModel: 'opus',
  fromProvider: 'claude',
  toProvider: 'claude',
  now: '2026-08-22T00:00:00.000Z',
});
assert.equal(sameProvider.fromModel, 'sonnet');
assert.equal(sameProvider.toModel, 'opus');
assert.equal(sameProvider.atMessageCount, 4);
assert.equal(sameProvider.status, 'preparing');

const crossProvider = createModelHandoff({
  id: 'cross-provider',
  messages,
  toModel: 'gpt-5.6-sol',
  fromProvider: 'claude',
  toProvider: 'codex',
});
assert.equal(crossProvider.fromProvider, 'claude');
assert.equal(crossProvider.toProvider, 'codex');

const tab = { handoffs: [sameProvider, crossProvider] };
assert.equal(finalizeModelHandoff(tab, 'same-provider', { ok: true, completedAt: '2026-08-22T00:01:00.000Z' }).status, 'completed');
assert.equal(finalizeModelHandoff(tab, 'cross-provider', { ok: false, error: 'fixture failure' }).status, 'failed');
assert.equal(tab.handoffs[1].error, 'fixture failure');

const providerPrompt = buildHandoffPrompt({ messages }, 'Continue from here.', messages.length);
assert.match(providerPrompt, /<thread_history>/);
assert.match(providerPrompt, /Assistant \(sonnet\):\nNarrowed\./);
assert.match(providerPrompt, /New user message:\nContinue from here\./);

process.stdout.write('HANDOFF TEST: PASS\n');
