import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type MouseEventHandler } from 'react';
import { taskConfirmationCount, pendingConfirmation, confirmationWaitingOn, useApp, state, set, threadsForRepo, toast } from '../store';
import type { View } from '../store';
import { Icon } from '../icons';
import { RenameInput } from './RenameInput';
import { OrchMark } from './OrchMark';
import { inTree, orchestratorCards, rowUnread, threadUnread } from '../lib/rail';
import { landedRows } from '../lib/landed';
import { slackAttentionCount, slackOnlyProject } from '../lib/slackInbox';
import {
  navigate, openThread, openThreadAt, loadTask, createNamedThread, unarchiveThread, archiveProject, peekArchivedTab, restoreTab, addProject, beginProjectCreation,
  cancelProjectCreation, setUserName, deleteArchivedProject, deleteArchivedThread, deleteArchivedTab, deleteProject,
  toggleThreadPinned, archiveThread, deleteThread, openShareDialog, setMapOn, openMap,
} from '../actions';
import type { Project, TaskSummary } from '../types';
import { initials as personInitials } from '../lib/people';
import {
  projectDragStart, threadDragStart, tabDragStart, dragEnd, tabTargetOver, tabTargetLeave, threadRowDrop, projectRowDrop, projectTargetOver,
} from '../lib/dnd';
import { signOutAccount, resetThisMac } from '../auth';
import { projectAsleep, tabAsleep, tabVitality, threadAsleep, threadVitality } from '../lib/vitality';

type ArchivedTarget =
  | { kind: 'project'; id: string; name: string }
  // A live project's right-click menu (Paper 13.1): rename, archive, delete.
  | { kind: 'live-project'; id: string; name: string }
  // The same menu on a live workstream row.
  | { kind: 'live-thread'; id: string; name: string }
  | { kind: 'thread'; id: string; name: string }
  | { kind: 'tab'; id: string; threadId: string; name: string };

type ArchivedMenu = ArchivedTarget & { left: number; top: number };

function NavItem({ id, label, iconName, count, also = [], roll = false }: { id: View; label: string; iconName?: string; count?: number; also?: View[]; roll?: boolean }) {
  const s = useApp();
  return (
    <span className={s.view === id || also.includes(s.view) || id === 'slack' && s.view === 'tab' && s.slackReturnThread === s.panes[s.activePane]?.threadId ? 'sel' : ''} onClick={() => navigate(id)} role={id === 'slack' ? 'button' : undefined} tabIndex={id === 'slack' ? 0 : undefined} onKeyDown={id === 'slack' ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(id); } } : undefined}>
      <Icon name={iconName || id} size={14} />{label}
      {count ? (roll ? <em key={count} className="roll">{count}</em> : <em>{count}</em>) : null}
    </span>
  );
}

function FooterNavItem({
  label,
  iconName,
  selected = false,
  count,
  onClick,
}: {
  label: string;
  iconName: string;
  selected?: boolean;
  count?: number;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className={`rail-footer-item${selected ? ' sel' : ''}`}
      onClick={onClick}
    >
      <Icon name={iconName} size={14} />
      <span>{label}</span>
      {typeof count === 'number' ? <em>{count}</em> : null}
    </button>
  );
}

function elapsedSince(value: string | undefined, now: number): string {
  const start = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'W';
  return `${parts[0][0] || ''}${parts.length > 1 ? parts[parts.length - 1][0] || '' : ''}`.toUpperCase();
}

export function Rail() {
  const s = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [projectName, setProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [archivedMenu, setArchivedMenu] = useState<ArchivedMenu | null>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const activeProjects = s.projects.filter((p) => !p.archived && !slackOnlyProject(p, s.threads));
  // Same team (Paper 19.5): every shared project, mine or theirs, sits under
  // Shared; only what nobody else can see stays under Private.
  const sharedWithMe = activeProjects.filter((p) => !!p.shared);
  const privateProjects = activeProjects.filter((p) => !p.shared);
  const starred = s.threads.filter((t) => t.pinned && !t.archived && !t.done && inTree(t));
  // Section 28: each orchestrator is a card in its own zone above the tree.
  const orchCards = orchestratorCards();
  const archThreadCount = s.threads.filter((t) => t.archived).length;
  const archProjCount = s.projects.filter((p) => p.archived).length;
  const archTabCount = s.threads.reduce((total, t) => total + Number(t.archivedTabCount || 0), 0);
  const archTotal = archThreadCount + archProjCount + archTabCount;
  const archProjects = s.showArchived ? s.projects.filter((p) => p.archived) : [];
  const hasRunningThread = s.threads.some((thread) => threadVitality(thread) === 'working');
  // Paper 16.7, cut back by 28.3: a row that finishes on this Mac fills green
  // once, left to right, and then the lane empties. Green is a moment, not a
  // state, so rows that were already finished when the rail drew carry nothing.
  const lastVitality = useRef(new Map<string, string>());
  const landedHere = useRef(new Map<string, number>());
  const LANDING_MS = 900;
  const noteVitality = (key: string, vitality: string): boolean => {
    if (lastVitality.current.get(key) === 'working' && vitality === 'awake') {
      landedHere.current.set(key, Date.now());
      window.setTimeout(() => setNow(Date.now()), LANDING_MS + 50);
    }
    if (vitality !== 'awake') landedHere.current.delete(key);
    lastVitality.current.set(key, vitality);
    return Date.now() - (landedHere.current.get(key) || 0) < LANDING_MS;
  };
  useEffect(() => {
    if (!hasRunningThread) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningThread]);
  useEffect(() => {
    if (!s.projectCreateOpen) return;
    setProjectName('');
    requestAnimationFrame(() => projectInput.current?.focus());
  }, [s.projectCreateOpen]);
  useEffect(() => {
    if (!archivedMenu) return undefined;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.archive-context-menu')) return;
      setArchivedMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArchivedMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [archivedMenu]);

  const openArchivedMenu = (event: ReactMouseEvent, target: ArchivedTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const live = target.kind === 'live-project' || target.kind === 'live-thread';
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - (live ? 160 : 94)));
    setArchivedMenu({ ...target, left, top });
  };

  const unarchiveMenuTarget = () => {
    const target = archivedMenu;
    setArchivedMenu(null);
    if (!target) return;
    if (target.kind === 'live-project' || target.kind === 'live-thread') return;
    if (target.kind === 'project') void archiveProject(target.id, false);
    else if (target.kind === 'thread') void unarchiveThread(target.id);
    else void restoreTab(target.threadId, target.id, null);
  };

  const deleteMenuTarget = () => {
    const target = archivedMenu;
    setArchivedMenu(null);
    if (!target) return;
    if (target.kind === 'live-project' || target.kind === 'live-thread') return;
    if (target.kind === 'project') void deleteArchivedProject(target.id);
    else if (target.kind === 'thread') void deleteArchivedThread(target.id);
    else void deleteArchivedTab(target.threadId, target.id);
  };

  const submitProject = async (event: FormEvent) => {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) {
      projectInput.current?.setCustomValidity('Name your project');
      projectInput.current?.reportValidity();
      return;
    }
    setProjectBusy(true);
    const created = await addProject(name);
    setProjectBusy(false);
    if (created) setProjectName('');
  };

  const cancelNewProject = () => {
    if (projectBusy) return;
    setProjectName('');
    cancelProjectCreation();
  };

  const toggleThreadTabs = (threadId: string) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId); else next.add(threadId);
      return next;
    });
    // Show cached names immediately, then refresh so tabs created in another
    // pane or on another Mac are included too. This only reads the thread and
    // does not change the pane the user is currently working in.
    void loadTask(threadId).then(() => set()).catch((error) => toast((error as Error).message));
  };

  const openThreadTab = (threadId: string, tabId: string) => openThreadAt(threadId, tabId);

  // One workstream row, under its project or under Starred.
  const threadRow = (t: TaskSummary) => {
                const sel = s.panes.some((pn) => pn.threadId === t.id);
                const task = s.cache[t.id];
                const tabsExpanded = expandedThreads.has(t.id);
                const confirmations = task ? taskConfirmationCount(task) : Number(t.needsConfirmationCount || 0);
                const vitality = threadVitality(t);
                // The card takes the orchestrator and its marks with it, so a
                // loaded workstream reads as working off the tabs it lists.
                const running = vitality === 'working' && (!task || !(task.tabs || []).some((tab) => tab.type === 'orchestrator')
                  || (task.tabs || []).some((tab) => !tab.done && tab.type !== 'orchestrator' && tabVitality(task, tab) === 'working'));
                const asleep = !running && threadAsleep(t);
                const liveStream = Object.values(s.streams).find((stream) => stream.threadId === t.id && !stream.landed);
                const startedAt = task?.tabs?.find((tab) => tab.status === 'running' || tab.activeRun)?.activeRun?.startedAt
                  || liveStream?.startedAt || t.lastActivity;
                const holding = liveStream?.computer?.state === 'paused';
                const landing = noteVitality(t.id, vitality) && !confirmations;
                // Section 28: one steady mark, a tab here answered and you
                // have not read it. It sits on the tab and on every row the
                // tab folds into, open or shut (boards 28.4 and 28.5).
                const unseen = threadUnread(t) > 0;
                return (
                  <div key={t.id}>
                    <div
                      className={`br thread-row ${sel ? 'sel' : ''} ${confirmations ? 'needs-confirmation' : ''}${asleep ? ' asleep' : ''}${unseen ? ' unseen' : ''}`}
                      onContextMenu={(event) => openArchivedMenu(event, { kind: 'live-thread', id: t.id, name: t.title })}
                      draggable
                      onDragStart={(e) => threadDragStart(e, t.id)}
                      onDragEnd={dragEnd}
                      onDragOver={tabTargetOver}
                      onDragLeave={tabTargetLeave}
                      onDrop={(e) => threadRowDrop(e, t.id)}
                    >
                      <button
                        type="button"
                        className={`thread-disclosure${tabsExpanded ? ' open' : ''}`}
                        title={tabsExpanded ? 'Hide tabs' : 'Show tabs'}
                        aria-label={`${tabsExpanded ? 'Hide' : 'Show'} tabs in ${t.title}`}
                        aria-expanded={tabsExpanded}
                        onClick={(event) => { event.stopPropagation(); toggleThreadTabs(t.id); }}
                      >
                        <Icon name="chevronDown" size={11} />
                      </button>
                      <button
                        type="button"
                        className="thread-open"
                        title={`Double-click to ${tabsExpanded ? 'hide' : 'show'} tabs`}
                        aria-expanded={tabsExpanded}
                        onClick={(event) => { if (event.detail < 2) void openThread(t.id); }}
                        onDoubleClick={(event) => { event.preventDefault(); toggleThreadTabs(t.id); }}
                      >
                        <span className="thread-name">{t.title}</span>
                        {t.remoteRun && running ? <span className="av-mini" title={`${t.remoteRun.name}'s Mac is working`} data-remote-row={t.remoteRun.name}>{personInitials(t.remoteRun.name)}</span> : null}
                        {(t.viewers || []).slice(0, 2).map((viewer) => <span key={viewer.id} className="av-mini viewer" title={`${viewer.name} is here`} data-viewer-row={viewer.name}>{personInitials(viewer.name)}</span>)}
                        {confirmations ? <span className="thread-waiting">{confirmations > 1 ? `${confirmations} replies` : 'reply'}</span> : t.done ? <span className="thread-done">done</span> : running ? <time>{elapsedSince(startedAt, now)}</time> : null}
                        {/* Board 28.3: one lane on the right and one thing in
                            it. At rest a row is its name and nothing else. */}
                        {confirmations || t.done
                          ? null
                          : running
                            ? (s.motion.edges
                              ? <span className={`thread-run${holding ? ' hold' : ''}`} aria-label="Working"><i /><b /></span>
                              : <span className="dot run" aria-label="Working" />)
                            : landing && s.motion.edges
                              ? <span className="thread-run landing" aria-label="Finished"><i /><b /></span>
                              : unseen
                                ? <span className="rail-unread" data-rail-unread aria-label="Unread answer" />
                                : vitality === 'failed'
                                  ? <span className="dot err" aria-label="Stopped" />
                                  : null}
                      </button>
                      <button
                        type="button"
                        className={`thread-pin ${t.pinned ? 'on' : ''}`}
                        title={t.pinned ? 'Unpin workstream' : 'Pin workstream'}
                        aria-label={`${t.pinned ? 'Unpin' : 'Pin'} ${t.title}`}
                        aria-pressed={!!t.pinned}
                        onClick={() => void toggleThreadPinned(t.id)}
                      >
                        <Icon name="star" size={12} />
                      </button>
                    </div>
                    {tabsExpanded ? (
                      <div className="workstream-tabs" role="group" aria-label={`Tabs in ${t.title}`} data-thread-tabs={t.id}>
                        {task ? task.tabs.filter((tab) => !tab.done && tab.type !== 'orchestrator').map((tab) => {
                          const tabSelected = s.view === 'tab'
                            && s.panes.some((pane) => pane.threadId === t.id && pane.tabId === tab.id);
                          const tabRunning = tab.status === 'running' || !!tab.activeRun;
                          const tabWaiting = !!pendingConfirmation(tab) && !confirmationWaitingOn(tab);
                          // A tab that lands on this Mac fills green once and
                          // the lane empties; one that answered while you were
                          // elsewhere keeps the dot, and a bold name, until
                          // you open it.
                          const tabState = tabVitality(task, tab);
                          const tabSleeping = tabState !== 'working' && tabAsleep(task, tab);
                          const tabFailed = tabState === 'failed' && !tabSleeping;
                          const tabLanding = noteVitality(`${t.id}:${tab.id}`, tabState) && !tabWaiting;
                          const tabRow = (t.tabs || []).find((row) => row.id === tab.id) || { id: tab.id, name: tab.name, done: tab.done, type: tab.type };
                          const tabNew = !tabSelected && rowUnread(t.id, tabRow);
                          return (
                            <button
                              type="button"
                              key={tab.id}
                              className={`br workstream-tab${tabSelected ? ' sel' : ''}${tabRunning ? ' working' : ''}${tabWaiting ? ' needs-confirmation' : ''}${tabNew ? ' unseen' : ''}${s.drag?.tab === `${t.id}::${tab.id}` ? ' drag-source' : ''}`}
                              data-workstream-tab={tab.id}
                              aria-current={tabSelected ? 'page' : undefined}
                              title={tabNew ? 'Answered since you last looked' : undefined}
                              onClick={() => void openThreadTab(t.id, tab.id)}
                              // Connected tabs, board 3: a tab row drags onto a
                              // map's canvas, from any workstream; the row
                              // dims while it is in the air.
                              draggable
                              onDragStart={(event) => { tabDragStart(event, `${t.id}::${tab.id}`); set(); }}
                              onDragEnd={() => { dragEnd(); set(); }}
                            >
                              <span className="thread-name">{tab.name}</span>
                              {tabWaiting
                                ? <span className="thread-waiting">reply</span>
                                : tabRunning
                                  ? <><time>{elapsedSince(tab.activeRun?.startedAt, now)}</time>{s.motion.edges
                                    ? <span className="thread-run" aria-label="Working"><i /><b /></span>
                                    : <span className="dot run" aria-label="Working" />}</>
                                  : tabLanding && s.motion.edges
                                    ? <span className="thread-run landing" aria-label="Finished"><i /><b /></span>
                                    : tabNew
                                      ? <span className="rail-unread" data-rail-unread aria-label="Unread answer" />
                                      : tabFailed
                                        ? <span className="dot err" aria-label="Stopped" />
                                        : null}
                            </button>
                          );
                        }) : <div className="workstream-tabs-loading">Loading tabs…</div>}
                      </div>
                    ) : null}
                    {s.showArchived
                      ? (t.archivedTabs || []).map((tab) => (
                        // Paper 20.6: click peeks (read-only, leaves when you
                        // switch away); Restore is the hover control.
                        <button
                          key={tab.id}
                          className="br archived-tab"
                          title="Read archived tab"
                          onClick={() => void peekArchivedTab(t.id, tab.id)}
                          onContextMenu={(event) => openArchivedMenu(event, { kind: 'tab', id: tab.id, threadId: t.id, name: tab.name })}
                        >
                          <span className="thread-arrow">↳</span>
                          <span className="thread-name">{tab.name}</span>
                          <em
                            role="button"
                            aria-label={`Restore ${tab.name}`}
                            title="Restore"
                            onClick={(event) => { event.stopPropagation(); void restoreTab(t.id, tab.id, null); }}
                          >
                            <Icon name="restore" size={12} />
                          </em>
                        </button>
                      ))
                      : null}
                  </div>
                );
              };
  const projectRow = (p: Project) => {
          const threads = threadsForRepo(p.path).filter((t) => !t.pinned && inTree(t) && t.origin !== 'slack');
          const isCollapsed = collapsed.has(p.path);
          const editing = s.renaming && s.renaming.kind === 'project' && s.renaming.id === p.path;
          const projectSleeping = projectAsleep(threads);
          // Board 28.5: shut the project and its unread answers become a
          // plain number on the folder.
          const foldedUnread = isCollapsed ? threads.reduce((total, thread) => total + threadUnread(thread), 0) : 0;
          return (
            <div key={p.path}>
              <div
                className={`prj${projectSleeping ? ' asleep' : ''}`}
                draggable
                onDragStart={(e) => projectDragStart(e, p.path)}
                onDragEnd={dragEnd}
                onDragOver={projectTargetOver}
                onDragLeave={tabTargetLeave}
                onDrop={(e) => projectRowDrop(e, p.path)}
                onContextMenu={(event) => openArchivedMenu(event, { kind: 'live-project', id: p.path, name: p.name })}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(p.path)) next.delete(p.path); else next.add(p.path);
                  return next;
                })}
              >
                <span className={`project-caret ${isCollapsed ? 'closed' : ''}`}><Icon name="chevronDown" size={12} /></span>
                <span className="prjic"><Icon name="folder" size={13} /></span>
                {editing ? (
                  <RenameInput className="reninp" style={{ flex: 1 }} value={p.name} />
                ) : (
                  <span
                    className={`prj-name${foldedUnread ? ' counted' : ''}`}
                    title={`${p.name} · double-click to rename`}
                    onDoubleClick={() => { state.renaming = { kind: 'project', id: p.path }; set(); }}
                  >
                    {p.name}
                  </span>
                )}
                {foldedUnread && !editing ? <span className="prj-unread" data-prj-unread={foldedUnread} aria-label={`${foldedUnread} unread`}>{foldedUnread}</span> : null}
                {p.shared?.members?.some((member) => !member.me && member.accepted) ? (
                  <span className="prj-members" aria-label="Shared with">
                    {p.shared.members.filter((member) => !member.me && member.accepted).slice(0, 3).map((member) => {
                      // Clicking a teammate's chip jumps to where they are:
                      // the thread and tab their presence row says they view.
                      // The cache copy of an open thread refreshes every
                      // 1.2s; the list row is only as fresh as the last
                      // thread refresh, so prefer the cache.
                      // Presence rows carry the user id, not the membership
                      // row id.
                      const seat = member.userId ? threads
                        .map((row) => ({ row, viewer: ((s.cache[row.id]?.viewers ?? row.viewers) || []).find((viewer) => viewer.id === member.userId) }))
                        .find((candidate) => candidate.viewer) : undefined;
                      const first = member.name.split(' ')[0];
                      return (
                        <b
                          key={member.id}
                          className={`av-mini${member.online ? ' on' : ''}${seat ? ' seated' : ''}`}
                          title={seat ? `${first} is in ${seat.row.title} — click to join them` : member.name}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!seat) { toast(`${first} isn't in any of these workstreams right now`); return; }
                            if (seat.viewer!.tabId) void openThreadTab(seat.row.id, seat.viewer!.tabId);
                            else void openThread(seat.row.id);
                          }}
                        >
                          {personInitials(member.name)}
                        </b>
                      );
                    })}
                  </span>
                ) : null}
                <em title="New workstream" onClick={(event) => { event.stopPropagation(); createNamedThread(p.path); }}><Icon name="plus" size={13} /></em>
              </div>
              {isCollapsed ? null : threads.map(threadRow)}
              {s.showArchived
                ? s.threads.filter((t) => t.repo === p.path && t.archived).map((t) => {
                  // Paper 20.4, redrawn: click reads the archived thread
                  // (banner, no composer) — it never resurrects anything.
                  // Restore is its own control, swapping in for the age on
                  // hover. Right-click keeps Unarchive, Rename, Delete.
                  const days = Math.max(1, Math.floor((Date.now() - (Date.parse(t.archivedAt || '') || Date.now())) / 86_400_000));
                  return (
                    <button
                      key={t.id}
                      className="br archived-row"
                      title="Read archived workstream"
                      onClick={() => void openThread(t.id)}
                      onContextMenu={(event) => openArchivedMenu(event, { kind: 'thread', id: t.id, name: t.title })}
                    >
                      <span className="thread-arrow">›</span>
                      <span className="thread-name">{t.title}</span>
                      <time>{days}d</time>
                      <em
                        role="button"
                        aria-label={`Restore ${t.title}`}
                        title="Restore"
                        onClick={(event) => { event.stopPropagation(); void unarchiveThread(t.id); }}
                      >
                        <Icon name="restore" size={12} />
                      </em>
                    </button>
                  );
                })
                : null}
            </div>
          );
  };

  return (
    <div className="rail">
      <div className="nav">
        <button type="button" className="rail-global-search" aria-label="Search Supreme" aria-keyshortcuts="Meta+K Control+K" onClick={() => { state.workspaceSearchOpen = true; set(); }}><Icon name="search" size={14} />Search<kbd>⌘ K</kbd></button>
        <NavItem id="home" label="Home" />
        {/* Connected tabs, board 8: Map takes this slot (Alex, 2026-09-08).
            The Plays page stays reachable by its view; where it goes is
            still his call. */}
        <NavItem id="maps" label="Map" iconName="connected" also={['map']} />
        {/* Section 30, board 30.1: everything that came back while you were
            away, with how many; at zero the number is not drawn. */}
        <NavItem id="landed" label="Landed" iconName="download" count={landedRows().length} roll />
        <NavItem id="slack" label="Slack" iconName="message" count={s.slackInboxCounts?.active ?? slackAttentionCount(s.threads)} />
        {/* Section 29, board 29.2: scheduled tasks, with how many there are.
            Nothing else in the rail says a tab is scheduled; a run that came
            back unread carries section 28's dot like any other answer. */}
        <NavItem id="scheduled" label="Scheduled" iconName="clock" count={s.schedules.length} />
        <NavItem id="duels" label="Duels" iconName="swords" count={s.duelHistory?.count || s.stats?.duels} />
        <NavItem id="performance" label="Performance" iconName="chart" />
        <NavItem id="remote" label="Remote" iconName="smartphone" count={s.remote.activeCount} />
      </div>
      {orchCards.length ? (
        // Section 28, boards 28.2 and 28.6: one card per orchestrator, under
        // the nav and above everything the tree holds. A card is not a tree
        // row: nothing nests under it and it never folds, and with no
        // orchestrator there is no zone. Its roster stays in the Network
        // panel beside its thread.
        <div className="orch-zone" data-orch-zone>
          {orchCards.map((card) => (
            <button
              type="button"
              key={`${card.threadId}:${card.tabId}`}
              className="orch-card"
              data-orch-card={card.tabId}
              aria-current={s.view === 'tab' && s.panes.some((pane) => pane.threadId === card.threadId && pane.tabId === card.tabId) ? 'page' : undefined}
              onClick={() => void openThreadTab(card.threadId, card.tabId)}
              onContextMenu={(event) => openArchivedMenu(event, { kind: 'live-thread', id: card.threadId, name: s.threads.find((t) => t.id === card.threadId)?.title || card.name })}
            >
              <OrchMark size={13} />
              <span className="orch-card-name">{card.name}</span>
              {card.back
                ? <small className="orch-card-count back" data-orch-back={card.back}>{card.back} back</small>
                : card.out
                  ? <small className="orch-card-count" data-orch-out={card.out}>{card.out} out</small>
                  : null}
            </button>
          ))}
        </div>
      ) : null}
      {starred.length ? (
        <>
          <div className="rhd rhd-starred" data-rail-starred>Starred<i /></div>
          <div className="rl rl-starred" data-rail-starred-list>{starred.map(threadRow)}</div>
        </>
      ) : null}
      <div className="rhd" data-rail-private>
        {sharedWithMe.length ? 'Private' : 'Projects'}<i />
        <button className="railadd" title="New project" aria-label="New project" onClick={beginProjectCreation}><Icon name="plus" size={14} /></button>
      </div>
      <div className="rl">
        {s.projectCreateOpen ? (
          <form className="project-create" onSubmit={submitProject}>
            <span className="prjic"><Icon name="folder" size={13} /></span>
            <input
              ref={projectInput}
              data-new-project-name
              aria-label="Project name"
              placeholder="Project name"
              value={projectName}
              disabled={projectBusy}
              onChange={(event) => { setProjectName(event.target.value); event.target.setCustomValidity(''); }}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelNewProject(); } }}
            />
            <button type="submit" aria-label="Create project" disabled={projectBusy}><Icon name="check" size={12} /></button>
            <button type="button" aria-label="Cancel new project" disabled={projectBusy} onClick={cancelNewProject}><Icon name="x" size={12} /></button>
          </form>
        ) : null}
        {activeProjects.length === 0 && !archProjects.length ? (
          <div className="sub" style={{ padding: '12px 14px' }}>No projects yet. Click + above to make one.</div>
        ) : null}
        {privateProjects.map(projectRow)}
        {sharedWithMe.length ? (
          <div className="rhd rhd-shared" data-rail-shared>Shared<i /></div>
        ) : null}
        {sharedWithMe.map(projectRow)}
        {archProjects.map((p) => (
          <button
            type="button"
            key={p.path}
            className="prj archived-row"
            title="Restore archived project"
            onClick={() => archiveProject(p.path, false)}
            onContextMenu={(event) => openArchivedMenu(event, { kind: 'project', id: p.path, name: p.name })}
          >
            <span className="project-caret">›</span><span>{p.name}</span>
            <em><Icon name="restore" size={12} /></em>
          </button>
        ))}
      </div>
      <footer className="rail-footer">
        <nav className="rail-footer-nav" aria-label="Workspace tools">
          <FooterNavItem
            label="Context"
            iconName="fileText"
            selected={s.view === 'context'}
            onClick={() => navigate('context')}
          />
          <FooterNavItem
            label="Models"
            iconName="sparkles"
            selected={s.view === 'models'}
            onClick={() => navigate('models')}
          />
          <FooterNavItem
            label="Connectors"
            iconName="wrench"
            selected={s.view === 'connectors'}
            count={s.connectorsOverview?.connectedCount ?? new Set(s.connectors.filter((connector) => connector.connected).map((connector) => connector.name.trim().toLowerCase())).size}
            onClick={() => navigate('connectors')}
          />
        </nav>
        {archTotal ? (
          <div className="rail-footer-secondary">
            <FooterNavItem
              label={s.showArchived ? 'Hide archived' : 'Archived'}
              iconName="archive"
              count={archTotal}
              onClick={() => { state.showArchived = !state.showArchived; set(); }}
            />
          </div>
        ) : null}
        <div
          className="rail-profile"
          title="Double-click to set your name"
          onDoubleClick={() => { const n = window.prompt('Your name', s.userName || ''); if (n != null) setUserName(n); }}
        >
          <span className="av" aria-hidden>{initials(s.userName || 'You')}</span>
          <span className="rail-profile-copy"><b>{s.userName || 'You'}</b><small>{s.user?.email || 'Supreme account'}</small></span>
          {s.authConfigured ? <button className="account-signout" type="button" onClick={() => void signOutAccount()}>Sign out</button> : null}
          {s.authConfigured ? <button className="account-signout account-reset" type="button" title="Erase local threads on this Mac and start onboarding over" onClick={() => { if (window.confirm('Erase all local threads on this Mac and start onboarding over?\n\nThis Mac only — your cloud copy and other devices are untouched. This cannot be undone.')) void resetThisMac(); }}>Reset this Mac</button> : null}
        </div>
      </footer>
      {archivedMenu ? (
        <div
          className="archive-context-menu"
          role="menu"
          aria-label={`${archivedMenu.kind === 'live-project' ? 'Project' : archivedMenu.kind === 'live-thread' ? 'Workstream' : 'Archived'} actions for ${archivedMenu.name}`}
          style={{ left: archivedMenu.left, top: archivedMenu.top }}
        >
          {archivedMenu.kind === 'live-thread' ? (
            <>
              <button type="button" role="menuitem" onClick={() => { const target = archivedMenu; setArchivedMenu(null); state.renaming = { kind: 'thread', id: target.id }; set(); }}><Icon name="pencil" size={13} />Rename workstream</button>
              {(() => {
                // Board 12, opt-in maps: a workstream with no map gets one
                // here and it opens; one with a map can have it taken off.
                const off = !!s.threads.find((t) => t.id === archivedMenu.id)?.mapOff;
                return (
                  <button type="button" role="menuitem" data-menu-map onClick={() => { const target = archivedMenu; setArchivedMenu(null); void (async () => { if (await setMapOn(target.id, off) && off) await openMap(target.id); })(); }}><Icon name="connected" size={13} />{off ? 'Add map' : 'Remove map'}</button>
                );
              })()}
              <button type="button" role="menuitem" onClick={() => { const target = archivedMenu; setArchivedMenu(null); void archiveThread(target.id); }}><Icon name="archive" size={13} />Archive workstream</button>
              <button type="button" role="menuitem" className="danger" onClick={() => { const target = archivedMenu; setArchivedMenu(null); void deleteThread(target.id); }}><Icon name="x" size={13} />Delete workstream</button>
            </>
          ) : archivedMenu.kind === 'live-project' ? (
            <>
              <button type="button" role="menuitem" data-menu-share onClick={() => { const target = archivedMenu; setArchivedMenu(null); openShareDialog(target.id); }}><Icon name="user" size={13} />Share project</button>
              <button type="button" role="menuitem" onClick={() => { const target = archivedMenu; setArchivedMenu(null); state.renaming = { kind: 'project', id: target.id }; set(); }}><Icon name="pencil" size={13} />Rename project</button>
              <button type="button" role="menuitem" onClick={() => { const target = archivedMenu; setArchivedMenu(null); void archiveProject(target.id, true); }}><Icon name="archive" size={13} />Archive project</button>
              <button type="button" role="menuitem" className="danger" onClick={() => { const target = archivedMenu; setArchivedMenu(null); void deleteProject(target.id); }}><Icon name="x" size={13} />Delete project</button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={unarchiveMenuTarget}><Icon name="restore" size={13} />Unarchive</button>
              <button type="button" role="menuitem" className="danger" onClick={deleteMenuTarget}><Icon name="x" size={13} />Delete permanently</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
