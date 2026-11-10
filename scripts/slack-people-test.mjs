import assert from 'node:assert/strict';
import { createSlackPeopleReader, SLACK_PEOPLE_LIMIT } from '../lib/slack-people.mjs';
let checks = 0;
const check = (value, label) => { assert(value, label); checks++; console.log('ok ' + label); };
let connection = 'one', clock = 1_800_000_000_000, calls = [], profileCalls = [];
let conversation = { id: 'CPRIVATE', is_channel: true, is_private: true, is_member: true, is_ext_shared: true };
let members = ['UALEX', 'USAMPLE', 'UBOT'];
let fail = null, badProfile = false, hiddenEmail = false;
const reader = createSlackPeopleReader({ connectionKey: () => connection, now: () => clock,
  readConversation: async () => conversation,
  readMembers: async (channel, options) => { calls.push({ channel, ...options }); if (fail) throw fail; return { members, nextCursor: options.cursor ? '' : 'synthetic-next' }; },
  readProfile: async id => { profileCalls.push(id); return { id: badProfile ? 'UOTHER' : id, real_name: id === 'USAMPLE' ? 'Taylor Example' : 'Alex',
    is_bot: id === 'UBOT', profile: { display_name: id === 'USAMPLE' ? 'Eddie' : '', ...(hiddenEmail ? {} : { email: id === 'USAMPLE' ? 'edward@example.com' : 'alex@example.com' }), secret_field: 'SHOULD_NOT_LEAK' } }; },
});
const read = options => reader.read({ channel: 'CPRIVATE', turn: 'first', ...options });
let result = await read({ query: 'EDDIE' });
check(result.people.length === 1 && result.people[0].name === 'Taylor Example' && result.people[0].email === 'edward@example.com', 'A display-name alias resolves the actual external profile email');
check(calls[0].limit === SLACK_PEOPLE_LIMIT && calls[0].channel === 'CPRIVATE', 'Member lookups are bound to the original channel and capped at twenty');
check(!JSON.stringify(result).includes('SHOULD_NOT_LEAK') && !result.people.some(p => p.id === 'UBOT'), 'Only contact fields from human member profiles are returned');
check(result.nextCursor === 'synthetic-next' && result.hasMore, 'More members are explicit, not an empty search claim');
await read({ query: 'Alex' });
check(calls.length === 1 && profileCalls.length === 3, 'Repeated filters reuse only a short-lived, connection-bound page');
await read({ cursor: result.nextCursor });
check(calls.at(-1).cursor === 'synthetic-next', 'Only a cursor issued for this request can page members');
const used = calls.length;
result = await read({}); check(result.warning.includes('three-page') && calls.length === used, 'A turn has a strict three-page budget');
await assert.rejects(read({ turn: 'other', cursor: 'synthetic-next' })); checks++;
await assert.rejects(read({ turn: 'other', cursor: '../other-channel' })); checks++;
await assert.rejects(read({ turn: '' })); checks++;
connection = 'two'; hiddenEmail = true;
result = await read({ query: 'Eddie' });
check(!result.people[0].email && result.people[0].emailVisible === false && result.note.includes('Do not guess'), 'An unavailable Slack Connect email is not invented');
check(calls.length === used + 1, 'Changing connections never reuses another connection\'s member cache');
clock += 30_001; hiddenEmail = false;
await read({}); check(calls.length === used + 2, 'Cached profiles expire with their membership page');
connection = 'oversize'; members = Array.from({ length: 1_000 }, (_, n) => `U${n}`);
const before = profileCalls.length; result = await read({});
check(profileCalls.length - before <= SLACK_PEOPLE_LIMIT && result.people.length <= SLACK_PEOPLE_LIMIT, 'Oversized upstream member lists cannot trigger an unbounded profile crawl');
connection = 'mismatch'; badProfile = true;
result = await read({}); check(!!result.warning && !result.people.length, 'A mismatched profile fails closed'); badProfile = false;
for (const info of [{ id: 'COTHER', is_mpim: true }, { id: 'CPRIVATE', is_channel: true, is_member: false }, { id: 'CPRIVATE', is_channel: true }]) {
  conversation = info; connection += '-denied'; const count = calls.length;
  result = await read({}); check(!result.people.length && !!result.warning && calls.length === count, 'Unverified or absent conversation membership blocks every profile read');
}
conversation = { id: 'CPRIVATE', is_mpim: true }; connection = 'missing'; fail = Object.assign(new Error('private-provider-details'), { code: 'missing_scope', needed: 'users:read' });
result = await read({}); check(result.warning.includes('users:read') && !result.warning.includes('private-provider-details'), 'Profile permission failures are explicit and sanitized');
connection = 'revoked'; fail = { code: 'token_revoked' };
result = await read({}); check(result.warning.includes("Supreme's bot connection") && result.warning.includes('other Slack connections'), 'Revocation is attributed only to the bot connection actually used');
console.log(`SLACK PEOPLE TEST: PASS (${checks} checks)`);
