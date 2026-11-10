import { state, type Mention } from '../store';
import type { Task, ContextBlock } from '../types';

// @mention parsing + project-context helpers, ported from the vanilla app.

// Blocks live on the project (repo record) so every workstream shares them.
// Tasks from before repo scoping may still carry their own; the project copy
// wins a name collision because the name is the @[mention] key.
function blocksFor(task: Task): ContextBlock[] {
  const project = state.projects.find((p) => p.path === task.repo);
  const projectBlocks = project?.contextBlocks || [];
  const seen = new Set(projectBlocks.map((block) => (block.name || '').trim().toLowerCase()));
  const legacy = (task.contextBlocks || []).filter((block) => !seen.has((block.name || '').trim().toLowerCase()));
  return [...projectBlocks, ...legacy];
}

export interface ContextItem {
  id: string;
  kind: 'thread' | 'block';
  name: string;
  desc: string;
  uses: string;
}

export function contextItems(task: Task): ContextItem[] {
  const messages = (task.tabs || []).reduce((n, t) => n + (t.messages || []).length, 0);
  const base: ContextItem = {
    id: 'thread',
    kind: 'thread',
    name: task.title || task.repoName,
    desc: 'Shared worktree and conversation context available to every tab in this thread.',
    uses: messages ? messages + ' messages' : 'New',
  };
  const saved: ContextItem[] = blocksFor(task).map((block: ContextBlock) => ({
    id: block.id,
    kind: 'block' as const,
    name: block.name || 'Context block',
    desc: block.content || '',
    uses: 'Custom',
  }));
  return [base].concat(saved);
}

export function contextMatches(task: Task, query: string | undefined): ContextItem[] {
  const q = String(query || '').trim().toLowerCase();
  return contextItems(task).filter((item) => !q || `${item.name} ${item.desc} ${item.uses}`.toLowerCase().includes(q));
}

// Paper 21.1/21.2: one key, everything behind it. The @ menu narrows across
// types, not within one — destinations first (a sibling tab changes who does
// the work), then people (an @ that lands in their Slack), then ingredients
// (a play, a context item change what the turn reads). Time joins when its
// backend exists; absent beats silently broken (a time token must never
// just run).
export interface MentionItem {
  type: 'tab' | 'person' | 'play' | 'context';
  id: string;
  name: string;
  desc: string;
  uses: string;
  // A tab in another workstream: where it lives. Absent for a sibling.
  threadId?: string;
}

export interface Destination { threadId: string; tabId: string; name: string; status?: string; done?: boolean }
export function destinationsElsewhere(task: Task): Destination[] {
  const when = (row: { lastActivity?: string; updatedAt?: string }) => Date.parse(row.lastActivity || row.updatedAt || '') || 0;
  return (state.threads || [])
    .filter((row) => row.id !== task.id && !row.archived)
    .sort((a, b) => when(b) - when(a))
    .flatMap((row) => {
      const title = row.title || row.repoName || 'Untitled';
      return (state.cache[row.id]?.tabs || row.tabs || [])
        .filter((candidate) => candidate.type !== 'duel')
        .map((candidate) => ({ threadId: row.id, tabId: candidate.id, name: `${title} / ${candidate.name || 'Untitled'}`, status: candidate.status, done: candidate.done }));
    });
}

export function mentionMatches(task: Task, currentTabId: string, query: string | undefined): MentionItem[] {
  const q = String(query || '').trim().toLowerCase();
  const hit = (item: MentionItem) => !q || `${item.name} ${item.desc}`.toLowerCase().includes(q);
  const tabs: MentionItem[] = (task.tabs || [])
    .filter((candidate) => candidate.id !== currentTabId && candidate.type !== 'duel')
    .map((candidate) => ({
      type: 'tab' as const,
      id: candidate.id,
      name: candidate.name || 'Untitled',
      desc: 'Hand this message to that tab',
      // Handing to a done tab wakes it (a new message clears the mark).
      uses: candidate.done ? 'done' : candidate.status === 'running' ? 'running' : 'idle',
    }));
  // A tab elsewhere is a destination too. Unfiltered, only the three most
  // recent show so people and ingredients stay in reach; a typed query
  // reaches every one, by tab name or by workstream.
  const elsewhere: MentionItem[] = destinationsElsewhere(task).map((destination) => ({
    type: 'tab' as const,
    id: destination.tabId,
    threadId: destination.threadId,
    name: destination.name,
    desc: 'Hand this message to that tab in another workstream',
    uses: destination.done ? 'done' : destination.status === 'running' ? 'running' : 'idle',
  }));
  // Teammates on the shared project. Picking one drops a plain @Name into
  // the message; the server DMs them on Slack the moment it sends.
  const people: MentionItem[] = (task.shared?.members || [])
    .filter((member) => !member.me && member.name)
    .map((member) => ({
      type: 'person' as const,
      id: member.email,
      name: member.name,
      // The row must not promise a ping this Mac cannot send.
      desc: state.slackReady === false ? 'No Slack message until Slack is connected' : 'Sends this message to them in Slack, not to the model',
      uses: member.online ? 'online' : 'person',
    }));
  const plays: MentionItem[] = (state.plays || []).map((play) => ({
    type: 'play' as const,
    id: play.id,
    name: play.name || 'Play',
    desc: 'Run this message through the play',
    uses: 'play',
  }));
  const context: MentionItem[] = contextItems(task).map((item) => ({
    type: 'context' as const,
    id: item.id,
    name: item.name,
    desc: item.desc,
    uses: item.uses,
  }));
  return [...tabs.filter(hit), ...(q ? elsewhere.filter(hit) : elsewhere.slice(0, 3)), ...people.filter(hit), ...plays.filter(hit), ...context.filter(hit)];
}

export function mentionAtCursor(value: string, cursor: number): Mention | null {
  const before = String(value || '').slice(0, Number.isFinite(cursor) ? cursor : String(value || '').length);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/[\s([{,:;]/.test(before[at - 1]))) return null;
  let query = before.slice(at + 1);
  if (query.startsWith('[')) query = query.slice(1);
  if (query.length > 120 || /[\r\n\]]/.test(query)) return null;
  return { start: at, end: before.length, query, selected: 0 };
}

export function mentionToken(name: string): string {
  return `@[${String(name || 'Context').replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
}
