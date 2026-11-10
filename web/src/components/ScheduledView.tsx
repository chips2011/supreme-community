import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useApp, toast } from '../store';
import { TopBar } from './bits';
import { Icon } from '../icons';
import {
  createSchedule, deleteSchedule, loadSchedules, openScheduled, openScheduledFire,
  disallowForSchedule, openThreadAt, runScheduleNow, updateSchedule, type ScheduleInput,
} from '../actions';
import { WEEKDAYS, appMark, historyLabel, historyNote, nextRunChip, repeatLabel, stateLine } from '../lib/scheduled';
import type { Schedule, ScheduleRepeat, TaskSummary } from '../types';


type Sort = 'next' | 'name' | 'last';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'next', label: 'Next run' },
  { id: 'last', label: 'Last run' },
  { id: 'name', label: 'Name' },
];

interface TabChoice { threadId: string; tabId: string; name: string; workstream: string }

function tabChoices(threads: TaskSummary[]): TabChoice[] {
  const rows: TabChoice[] = [];
  for (const thread of threads) {
    if (thread.archived) continue;
    for (const tab of thread.tabs || []) {
      if (tab.done || tab.type === 'duel') continue;
      rows.push({ threadId: thread.id, tabId: tab.id, name: tab.name || 'Untitled', workstream: thread.title || thread.repoName || 'Untitled' });
    }
  }
  return rows;
}

function useTabOf(schedule: Schedule | null): TabChoice | null {
  const s = useApp();
  return useMemo(() => {
    if (!schedule) return null;
    return tabChoices(s.threads).find((row) => row.threadId === schedule.threadId && row.tabId === schedule.tabId) || null;
  }, [s.threads, schedule]);
}

function TabGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg className="sched-tab-glyph" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.4 3v10" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function useDismiss(open: boolean, close: () => void, inside: string) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(inside)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close, inside]);
}

function StateChip({ schedule, now }: { schedule: Schedule; now: number }) {
  if (schedule.running) return <span className="sched-chip" data-sched-state="running"><span className="thread-run" aria-hidden><i /><b /></span>Running</span>;
  if (!schedule.enabled) return <span className="sched-chip" data-sched-state="paused"><Icon name="pause" size={10} />Paused</span>;
  if (schedule.repeat.kind === 'reply') return <span className="sched-chip" data-sched-state="on"><Icon name="mail" size={10} />On reply</span>;
  return <span className="sched-chip" data-sched-state="on"><Icon name="clock" size={10} />{nextRunChip(schedule.nextAt, now)}</span>;
}

type CardMenu = { id: string; left: number; top: number };

function Card({ schedule, now, onMenu }: { schedule: Schedule; now: number; onMenu: (event: ReactMouseEvent, schedule: Schedule) => void }) {
  const tab = useTabOf(schedule);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`sched-card${schedule.enabled || schedule.running ? '' : ' paused'}`}
      data-sched-card={schedule.id}
      onClick={() => openScheduled(schedule.id)}
      onKeyDown={(event) => { if (event.key === 'Enter') openScheduled(schedule.id); }}
      onContextMenu={(event) => onMenu(event, schedule)}
    >
      <div className="sched-card-head">
        <b>{schedule.name}</b>
        {/* Alex, 2026-09-21: on and off sit on the card, the task page's own
            switch, so a task is paused without opening it or a menu. */}
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={schedule.enabled ? `Pause ${schedule.name}` : `Turn ${schedule.name} on`}
          title={schedule.enabled ? 'On' : 'Off'}
          className={`sched-toggle${schedule.enabled ? ' on' : ''}`}
          data-sched-card-toggle
          onClick={(event) => { event.stopPropagation(); void updateSchedule(schedule.id, { enabled: !schedule.enabled }).then((refused) => { if (refused) toast(refused); }); }}
          onKeyDown={(event) => event.stopPropagation()}
        ><span /></button>
        <button type="button" className="sched-card-more" aria-label={`Actions for ${schedule.name}`} data-sched-more onClick={(event) => onMenu(event, schedule)} onKeyDown={(event) => event.stopPropagation()}>
          <Icon name="moreVertical" size={15} />
        </button>
      </div>
      <p>{schedule.instructions}</p>
      <i />
      <div className="sched-card-foot">
        <StateChip schedule={schedule} now={now} />
        <span className="sched-card-tab" data-sched-card-tab><TabGlyph />{tab ? tab.name : 'Its tab is gone'}</span>
      </div>
    </div>
  );
}

function RepeatPicker({ value, onChange }: { value: ScheduleRepeat; onChange: (next: ScheduleRepeat) => void }) {
  const [open, setOpen] = useState(false);
  useDismiss(open, () => setOpen(false), '.sched-repeat');
  const time = value.kind === 'hourly' || value.kind === 'reply' ? '09:00' : value.kind === 'once' ? value.at.slice(11) : value.time;
  const weekday = value.kind === 'weekly' ? value.weekday : 1;
  const tomorrow = () => {
    const date = new Date(Date.now() + 86_400_000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const date = value.kind === 'once' ? value.at.slice(0, 10) : tomorrow();
  const pick = (kind: ScheduleRepeat['kind']) => {
    if (kind === 'hourly') onChange({ kind, minute: 0 });
    else if (kind === 'reply') onChange({ kind });
    else if (kind === 'weekly') onChange({ kind, weekday, time });
    else if (kind === 'once') onChange({ kind, at: `${date}T${time}` });
    else onChange({ kind, time });
  };
  const kinds: { id: ScheduleRepeat['kind']; label: string }[] = [
    { id: 'hourly', label: 'Hourly' },
    { id: 'daily', label: 'Daily' },
    { id: 'weekdays', label: 'Weekdays' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'once', label: 'Once' },
    { id: 'reply', label: 'On reply' },
  ];
  return (
    <div className="sched-repeat">
      <button type="button" className="sched-field sched-pick" aria-expanded={open} data-sched-repeat onClick={() => setOpen(!open)}>
        <Icon name={value.kind === 'reply' ? 'mail' : 'clock'} size={13} /><span>{repeatLabel(value)}</span><Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="sched-menu" role="listbox" data-sched-repeat-menu>
          {kinds.map((kind) => (
            <button type="button" role="option" key={kind.id} aria-selected={value.kind === kind.id} className={value.kind === kind.id ? 'sel' : ''} data-sched-repeat-kind={kind.id} onClick={() => pick(kind.id)}>
              {kind.label}{value.kind === kind.id ? <Icon name="check" size={12} /> : null}
            </button>
          ))}
          {value.kind !== 'hourly' && value.kind !== 'reply' ? (
            <div className="sched-menu-when">
              {value.kind === 'weekly' ? (
                <select aria-label="Day" value={weekday} onChange={(event) => onChange({ kind: 'weekly', weekday: Number(event.target.value), time })}>
                  {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                </select>
              ) : null}
              {value.kind === 'once' ? (
                <input type="date" aria-label="Date" value={date} onChange={(event) => { if (event.target.value) onChange({ kind: 'once', at: `${event.target.value}T${time}` }); }} />
              ) : null}
              <input
                type="time"
                aria-label="Time"
                data-sched-time
                value={time}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!next) return;
                  if (value.kind === 'once') onChange({ kind: 'once', at: `${date}T${next}` });
                  else if (value.kind === 'weekly') onChange({ kind: 'weekly', weekday, time: next });
                  else onChange({ kind: value.kind as 'daily' | 'weekdays', time: next });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TabPicker({ value, choices, onChange }: { value: TabChoice | null; choices: TabChoice[]; onChange: (next: TabChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  useDismiss(open, () => setOpen(false), '.sched-tabpick');
  const q = query.trim().toLowerCase();
  const list = choices.filter((row) => !q || row.name.toLowerCase().includes(q) || row.workstream.toLowerCase().includes(q)).slice(0, 40);
  return (
    <div className="sched-tabpick">
      <button type="button" className="sched-field sched-pick" aria-expanded={open} data-sched-tab onClick={() => { setOpen(!open); setQuery(''); }}>
        <TabGlyph size={14} />
        {value ? <><span>{value.name}</span><small>{value.workstream}</small></> : <span className="none">Pick a tab</span>}
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="sched-menu wide" role="listbox" data-sched-tab-menu>
          <div className="sched-menu-search">
            <Icon name="search" size={13} />
            <input autoFocus aria-label="Search your tabs" placeholder="Search your tabs" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="sched-menu-rows">
            {list.length ? list.map((row) => (
              <button type="button" role="option" key={`${row.threadId}:${row.tabId}`} aria-selected={value?.tabId === row.tabId} className={value?.tabId === row.tabId ? 'sel' : ''} data-sched-tab-row={row.tabId} onClick={() => { onChange(row); setOpen(false); }}>
                <TabGlyph /><span>{row.name}</span><small>{row.workstream}</small>
              </button>
            )) : <div className="sched-menu-none">No tab by that name</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskSheet({ editing, copyOf = null, onClose }: { editing: Schedule | null; copyOf?: Schedule | null; onClose: () => void }) {
  const s = useApp();
  const choices = useMemo(() => tabChoices(s.threads), [s.threads]);
  // A new task starts on the tab that is on screen, since that is usually
  // the one being talked about.
  const focused = s.panes[s.activePane] || s.panes[0];
  const from = editing || copyOf;
  const start = from
    ? choices.find((row) => row.threadId === from.threadId && row.tabId === from.tabId) || null
    : choices.find((row) => row.threadId === focused?.threadId && row.tabId === (focused?.tabId || s.cache[focused?.threadId || '']?.activeTab)) || null;
  const [name, setName] = useState(editing?.name || (copyOf ? `${copyOf.name} copy` : ''));
  const [instructions, setInstructions] = useState(from?.instructions || '');
  const [tab, setTab] = useState<TabChoice | null>(start);
  const [repeat, setRepeat] = useState<ScheduleRepeat>(from?.repeat || { kind: 'daily', time: '09:00' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  // A copy opens with its name picked, since the name is the first thing to change.
  useEffect(() => { nameInput.current?.focus(); if (copyOf) nameInput.current?.select(); }, [copyOf]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ready = !!name.trim() && !!instructions.trim() && !!tab && !saving;
  const save = async () => {
    if (!ready || !tab) return;
    setSaving(true);
    const input: ScheduleInput = { name: name.trim(), instructions: instructions.trim(), threadId: tab.threadId, tabId: tab.tabId, repeat };
    const refused = editing ? await updateSchedule(editing.id, input) : await createSchedule(input);
    setSaving(false);
    if (refused) { setError(refused); return; }
    onClose();
  };
  return (
    <div className="sched-dim" data-sched-sheet onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="sched-sheet" role="dialog" aria-modal="true" aria-label={editing ? 'Edit task' : 'New task'} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h2>{editing ? 'Edit task' : 'New task'}</h2>
        <label className="sched-label">
          <span>Name</span>
          <input ref={nameInput} className="sched-field" data-sched-name value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="sched-label">
          <span>Instructions</span>
          <textarea
            className="sched-field area"
            data-sched-instructions
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }}
          />
        </label>
        <div className="sched-pair">
          <div className="sched-label"><span>Tab</span><TabPicker value={tab} choices={choices} onChange={setTab} /></div>
          <div className="sched-label"><span>Repeats</span><RepeatPicker value={repeat} onChange={setRepeat} /></div>
        </div>
        <div className="sched-sheet-foot">
          <p className={error ? 'err' : ''} data-sched-sheet-line>{error || 'The tab runs it, so it starts from what is already in the thread.'}</p>
          <button type="button" className="sched-cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="sched-black" data-sched-save disabled={!ready}>{editing ? 'Save' : 'Create task'}</button>
        </div>
      </form>
    </div>
  );
}

function TaskPage({ schedule, now, onEdit }: { schedule: Schedule; now: number; onEdit: () => void }) {
  const tab = useTabOf(schedule);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [whole, setWhole] = useState(false);
  useDismiss(confirmDelete, () => setConfirmDelete(false), '.sched-delete');
  const paragraphs = schedule.instructions.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const long = schedule.instructions.length > 420 || paragraphs.length > 4;
  return (
    <div className="sched-page" data-sched-task={schedule.id}>
      <header className="sched-task-head">
        <h1>{schedule.name}</h1>
        <i />
        <button type="button" className="sched-icon" aria-label="Edit task" title="Edit" data-sched-edit onClick={onEdit}><Icon name="pencil" size={17} /></button>
        <div className="sched-delete">
          <button type="button" className="sched-icon" aria-label="Delete task" title="Delete" aria-expanded={confirmDelete} data-sched-delete onClick={() => setConfirmDelete(!confirmDelete)}><Icon name="trash" size={17} /></button>
          {confirmDelete ? (
            <div className="sched-menu right" role="menu">
              <button type="button" role="menuitem" className="danger" data-sched-delete-yes onClick={() => void deleteSchedule(schedule.id)}><Icon name="trash" size={13} />Delete task</button>
            </div>
          ) : null}
        </div>
        {schedule.repeat.kind === 'reply' ? null : (
          <button type="button" className="sched-black" data-sched-run disabled={!!schedule.running} onClick={() => void runScheduleNow(schedule.id)}>
            <Icon name="play" size={11} />{schedule.running ? 'Running' : 'Run now'}
          </button>
        )}
      </header>
      <div className="sched-toggle-row">
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={schedule.enabled ? 'Pause this task' : 'Turn this task on'}
          className={`sched-toggle${schedule.enabled ? ' on' : ''}`}
          data-sched-toggle
          onClick={() => void updateSchedule(schedule.id, { enabled: !schedule.enabled }).then((refused) => { if (refused) toast(refused); })}
        ><span /></button>
        <span data-sched-state-line>{stateLine(schedule, now)}</span>
      </div>
      <div className="sched-task-body">
        <section className="sched-history" aria-label="History">
          <h3>History</h3>
          {schedule.history.length ? schedule.history.map((row) => {
            const note = historyNote(row);
            return (
              <button
                type="button"
                key={row.id}
                className="sched-history-row"
                data-sched-history={row.id}
                disabled={!!row.error}
                title={row.error || undefined}
                onClick={() => void openScheduledFire(schedule, row.id)}
              >
                <span>{historyLabel(row, now)}</span>
                {note ? <small>{note}</small> : null}
              </button>
            );
          }) : <div className="sched-history-none" data-sched-history-none>No runs yet</div>}
        </section>
        <div className="sched-facts">
          <section>
            <h3>Instructions</h3>
            <div className={`sched-instructions${long && !whole ? ' clipped' : ''}`} data-sched-instructions-shown onClick={long ? () => setWhole(!whole) : undefined}>
              {paragraphs.map((part, index) => <p key={index}>{part}</p>)}
            </div>
          </section>
          <section>
            <h3>Tab</h3>
            {tab ? (
              <button type="button" className="sched-tab-row" data-sched-open-tab onClick={() => void openThreadAt(schedule.threadId, schedule.tabId)}>
                <span className="sched-tab-box"><TabGlyph size={14} /></span><b>{tab.name}</b><small>{tab.workstream}</small>
              </button>
            ) : <div className="sched-tab-row gone"><span className="sched-tab-box"><TabGlyph size={14} /></span><b>Its tab is gone</b></div>}
          </section>
          <section>
            <h3>Repeats</h3>
            <div className="sched-repeats" data-sched-repeats>{repeatLabel(schedule.repeat)}</div>
          </section>
          {schedule.allowed.length ? (
            <section>
              <h3>Always allowed<Icon name="circleCheck" size={13} /></h3>
              <div className="sched-allowed">
                {schedule.allowed.map((row) => (
                  <div className="sched-allowed-row" key={`${row.app}:${row.action}`} data-sched-allowed={`${row.app} · ${row.action}`}>
                    <span className="sched-app-mark" aria-hidden>{appMark(row.app)}</span>
                    <b>{row.app}</b><span>{row.action}</span>
                    <button type="button" aria-label={`Stop allowing ${row.app}, ${row.action}`} title="Remove" onClick={() => void disallowForSchedule(schedule.id, row)}><Icon name="trash" size={15} /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ScheduledView() {
  const s = useApp();
  const [sort, setSort] = useState<Sort>('next');
  const [sortOpen, setSortOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<{ editing: Schedule | null; copyOf?: Schedule | null } | null>(null);
  const [menu, setMenu] = useState<CardMenu | null>(null);
  const now = Date.now();
  useEffect(() => {
    void loadSchedules();
    // The page follows the clock: a fire, a landing and Running all show
    // without a reload.
    const timer = window.setInterval(() => { if (!document.hidden) void loadSchedules(); }, 3_000);
    return () => window.clearInterval(timer);
  }, []);
  useDismiss(sortOpen, () => setSortOpen(false), '.sched-sort');
  useDismiss(!!menu, () => setMenu(null), '.archive-context-menu');

  const open = s.scheduledOpen ? s.schedules.find((row) => row.id === s.scheduledOpen) || null : null;
  const q = query.trim().toLowerCase();
  const lastRun = (row: Schedule) => Date.parse(row.history[0]?.ranAt || '') || 0;
  const nextRun = (row: Schedule) => (row.running ? 0 : row.enabled ? Date.parse(row.nextAt || '') || Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER);
  const rows = s.schedules
    .filter((row) => !q || row.name.toLowerCase().includes(q) || row.instructions.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'last' ? lastRun(b) - lastRun(a) : nextRun(a) - nextRun(b)) || a.name.localeCompare(b.name));
  const openMenu = (event: ReactMouseEvent, schedule: Schedule) => {
    event.preventDefault();
    event.stopPropagation();
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const top = Math.max(8, Math.min(event.clientY, window.innerHeight - 196));
    setMenu({ id: schedule.id, left, top });
  };
  const menuFor = menu ? s.schedules.find((row) => row.id === menu.id) || null : null;

  return (
    <>
      <TopBar>
        {open ? (
          <span className="crumb sched-crumb">
            <Icon name="clock" size={15} />
            <button type="button" data-sched-back onClick={() => openScheduled(null)}>Scheduled</button>
            <em>/</em>
            <b>{open.name}</b>
          </span>
        ) : <span className="crumb sched-crumb"><Icon name="clock" size={15} /><b>Scheduled</b></span>}
        <i />
      </TopBar>
      {open ? <TaskPage schedule={open} now={now} onEdit={() => setSheet({ editing: open })} /> : (
        <div className="sched-page" data-sched-index>
          <header className="sched-toolbar">
            <h1>Scheduled tasks</h1>
            <i />
            {searching ? (
              <input
                autoFocus
                className="sched-search"
                aria-label="Search tasks"
                placeholder="Search tasks"
                data-sched-search-input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onBlur={() => { if (!query) setSearching(false); }}
                onKeyDown={(event) => { if (event.key === 'Escape') { setQuery(''); setSearching(false); } }}
              />
            ) : (
              <button type="button" className="sched-icon" aria-label="Search tasks" data-sched-search onClick={() => setSearching(true)}><Icon name="search" size={17} /></button>
            )}
            <div className="sched-sort">
              <button type="button" className="sched-sort-pill" aria-expanded={sortOpen} data-sched-sort onClick={() => setSortOpen(!sortOpen)}>
                <span>Sort by</span><b>{SORTS.find((row) => row.id === sort)?.label}</b><Icon name="chevronDown" size={11} />
              </button>
              {sortOpen ? (
                <div className="sched-menu right" role="listbox">
                  {SORTS.map((row) => (
                    <button type="button" role="option" key={row.id} aria-selected={sort === row.id} className={sort === row.id ? 'sel' : ''} data-sched-sort-by={row.id} onClick={() => { setSort(row.id); setSortOpen(false); }}>
                      {row.label}{sort === row.id ? <Icon name="check" size={12} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button type="button" className="sched-black" data-sched-new onClick={() => setSheet({ editing: null })}>New task</button>
          </header>
          {rows.length ? (
            <div className="sched-grid">
              {rows.map((row) => <Card key={row.id} schedule={row} now={now} onMenu={openMenu} />)}
            </div>
          ) : (
            <div className="sched-empty" data-sched-empty>{s.schedules.length ? 'No task by that name' : 'No tasks yet. New task picks a tab and a time, and that tab runs it.'}</div>
          )}
        </div>
      )}
      {menu && menuFor ? (
        <div className="archive-context-menu" role="menu" aria-label={`Actions for ${menuFor.name}`} style={{ left: menu.left, top: menu.top }} onClick={(event) => event.stopPropagation()}>
          {menuFor.repeat.kind === 'reply' ? null : <button type="button" role="menuitem" disabled={!!menuFor.running} data-sched-menu-run onClick={() => { setMenu(null); void runScheduleNow(menuFor.id); }}><Icon name="play" size={12} />Run now</button>}
          <button type="button" role="menuitem" data-sched-menu-toggle onClick={() => { setMenu(null); void updateSchedule(menuFor.id, { enabled: !menuFor.enabled }).then((refused) => { if (refused) toast(refused); }); }}><Icon name={menuFor.enabled ? 'pause' : 'clock'} size={13} />{menuFor.enabled ? 'Pause' : 'Turn on'}</button>
          <button type="button" role="menuitem" data-sched-menu-edit onClick={() => { setMenu(null); setSheet({ editing: menuFor }); }}><Icon name="pencil" size={13} />Edit</button>
          <button type="button" role="menuitem" data-sched-menu-duplicate onClick={() => { setMenu(null); setSheet({ editing: null, copyOf: menuFor }); }}><Icon name="copy" size={13} />Duplicate</button>
          <button type="button" role="menuitem" className="danger" data-sched-menu-delete onClick={() => { setMenu(null); void deleteSchedule(menuFor.id); }}><Icon name="trash" size={13} />Delete</button>
        </div>
      ) : null}
      {sheet ? <TaskSheet editing={sheet.editing} copyOf={sheet.copyOf || null} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
