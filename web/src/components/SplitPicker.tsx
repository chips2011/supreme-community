import { useEffect, useState } from 'react';
import { useApp, state, set } from '../store';
import { loadTask, openProjectSplit, openThreadSplit } from '../actions';

type SplitScope = 'project' | 'thread' | 'tab';

const SCOPES: Array<{ id: SplitScope; label: string }> = [
  { id: 'project', label: 'Project' },
  { id: 'thread', label: 'Workstream' },
  { id: 'tab', label: 'Tab' },
];

export function SplitPicker({ paneIdx }: { paneIdx: number }) {
  const s = useApp();
  const [scope, setScope] = useState<SplitScope>('tab');
  const [query, setQuery] = useState('');
  const [loadingTabs, setLoadingTabs] = useState(false);
  const threads = s.threads.filter((thread) => !thread.archived);
  const threadKey = threads.map((thread) => thread.id).join('|');

  useEffect(() => {
    if (scope !== 'tab') {
      setLoadingTabs(false);
      return;
    }
    const missing = state.threads.filter((thread) => !thread.archived && !state.cache[thread.id]);
    if (!missing.length) {
      setLoadingTabs(false);
      return;
    }
    let cancelled = false;
    setLoadingTabs(true);
    Promise.all(missing.map((thread) => loadTask(thread.id).catch(() => null))).then(() => {
      if (cancelled) return;
      setLoadingTabs(false);
      set();
    });
    return () => { cancelled = true; };
  }, [scope, threadKey]);

  const activePane = s.panes[paneIdx] || s.panes[s.activePane] || s.panes[0];
  const activeTask = activePane && s.cache[activePane.threadId];
  const activeTab = activeTask && (activeTask.tabs || []).find((tab) => tab.id === activePane.tabId);
  const beside = activeTab?.name || activeTask?.title || 'this pane';
  const needle = query.trim().toLowerCase();
  const projectNameByPath = new Map(s.projects.map((project) => [project.path, project.name]));
  const opened = new Set(s.panes.map((pane) => `${pane.threadId}::${pane.tabId}`));

  const projects = s.projects.filter((project) => !project.archived && (!needle || project.name.toLowerCase().includes(needle)));
  const matchingThreads = threads.filter((thread) => {
    const project = projectNameByPath.get(thread.repo) || thread.repoName || 'Project';
    return !needle || `${project} ${thread.title}`.toLowerCase().includes(needle);
  });
  const tabs = threads.flatMap((thread) => {
    const task = s.cache[thread.id];
    if (!task) return [];
    const project = projectNameByPath.get(thread.repo) || thread.repoName || 'Project';
    return (task.tabs || []).map((tab) => ({ tab, thread, project }));
  }).filter((choice) => !needle || `${choice.project} ${choice.thread.title} ${choice.tab.name}`.toLowerCase().includes(needle));

  return (
    <>
      <div className="hd split-title">Open beside “{beside}”</div>
      <div className="split-scopes" role="tablist" aria-label="Split by">
        {SCOPES.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={scope === item.id}
            className={scope === item.id ? 'sel' : ''}
            onClick={() => setScope(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <label className="split-search">
        <span>Search</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Projects, workstreams, or tabs"
        />
      </label>
      <div className="split-options">
        {scope === 'project' ? projects.map((project) => (
          <button className="split-choice" key={project.path} onClick={() => void openProjectSplit(project.path, paneIdx)}>
            <span className="split-kind">P</span>
            <span><b>{project.name}</b><small>Most recent unopened workstream or tab</small></span>
            <em>{threads.filter((thread) => thread.repo === project.path).length} workstreams</em>
          </button>
        )) : null}
        {scope === 'thread' ? matchingThreads.map((thread) => (
          <button className="split-choice" key={thread.id} onClick={() => void openThreadSplit(thread.id, null, paneIdx)}>
            <span className="split-kind">T</span>
            <span><b>{thread.title}</b><small>{projectNameByPath.get(thread.repo) || thread.repoName || 'Project'}</small></span>
            <em>{thread.tabCount} {thread.tabCount === 1 ? 'tab' : 'tabs'}</em>
          </button>
        )) : null}
        {scope === 'tab' ? tabs.map(({ tab, thread, project }) => {
          const isOpen = opened.has(`${thread.id}::${tab.id}`);
          // An open tab's row is not dead: clicking it takes you to the
          // pane it lives in (the split path already resolves to the
          // existing pane), so the picker can always get you into a tab.
          return (
            <button
              className="split-choice"
              key={`${thread.id}:${tab.id}`}
              title={isOpen ? 'Already open. Takes you to it.' : undefined}
              onClick={() => void openThreadSplit(thread.id, tab.id, paneIdx)}
            >
              <span className="split-kind">⌘</span>
              <span><b>{tab.name}</b><small>{project} › {thread.title}</small></span>
              <em>{isOpen ? 'Open' : 'Add'}</em>
            </button>
          );
        }) : null}
        {scope === 'tab' && loadingTabs ? <div className="split-empty">Loading tabs…</div> : null}
        {scope === 'project' && !projects.length ? <div className="split-empty">No matching projects.</div> : null}
        {scope === 'thread' && !matchingThreads.length ? <div className="split-empty">No matching workstreams.</div> : null}
        {scope === 'tab' && !loadingTabs && !tabs.length ? <div className="split-empty">No matching tabs.</div> : null}
      </div>
      <div className="split-hint">Drag a project or workstream onto a pane, or drag one visible tab onto another, to split directly.</div>
    </>
  );
}
