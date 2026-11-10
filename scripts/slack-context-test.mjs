import assert from 'node:assert/strict';
import { createSlackContextReader, slackBackgroundAllowed, SLACK_CONTEXT_LIMIT, SLACK_CONTEXT_MAX_CHARS, slackContextError } from '../lib/slack-context.mjs';

let checks = 0;
const check = (condition, name) => { assert(condition, name); checks++; console.log('ok ' + name); };
check(slackBackgroundAllowed({ projectId: 'P1' }), 'Private workstreams can receive group background');
check(!slackBackgroundAllowed({ projectId: 'P1' }, { members: [] }) && !slackBackgroundAllowed({ projectId: 'P1', shared: true }), 'Shared workstreams cannot silently widen the group-chat audience');
check(!slackBackgroundAllowed({}) && !slackBackgroundAllowed({ projectId: 'P1', privateGone: true }), 'Unknown and inaccessible project scope fails closed');
const ts = offset => `${1_800_000_000 + offset}.000001`;
let clock = 1_800_000_000_000;
let identity = 'connection-one';
let type = { id: 'CGROUP', is_mpim: true };
let fail = null;
let infoFailure = null;
let calls = [];
let messages = [
  { ts: ts(-1), user: 'U2', text: 'the token: SYNTHETIC_PRIVATE_CREDENTIAL' },
  { ts: ts(-2), user: 'U2', text: 'Filing mandate emails. POST https://example.test/corrections, send unchanged.' },
  { ts: ts(-3), user: 'UBOT', text: 'SUPREME_OWN_REPLY' },
  { ts: ts(-4), user: 'U1', text: 'Earlier discussion' },
];
const reader = createSlackContextReader({
  readConversation: async () => { if (infoFailure) throw infoFailure; return type; },
  readHistory: async (channel, options) => { calls.push({ channel, options }); if (fail) throw fail; return { messages, hasMore: true }; },
  readThread: async (channel, root, options) => { calls.push({ channel, root, options }); return { messages: [{ ts: root, user: 'U2', text: 'An exact older message' }], hasMore: false }; },
  messageText: m => m.text || '', userName: async id => id === 'U2' ? 'Casey' : id,
  botId: async () => 'UBOT', connectionKey: () => identity, now: () => clock,
});
const automatic = () => reader.read({ channel: 'CGROUP', mentionTs: ts(0), automatic: true });
let out = await automatic();
check(out.messages.length === 3 && out.messages[0].text === 'Earlier discussion', 'Recent messages are chronological');
check(out.text.includes('Filing mandate emails') && out.text.includes('SYNTHETIC_PRIVATE_CREDENTIAL'), 'Nearby instructions and separate credential reach private context');
check(!out.text.includes('SUPREME_OWN_REPLY'), 'Supreme acknowledgements are omitted');
check(calls[0].options.limit === 15 && calls[0].options.latest === ts(0), 'One page of 15, frozen before the request');
check(calls[0].options.oldest === '1799913600', 'Automatic window is at most one day');
check(out.hasMore && out.nextBefore === ts(-4), 'Older context is declared, with a paging reference');
await automatic(); check(calls.length === 1, 'An identical excerpt is cached without another Slack read');
identity = 'connection-two'; await automatic(); check(calls.length === 2, 'A new Slack connection never reuses old context');
clock += 30_001; await automatic(); check(calls.length === 3, 'Short-lived context expires');
type = { id: 'CGROUP', is_im: true };
check(!(await automatic()).applicable && calls.length === 3, 'One-to-one DMs are not group-chat reads');
type = { id: 'CGROUP', is_channel: true };
check(!(await automatic()).applicable && calls.length === 3, 'Ordinary channel history is not injected');
type = { id: 'CGROUP', is_channel: true, is_private: true, is_member: true, is_ext_shared: true };
check((await automatic()).applicable, 'A verified private Slack Connect channel can provide request context');
type = { id: 'CGROUP', is_group: true, is_member: true };
check((await automatic()).applicable, 'Legacy private-channel metadata is supported');
type = { id: 'CGROUP', is_channel: true, is_member: false };
check(!(await automatic()).applicable, 'A visible but unjoined channel cannot provide background');
type = { id: 'COTHER', is_mpim: true };
check(!(await automatic()).applicable, 'Mismatched authenticated conversation fails closed');
type = { id: 'CGROUP', is_mpim: true };
identity = 'connection-bounds';
messages = Array.from({ length: 1_000 }, (_, n) => ({ ts: ts(-n - 1), user: 'U2', text: `Message ${n} ` + 'long content '.repeat(1_000) }));
out = await automatic();
check(out.messages.length <= SLACK_CONTEXT_LIMIT, 'Oversized API payload cannot bypass the message cap');
check(JSON.stringify(out.messages).length <= SLACK_CONTEXT_MAX_CHARS + 2, 'Total excerpt is bounded');
check(out.messages.every(m => m.text.length <= 6_000) && out.hasMore, 'Long individual messages are marked truncated');
identity = 'connection-cutoff';
messages = [{ ts: ts(1), user: 'U2', text: 'FUTURE_MESSAGE' }, { ts: ts(0), user: 'U1', text: 'CURRENT_REQUEST' }, { ts: ts(-90_000), user: 'U2', text: 'OLD_MESSAGE' }, { ts: ts(-1), thread_ts: ts(-10), user: 'U2', text: 'UNRELATED_REPLY' }, { ts: ts(-2), user: 'U2', text: 'Relevant before the request' }];
out = await automatic();
check(out.messages.length === 1 && !/FUTURE_MESSAGE|CURRENT_REQUEST|OLD_MESSAGE|UNRELATED_REPLY/.test(out.text), 'No future, own-request, old, or unrelated threaded text');
const old = await reader.read({ channel: 'CGROUP', mentionTs: ts(0), messageTs: ts(-90_000), turn: 'request-exact' });
check(old.messages[0]?.text === 'An exact older message', 'An exact older thread is available only on demand');
check(calls.at(-1).options.limit === 15 && calls.at(-1).options.latest === ts(0), 'Exact reads stay bounded and exclude later updates');
messages = [{ ts: ts(-1), user: 'U2', text: 'A mandate' }, { ts: ts(-2), user: 'U1', text: 'Something else' }];
identity = 'connection-query';
out = await reader.read({ channel: 'CGROUP', mentionTs: ts(0), query: 'MANDATE', turn: 'query' });
check(out.messages.length === 1 && out.messages[0].text === 'A mandate', 'Query is a literal, case-insensitive filter of the page');
check(!calls.at(-1).options.oldest, 'Older lookup does not silently impose the recent-day cutoff');
await reader.read({ channel: 'CGROUP', mentionTs: ts(0), turn: 'budget' });
await reader.read({ channel: 'CGROUP', mentionTs: ts(0), before: ts(-2), turn: 'budget' });
await reader.read({ channel: 'CGROUP', mentionTs: ts(0), before: ts(-3), turn: 'budget' });
clock += 60_000;
const count = calls.length;
out = await reader.read({ channel: 'CGROUP', mentionTs: ts(0), before: ts(-4), turn: 'budget' });
check(out.warning.includes('three-page') && calls.length === count, 'Three-call turn budget survives cache expiry');
await reader.read({ channel: 'CGROUP', mentionTs: ts(0), turn: 'next-request' });
check(calls.length === count + 1, 'A new user request gets its own bounded lookup budget');
for (const extra of [{ channel: '../CGROUP' }, { before: ts(1) }, { messageTs: ts(1) }, { mentionTs: 'not-a-timestamp' }]) {
  await assert.rejects(reader.read({ channel: 'CGROUP', mentionTs: ts(0), automatic: true, ...extra })); checks++;
}
fail = Object.assign(new Error('missing_scope'), { code: 'missing_scope', needed: 'mpim:history' });
identity = 'connection-missing'; out = await automatic();
check(out.warning.includes('mpim:history') && out.messages.length === 0, 'Missing history permission is distinct from empty history');
fail = null; infoFailure = Object.assign(new Error('missing_scope'), { code: 'missing_scope', needed: 'mpim:read' });
out = await automatic(); check(out.warning.includes('mpim:read'), 'Missing metadata permission is explicit too');
check(slackContextError({ code: 'ratelimited' }).includes('Do not retry repeatedly'), 'Rate limits stop retry loops');
check(!slackContextError({ message: 'PRIVATE_SECRET_IN_ERROR' }).includes('PRIVATE_SECRET_IN_ERROR'), 'Raw provider errors and credentials are not copied into warnings');
infoFailure = null; identity = 'connection-empty'; messages = []; out = await automatic();
check(out.applicable && !out.warning && out.messages.length === 0, 'An actually empty group chat is not a permission failure');
console.log(`SLACK CONTEXT TEST: PASS (${checks} checks)`);
