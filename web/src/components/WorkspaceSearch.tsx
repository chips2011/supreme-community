// THESIS: Command K finds saved work by its words, not only by its title.
// OWN-WORLD: The existing Supreme paper surface, type and ink-blue selection.
// STORY: Search, choose the existing tab, read the matching saved turn.
// FIRST VIEWPORT: One focused input and a keyboard-navigable result list.
// FORM: Narrow extension of the existing Landed search, no new identity.
import { useEffect, useRef, useState } from 'react';
import { state, set, toast } from '../store';
import { loadTask, openThread, openThreadAt, peekArchivedTab } from '../actions';
import { tabSearchMatches } from '../lib/tab-search';
import type { WorkspaceSearchPage, WorkspaceSearchResult } from '../lib/workspace-search';
import { Icon } from '../icons';

export function WorkspaceSearch() {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<WorkspaceSearchPage | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState(false);
  const active = Math.min(selected, Math.max(0, (page?.results.length || 0) - 1));
  const close = () => { state.workspaceSearchOpen = false; set(); };
  useEffect(() => {
    dialog.current?.showModal(); input.current?.focus();
    const prior = previousFocus.current;
    return () => { if (prior?.isConnected) prior.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setError(false); setSelected(0);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?${new URLSearchParams({ q: query, offset: String(offset) })}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Search failed');
        const data = await response.json() as WorkspaceSearchPage;
        if (!controller.signal.aborted) setPage(data);
      } catch { if (!controller.signal.aborted) setError(true); }
    }, query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, offset, retry]);
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const open = async (result: WorkspaceSearchResult) => {
    if (opening) return;
    setOpening(true);
    try {
      const task = await loadTask(result.taskId);
      if (!state.workspaceSearchOpen) return;
      if (result.tabArchived && result.tabId) await peekArchivedTab(result.taskId, result.tabId);
      else if (result.tabId) await openThreadAt(result.taskId, result.tabId);
      else await openThread(result.taskId);
      state.slackReturnThread = null;
      const tab = [...task.tabs, ...(task.archivedTabs || [])].find((item) => item.id === result.tabId);
      if (tab && result.messageQuery && tab.type !== 'duel' && !tab.duel?.choice && tabSearchMatches(tab.messages || [], result.messageQuery).length) {
        state.tabSearch = { key: `${task.id}::${tab.id}`, query: result.messageQuery, selected: 0 };
      } else state.tabSearch = null;
      close();
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-tab-find-input]')?.focus());
    } catch { toast('Could not open that conversation. Try again.'); setOpening(false); }
  };
  return <dialog ref={dialog} role="dialog" aria-label="Search Supreme" data-workspace-search className="workspace-search" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey || event.target !== input.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(Math.max(0, Math.min((page?.results.length || 1) - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))); }
    if (event.key === 'Enter' && page?.results[active]) { event.preventDefault(); void open(page.results[active]); }
  }}>
    <label className="workspace-search-input"><Icon name="search" size={18} /><input ref={input} role="combobox" aria-label="Search all conversations" aria-expanded="true" aria-controls="workspace-search-results" aria-activedescendant={page?.results[active] ? `workspace-result-${active}` : undefined} autoComplete="off" maxLength={200} placeholder="Search Supreme" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /><button type="button" aria-label="Close Supreme search" onClick={close}><Icon name="x" size={18} /></button></label>
    <div className="workspace-search-results" id="workspace-search-results" role="listbox" aria-label="Conversations" aria-busy={!page && !error}>
      {error ? <div className="workspace-search-status" role="status">Could not load search.<button type="button" onClick={() => setRetry(retry + 1)}>Retry</button></div> : !page ? <div className="workspace-search-status" role="status">Searching…</div> : !page.results.length ? <div className="workspace-search-status" role="status">No matching conversations.</div> : page.results.map((result, index) => <button type="button" role="option" tabIndex={-1} id={`workspace-result-${index}`} aria-selected={index === active} disabled={opening} className="workspace-search-result" key={result.id} onClick={() => void open(result)} onPointerMove={() => setSelected(index)}><span className="workspace-search-path"><span>{result.project} / {result.title}{result.tab ? <> / <b>{result.tab}</b></> : null}</span>{result.archived || result.tabArchived ? <small>Archived</small> : null}</span>{result.snippet ? <span className="workspace-search-snippet">{result.snippet}</span> : null}</button>)}
    </div>
    {page && (offset > 0 || page.nextOffset != null) ? <div className="workspace-search-pagination"><button type="button" disabled={!offset} onClick={() => { setOffset(Math.max(0, offset - 30)); input.current?.focus(); }}>Previous</button><span>{offset + 1} to {offset + page.results.length} of {page.total}</span><button type="button" disabled={page.nextOffset == null} onClick={() => { setOffset(page.nextOffset || 0); input.current?.focus(); }}>Next</button></div> : null}
  </dialog>;
}
