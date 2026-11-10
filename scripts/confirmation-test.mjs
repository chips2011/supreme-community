import assert from 'node:assert/strict';
import { confirmationRequest, tabConfirmation } from '../lib/confirmation.mjs';
let checks = 0;
for (const question of [
  'What email should I use for Eddie, and which tools should be included?',
  'Nothing has been sent. What email should I use for Eddie, and which tools should be included? I’ll check each account’s available seats and flag any added cost before inviting him.',
  'I need approval before I send invites. Which account should I use?',
  'Which scheduled task do you mean, and what are Casey’s thing and the token?',
  'Where should I upload the draft?', 'When should I schedule it?',
  'Who should I invite?', 'How many seats do you want?',
  'I need your approval before sending. Do you mean everything except Attio, or only Attio?',
]) { assert.equal(confirmationRequest(question), null, question); checks++; }
for (const question of ['Send this?', 'Would you like me to send it?', 'Approve and I’ll create both drafts. Nothing sends.', 'The extra seat costs $20 a month. Shall I invite Eddie?', 'Reply **YES** to approve the permanent deletion.']) {
  assert(confirmationRequest(question), question); checks++;
}
assert.equal(confirmationRequest('Here is the draft:\n> Which email should I use?\n\nSend this?')?.confirmResponse, 'Confirm.'); checks++;
const stale = { role: 'assistant', content: 'What email should I use?', confirmation: { question: 'What email should I use?', confirmLabel: 'Confirm' } };
assert.equal(tabConfirmation({ messages: [stale] }), null); checks++;
const email = { ...stale, confirmation: { ...stale.confirmation, emailHandoff: 'synthetic' } };
assert.equal(tabConfirmation({ messages: [email] }), email.confirmation); checks++;
console.log(`CONFIRMATION TEST: PASS (${checks} checks)`);
