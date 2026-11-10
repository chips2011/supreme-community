import { tabConfirmation } from './confirmation.mjs';

const visibleMessages = (tab) => (tab?.messages || []).filter((message) => !message.hiddenInTranscript && !message.note);
const plain = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase();

// History is a projection, never an archive/done write. Slack's saved route
// still targets the same task/tab and provider context when a follow-up lands.
export function slackInboxMetadata(task) {
  if (task?.origin !== 'slack' || task.privateGone) return null;
  const tabs = task.tabs || [];
  const messages = tabs.flatMap(visibleMessages);
  const lastSlack = messages.findLast((message) => message.fromSlack)?.fromSlack;
  const session = task.slackSession;
  const tab = tabs.find((candidate) => visibleMessages(candidate).some((message) => message.fromSlack && (!session || message.fromSlack.channel === session.channel && message.fromSlack.threadTs === session.threadTs)))
    || tabs.find((candidate) => candidate.id === task.activeTab && !candidate.done)
    || tabs.find((candidate) => !candidate.done) || tabs[0] || task.archivedTabs?.[0];
  const channelName = String(lastSlack?.channelName || '').replace(/^#/, '');
  let state = 'finished';
  let reason = '';
  if (!task.archived && tabs.some((candidate) => !candidate.done && (candidate.activeRun || candidate.status === 'running' || candidate.queue?.some((item) => ['queued', 'running'].includes(item.status))))) state = 'working';
  else if (!task.archived) {
    for (const candidate of tabs.filter((item) => !item.done && item.type !== 'duel')) {
      const last = visibleMessages(candidate).at(-1);
      if (tabConfirmation(candidate)) reason = 'Confirmation';
      else if (last?.ok === false || candidate.status === 'error') reason = 'Run failed';
      else if (last?.stopped) reason = 'Run stopped';
      else if ((last?.outsideTouches || last?.connectors || []).some((touch) => touch.action === 'draft' && touch.state === 'done') && !(last?.outsideTouches || last?.connectors || []).some((touch) => ['send', 'publish'].includes(touch.action) && touch.state === 'done')) reason = 'Draft ready';
      else if (!last || last.role === 'user') reason = 'No answer';
      if (reason) { state = 'needs-you'; break; }
    }
  }
  return { state, reason, tabId: tab?.id || null, channelName };
}

export function slackInboxMatches(task, query) {
  const words = plain(query).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = plain([task.title, slackInboxMetadata(task)?.channelName,
    ...(task.tabs || []).flatMap(visibleMessages).filter((message) => ['user', 'assistant'].includes(message.role)).map((message) => message.content),
    ...(task.archivedTabs || []).flatMap(visibleMessages).filter((message) => ['user', 'assistant'].includes(message.role)).map((message) => message.content),
  ].join('\n'));
  return words.every((word) => text.includes(word));
}

export function slackInboxPage(summaries, { query = '', filter = 'active', offset = 0, limit = 50, readTask = () => null } = {}) {
  const all = summaries.filter((row) => row.origin === 'slack' && row.slackInbox);
  const active = (row) => !row.archived && row.slackInbox.state !== 'finished';
  const counts = { active: all.filter(active).length, history: all.filter((row) => !active(row)).length };
  const safeQuery = String(query).trim().slice(0, 200);
  const matching = safeQuery ? all.filter((row) => {
    const quick = plain(`${row.title}\n${row.slackInbox.channelName}`);
    if (plain(safeQuery).split(/\s+/).every((word) => quick.includes(word))) return true;
    const task = readTask(row.id);
    return !!task && task.origin === 'slack' && slackInboxMatches(task, safeQuery);
  }) : all;
  const selected = matching.filter((row) => filter === 'history' ? !active(row) : active(row))
    .sort((a, b) => String(b.lastActivity || b.updatedAt || '').localeCompare(String(a.lastActivity || a.updatedAt || '')));
  const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0);
  const size = Math.max(1, Math.min(50, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50));
  return {
    tasks: selected.slice(start, start + size), counts, total: selected.length,
    otherCount: matching.length - selected.length,
    nextOffset: start + size < selected.length ? start + size : null,
  };
}
