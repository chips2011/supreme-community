// A Slack-authenticated thread can establish participation on another
// teammate's own Mac. It grants thread context, never access to the original
// person's Supreme task, account or private project.
export function slackThreadInvited(messages, root, botId) {
  if (!root || !botId || !Array.isArray(messages)) return false;
  return messages.some(message => {
    if (!(message.ts === root || message.thread_ts === root) || message.edited) return false;
    if (message.user === botId) return true;
    if (!message.user || message.bot_id || (message.subtype && message.subtype !== 'file_share')) return false;
    return String(message.text || '').includes(`<@${botId}>`);
  });
}

// Acknowledgments alone don't need a model or another message in the thread.
// Any question, substantive text or attachment still reaches the agent.
export function slackThreadAcknowledgment(text, files = []) {
  if (files.length) return false;
  return /^(?:thanks|thank you|thankyou|thx|ty|ok|okay|cool|got it|sounds good|nice|cheers)[.!\s]*$/i.test(String(text || '').trim());
}

export async function authorizeSlackThreadSteer({ source, claimed, task, readRequest, mayUse, userName }) {
  if (!source?.user?.id || !claimed?.user?.id || source.channel !== claimed.channel || source.threadTs !== claimed.threadTs) return null;
  const next = { ...source, ts: String(claimed.ts || '') };
  if (source.user?.id === claimed.user?.id) return next;
  const verified = await readRequest({ channel: source.channel, thread_ts: source.threadTs, ts: next.ts });
  if (!verified || verified.user !== claimed.user?.id || verified.channel !== source.channel
      || verified.thread_ts !== source.threadTs || verified.ts !== next.ts || !await mayUse(verified.user, task)) return null;
  return { ...next, user: { id: verified.user, name: await userName(verified.user) } };
}
