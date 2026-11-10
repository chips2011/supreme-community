import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { state, set, toast, useApp } from '../store';
import { loadTask, openThreadAt } from '../actions';
import { slackTitle } from '../lib/slackInbox';
import type { TaskSummary } from '../types';
import { TopBar } from './bits';

type InboxPage = { tasks: TaskSummary[]; counts: { active: number; history: number }; total: number; otherCount: number; nextOffset: number | null };
const labels = { working: 'Working', 'needs-you': 'Needs you', finished: 'Finished' };
const pageUrl = (filter: string, query: string, offset = 0) => `/api/slack/inbox?${new URLSearchParams({ filter, q: query, offset: String(offset), limit: '50' })}`;
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value)) : '';

export function SlackInboxView() {
  const s = useApp();
  const filter = s.slackInboxFilter;
  const query = s.slackInboxQuery;
  const offset = s.slackInboxOffset;
  const [page, setPage] = useState<InboxPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    const current = ++generation.current;
    let controller: AbortController | null = null;
    let busy = false;
    const read = async (refresh = false) => {
      if (busy || (refresh && document.hidden)) return;
      busy = true;
      controller = new AbortController();
      if (!refresh) setLoading(true);
      try {
        const result = await api<InboxPage>(pageUrl(filter, query, offset), { signal: controller.signal });
        if (current !== generation.current || controller.signal.aborted) return;
        setPage(result); setError('');
        state.slackInboxCounts = result.counts;
        // Same summaries as the rail, with newly arrived Slack requests added.
        const fresh = new Map(result.tasks.map((task) => [task.id, task]));
        state.threads = [...state.threads.map((task) => fresh.get(task.id) || task), ...result.tasks.filter((task) => !state.threads.some((old) => old.id === task.id))];
        set();
      } catch (reason) {
        if (current === generation.current && !controller?.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load Slack requests.');
      } finally {
        busy = false;
        if (current === generation.current) setLoading(false);
      }
    };
    setPage(null);
    const delay = window.setTimeout(() => { void read(); }, first.current ? 0 : 180);
    first.current = false;
    const timer = window.setInterval(() => { void read(true); }, 10_000);
    const focus = () => { void read(true); };
    window.addEventListener('focus', focus);
    return () => {
      generation.current += 1;
      window.clearTimeout(delay); window.clearInterval(timer);
      window.removeEventListener('focus', focus);
      controller?.abort();
    };
  }, [filter, query, offset, reload]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || target.closest('input,textarea,[contenteditable],[role="dialog"]') || state.pop || state.shareDialog || state.renaming) return;
      if (event.key === '/') { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const open = async (row: TaskSummary) => {
    if (opening) return;
    setOpening(row.id);
    try {
      await loadTask(row.id);
      await openThreadAt(row.id, row.slackInbox?.tabId);
      state.slackReturnThread = row.id;
      set();
    } catch (reason) { toast(reason instanceof Error ? reason.message : 'Could not open this conversation.'); }
    finally { setOpening(null); }
  };
  const counts = page?.counts || s.slackInboxCounts;
  return (
    <div className="slack-inbox" data-slack-inbox>
      <TopBar><span className="slack-top-name">Slack</span></TopBar>
      <div className="slack-scroll">
        <section className="slack-index" aria-label="Slack requests">
          <header className="slack-index-title"><h1>Slack</h1></header>
          <div className="slack-tools">
            <div className="slack-tabs" role="tablist" aria-label="Request state">
              {(['active', 'history'] as const).map((value) => <button type="button" role="tab" key={value} id={`slack-${value}-tab`} tabIndex={filter === value ? 0 : -1} aria-selected={filter === value} aria-controls="slack-requests-panel" onClick={() => { state.slackInboxFilter = value; state.slackInboxOffset = 0; set(); }} onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 'active' : event.key === 'End' ? 'history' : value === 'active' ? 'history' : 'active';
                state.slackInboxFilter = next; state.slackInboxOffset = 0; set(); document.getElementById(`slack-${next}-tab`)?.focus();
              }}>{value === 'active' ? 'Active' : 'History'}{counts ? <span>{counts[value]}</span> : null}</button>)}
            </div>
            <label className="slack-search"><Icon name="search" size={15} /><input ref={search} value={query} maxLength={200} onChange={(event) => { state.slackInboxQuery = event.target.value; state.slackInboxOffset = 0; set(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); state.slackInboxQuery = ''; state.slackInboxOffset = 0; set(); search.current?.blur(); } }} placeholder={filter === 'history' ? 'Search history' : 'Search requests'} aria-label={filter === 'history' ? 'Search history' : 'Search requests'} />{query ? <button type="button" aria-label="Clear search" onClick={() => { state.slackInboxQuery = ''; state.slackInboxOffset = 0; set(); search.current?.focus(); }}><Icon name="x" size={13} /></button> : <kbd>/</kbd>}</label>
          </div>
          <div className="slack-list" id="slack-requests-panel" role="tabpanel" aria-labelledby={`slack-${filter}-tab`} aria-busy={loading}>
            {error ? <div className="slack-load-error" role="alert">Could not refresh Slack requests.<button type="button" onClick={() => setReload((value) => value + 1)}>Try again</button></div> : null}
            {!page ? <div className="slack-empty" role="status">{error ? 'Your saved conversations are unchanged.' : 'Loading Slack requests...'}</div> : page.tasks.length ? (
              <><div className="slack-list-labels" aria-hidden><span>Request</span><span>Status</span><span>Updated</span></div>{page.tasks.map((row) => {
                const status = row.slackInbox?.state || 'finished';
                return <button type="button" key={row.id} className="slack-request" data-slack-request={row.id} disabled={opening !== null} onClick={() => { void open(row); }}>
                  <span className="slack-request-name" title={slackTitle(row.title)}>{slackTitle(row.title)}</span>
                  <span className={`slack-status ${status}`} title={row.slackInbox?.reason || undefined}><i />{opening === row.id ? 'Opening...' : row.archived ? 'Archived' : labels[status]}</span>
                  <time>{date(row.lastActivity || row.updatedAt)}</time><Icon name="chevronRight" size={14} />
                </button>;
              })}</>
            ) : <div className="slack-empty">{query ? 'No matching requests.' : filter === 'active' ? 'You’re caught up.' : 'No finished conversations yet.'}{filter === 'active' && page.otherCount ? <button type="button" onClick={() => { state.slackInboxFilter = 'history'; state.slackInboxOffset = 0; set(); }}>{query ? `Search History (${page.otherCount})` : 'History'}<Icon name="arrowRight" size={14} /></button> : null}</div>}
            {page && (offset > 0 || page.nextOffset != null) ? <div className="slack-pagination"><button type="button" disabled={loading || offset === 0} onClick={() => { state.slackInboxOffset = Math.max(0, offset - 50); set(); }}><Icon name="chevronLeft" size={13} />Previous</button><span>{Math.floor(offset / 50) + 1} / {Math.ceil(page.total / 50)}</span><button type="button" disabled={loading || page.nextOffset == null} onClick={() => { state.slackInboxOffset = page.nextOffset || 0; set(); }}>Next<Icon name="chevronRight" size={13} /></button></div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
