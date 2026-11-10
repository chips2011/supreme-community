// Local, read-only search. The caller supplies the same visible summaries
// used by the task list; provider instructions and tool logs are not indexed.
const plain = (value) => String(value || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
const norm = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase();
const matches = (value, query) => norm(value).includes(norm(query)) || norm(plain(value)).includes(norm(query));

export function workspaceSearch(summaries, { query = '', offset = 0, limit = 30, readTask = () => null, projects = [] } = {}) {
  const q = String(query).replace(/\s+/g, ' ').trim().slice(0, 200);
  const results = [];
  const ordered = summaries.filter((task) => !task.privateGone).toSorted((a, b) => String(b.lastActivity || b.updatedAt || '').localeCompare(String(a.lastActivity || a.updatedAt || '')));
  for (const row of ordered) {
    const project = projects.find((item) => row.projectId && item.id === row.projectId || item.path === row.repo);
    const projectName = project?.name || row.repoName || '';
    const headerMatch = q && matches(`${projectName} ${row.title}`, q);
    // No query means a lightweight recent-tab picker, with no full reads.
    const task = q ? readTask(row.id) : row;
    if (!task || task.privateGone) continue;
    const tabs = [...(task.tabs || []), ...(task.archivedTabs || [])];
    if (!tabs.length && (!q || headerMatch)) results.push({ id: row.id, taskId: row.id, tabId: null, title: row.title, project: projectName, tab: '', archived: !!row.archived, tabArchived: false, matches: 0, snippet: '', messageQuery: '' });
    for (const tab of tabs) {
      const textHits = q ? (tab.messages || []).filter((message) => !message.hiddenInTranscript && !message.note && ['user', 'assistant', 'tab', 'email'].includes(message.role) && matches(message.batch?.length ? message.batch.join('\n') : message.content, q)) : [];
      if (q && !headerMatch && !matches(tab.name, q) && !textHits.length) continue;
      const text = textHits.length ? plain(textHits[0].batch?.length ? textHits[0].batch.join(' ') : textHits[0].content) : '';
      const at = Math.max(0, norm(text).indexOf(norm(q)));
      const start = Math.max(0, at - 45);
      const snippet = text ? `${start ? '…' : ''}${text.slice(start, start + 180)}${text.length > start + 180 ? '…' : ''}` : '';
      results.push({ id: `${row.id}::${tab.id}`, taskId: row.id, tabId: tab.id, title: row.title, project: projectName, tab: tab.name || 'Main', archived: !!row.archived, tabArchived: !!task.archivedTabs?.some((item) => item.id === tab.id), matches: textHits.length, snippet, messageQuery: textHits.length ? q : '' });
    }
  }
  const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0);
  const size = Math.max(1, Math.min(50, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 30));
  return { results: results.slice(start, start + size), total: results.length, nextOffset: start + size < results.length ? start + size : null };
}
