import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useApp, state, set } from '../store';
import { Icon } from '../icons';
import { ModelMark } from './bits';
import {
  closePlayPanel, deletePlayById, editPlayDraft, findPlay, playPanel, refreshConnectors, revisePlayDraft, savePlayDraft,
  setPlayEditing, stopPlayRun,
} from '../actions';
import type { PlayFindJob, PlayRun } from '../types';

// Paper 17: the one editor for plays, and the one new surface a run has. It
// sits to the right of a pane (Find a Play reading the thread, the play it
// found, a run driving the chat) and to the right of the Plays list. Same
// colour as the rail, so it is quiet by design.

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tokenHtml(name: string): string {
  const safe = escapeHtml(name.trim().slice(0, 40));
  return `<span class="play-token" contenteditable="false" data-name="${safe}">${safe}</span>`;
}

// The rules block. One editable region, numbered by default; the toolbar can
// turn lines into paragraphs, bullets or a header. A connector mention is one
// token: @ opens the picker of connectors that are actually on, one backspace
// removes the whole thing.
function RulesEditor({ html, editing, onChange }: { html: string; editing: boolean; onChange: (html: string) => void }) {
  const s = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<{ query: string; selected: number } | null>(null);
  // One entry per connector: both providers can list the same one (Gmail on
  // Claude and on ChatGPT), and the token names the connector, not the model.
  const connectors = [...new Map(
    s.connectors.filter((connector) => connector.connected !== false).map((connector) => [connector.name.trim().toLowerCase(), connector]),
  ).values()];
  const items = picker ? connectors.filter((connector) => !picker.query || connector.name.toLowerCase().includes(picker.query.toLowerCase())).slice(0, 8) : [];

  useEffect(() => {
    if (editing && !s.connectorsLoaded) void refreshConnectors();
  }, [editing]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = html || (editing ? '<ol><li><br></li></ol>' : '');
    if (el.innerHTML !== next && document.activeElement !== el) el.innerHTML = next;
  }, [html, editing]);

  const emit = () => { const el = ref.current; if (el) onChange(el.innerHTML); };
  const command = (name: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(name, false, value);
    emit();
  };
  // The token goes in as a DOM node at the caret (Chrome's insertHTML strips
  // the attributes that make it one thing), followed by a space to type on.
  const insertToken = (name: string) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const wrapper = document.createElement('span');
    wrapper.innerHTML = `${tokenHtml(name)}&nbsp;`;
    const token = wrapper.firstElementChild as HTMLElement;
    const space = wrapper.lastChild as Text;
    const selection = window.getSelection();
    let range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      const last = el.querySelector('li:last-child') || el;
      range.selectNodeContents(last);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(token);
    range.setStartAfter(space);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setPicker(null);
    emit();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (picker) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        if (items.length) setPicker((current) => (current ? { ...current, selected: (current.selected + delta + items.length) % items.length } : current));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (items.length) insertToken(items[Math.min(picker.selected, items.length - 1)].name);
        else setPicker(null);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setPicker(null); return; }
      if (event.key === 'Backspace') {
        event.preventDefault();
        setPicker((current) => (current && current.query ? { query: current.query.slice(0, -1), selected: 0 } : null));
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const key = event.key;
        setPicker((current) => (current ? { query: `${current.query}${key}`, selected: 0 } : current));
        return;
      }
      return;
    }
    if (event.key === '@' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      setPicker({ query: '', selected: 0 });
    }
  };

  return (
    <div className="rules-block">
      {editing ? (
        <div className="rules-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" title="Header" onMouseDown={(event) => event.preventDefault()} onClick={() => command('formatBlock', 'h3')}>H</button>
          <button type="button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => command('bold')}><b>B</b></button>
          <button type="button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => command('italic')}><i>I</i></button>
          <button type="button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => command('underline')}><u>U</u></button>
          <button type="button" title="Bullets" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertUnorderedList')}><Icon name="list" size={12} /></button>
          <button type="button" title="Numbered" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertOrderedList')}><Icon name="listOrdered" size={12} /></button>
        </div>
      ) : null}
      <div
        ref={ref}
        className={`rules-editor${editing ? ' editing' : ''}`}
        contentEditable={editing}
        suppressContentEditableWarning
        role={editing ? 'textbox' : undefined}
        aria-label="Rules"
        aria-multiline={editing ? true : undefined}
        onInput={emit}
        onBlur={() => { emit(); }}
        onKeyDown={onKeyDown}
      />
      {picker ? (
        <div className="connector-pop" role="listbox" aria-label="Connectors you have on" data-query={picker.query} data-count={items.length}>
          <div className="hd">Connectors you have on{picker.query ? ` · ${picker.query}` : ''}</div>
          {items.length ? items.map((connector, index) => (
            <button key={connector.name} type="button" role="option" aria-selected={index === picker.selected} className={index === picker.selected ? 'sel' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => insertToken(connector.name)}>
              <i />{connector.name}
            </button>
          )) : <div className="mention-empty">{s.connectorsLoaded ? 'No connector matches.' : 'Checking connectors…'}</div>}
        </div>
      ) : null}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <div className="play-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>;
}

function FindBody({ job, error, onRetry }: { job: PlayFindJob | null; error: string | null; onRetry: () => void }) {
  const steps = job?.steps || [];
  const done = steps.filter((step) => step.state === 'done').length;
  return (
    <div className="play-panel-body">
      <h2>{error ? 'Could not read this thread' : 'Reading this thread'}</h2>
      <p className="sub">{error ? error : 'Keep working, this runs on its own and will be here when it lands.'}</p>
      {error ? <button type="button" className="play-stop" onClick={onRetry}>Try again</button> : <Progress done={done} total={Math.max(steps.length, 4)} />}
      <div className="play-steps">
        {steps.map((step) => (
          <div key={step.label} className={`play-step ${step.state}`}>
            <u /><span>{step.label}</span><em>{step.state}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunBody({ run }: { run: PlayRun | null }) {
  const steps = run?.steps || [];
  const done = steps.filter((step) => step.state === 'done' || step.state === 'skipped').length;
  const status = run?.status || 'running';
  const title = status === 'done' ? 'Play finished'
    : status === 'stopped' ? 'Stopped'
      : status === 'failed' ? 'The play stopped'
        : status === 'waiting' ? 'Waiting on you'
          : status === 'stopping' ? 'Stopping' : 'Running your play';
  const sub = status === 'done' ? 'Every rule went in. The thread on the left has the whole run.'
    : status === 'stopped' ? 'The thread keeps what it did so far.'
      : status === 'failed' ? (run?.error || 'Something went wrong.')
        : status === 'waiting' ? 'The last turn asked you something. Answer in the thread and the next rule goes in.'
          : 'It is working the thread on the left, one rule at a time. Cut in whenever you want.';
  return (
    <div className="play-panel-body">
      <h2>{title}</h2>
      <p className="sub">{sub}</p>
      <Progress done={done} total={steps.length} />
      <div className="play-steps">
        {steps.map((step, index) => (
          // The outcome is the model's own report of what happened, prose not
          // measurement, so it sits inline in the body face; only the state
          // word takes the counted-value slot on the right.
          <div key={`${index}-${step.label}`} className={`play-step ${step.state}`}>
            <i>{index + 1}</i>
            <span>{step.label}{step.outcome && step.outcome !== 'done' ? <small className="play-outcome">{step.outcome}</small> : null}</span>
            <em>{step.state === 'now' ? 'now' : step.state === 'next' ? 'next' : step.state}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

// `panelKey` is the tab the panel belongs to (thread::tab), or 'page' on the
// Plays page; `paneIdx` is only needed to start a new read from a pane.
export function PlayPanel({ panelKey, paneIdx, modelId }: { panelKey: string; paneIdx?: number; modelId?: string | null }) {
  const s = useApp();
  const panel = s.playPanels[panelKey] || playPanel(panelKey);
  const [change, setChange] = useState('');
  const job = panel.jobId ? s.playFindJobs[panel.jobId] || null : null;
  const run = panel.runId ? s.playRuns[panel.runId] || null : null;
  const draft = panel.draft;
  const onPane = typeof paneIdx === 'number';
  const title = panel.mode === 'run' ? (run?.name || 'Play')
    : panel.mode === 'find' || !panel.playId ? 'Find a Play'
      : (draft?.name || 'Play');

  const submitChange = async (event: FormEvent) => {
    event.preventDefault();
    const text = change.trim();
    if (!text) return;
    setChange('');
    await revisePlayDraft(panelKey, text, modelId);
  };

  return (
    <aside className={`play-panel mode-${panel.mode}`} aria-label={title}>
      <div className="play-panel-head">
        <Icon name="zap" size={13} /><span>{title}</span>
        <button type="button" aria-label="Close" title="Close" onClick={() => closePlayPanel(panelKey)}><Icon name="x" size={13} /></button>
      </div>
      {panel.mode === 'find' ? (
        <FindBody job={job} error={panel.error} onRetry={() => { if (onPane) void findPlay(paneIdx as number); }} />
      ) : panel.mode === 'run' ? (
        <>
          <RunBody run={run} />
          <div className="play-panel-foot play-run-foot">
            <small>Nothing sends without you.</small>
            {run && !run.finishedAt
              ? <button type="button" className="play-stop" disabled={run.status === 'stopping'} onClick={() => void stopPlayRun(panelKey)}>{run.status === 'stopping' ? 'Stopping…' : 'Stop'}</button>
              : <button type="button" className="play-stop" onClick={() => closePlayPanel(panelKey)}>Close</button>}
          </div>
        </>
      ) : draft ? (
        <>
          <div className="play-panel-body" onDoubleClick={() => { if (!panel.editing) setPlayEditing(panelKey, true); }}>
            {panel.editing ? (
              <>
                <div className="play-field editing">
                  <label htmlFor={`play-name-${panelKey}`}>Name</label>
                  <input id={`play-name-${panelKey}`} value={draft.name} onChange={(event) => editPlayDraft(panelKey, { name: event.target.value })} placeholder="Name the play" />
                </div>
                <div className="play-field editing">
                  <label htmlFor={`play-when-${panelKey}`}>Use it when</label>
                  <input id={`play-when-${panelKey}`} className="plain" value={draft.useWhen} onChange={(event) => editPlayDraft(panelKey, { useWhen: event.target.value })} placeholder="I ask you to…" />
                </div>
              </>
            ) : (
              <>
                <div className="play-field"><label>Name</label><h3>{draft.name || 'Untitled play'}</h3></div>
                <div className="play-field"><label>Use it when</label><p>{draft.useWhen || 'Double-click to say when this applies'}</p></div>
              </>
            )}
            <div className="play-field">
              {panel.editing ? null : <label>Rules</label>}
              <RulesEditor html={draft.rules} editing={panel.editing} onChange={(html) => editPlayDraft(panelKey, { rules: html })} />
            </div>
            {panel.error ? <p className="play-error">{panel.error}</p> : null}
            {!panel.editing ? <p className="sub" style={{ marginTop: 16 }}>Double-click to edit a line, or say what to change below.</p> : null}
            {panel.playId && panelKey === 'page' ? <span className="play-link" role="button" tabIndex={0} onClick={() => void deletePlayById(panel.playId!)}>Delete this play</span> : null}
          </div>
          <div className="play-panel-foot">
            <form className="play-change" onSubmit={(event) => void submitChange(event)}>
              <ModelMark id={modelId || s.homeModel} />
              <input aria-label="Tell me what to change" placeholder={panel.busy ? 'Working on it…' : 'Tell me what to change'} value={change} disabled={panel.busy} onChange={(event) => setChange(event.target.value)} />
              <button type="submit" aria-label="Send the change" disabled={panel.busy || !change.trim()}><Icon name="arrowUp" size={12} /></button>
            </form>
            <button type="button" className="play-save" disabled={panel.busy || (!panel.dirty && !!panel.playId)} onClick={() => void savePlayDraft(panelKey)}>
              {panel.busy ? 'Saving…' : panel.playId ? 'Save changes' : 'Save play'}
            </button>
          </div>
        </>
      ) : (
        <div className="play-panel-body"><p className="sub">{panel.error || 'Nothing here yet.'}</p></div>
      )}
      {panel.mode === 'edit' && panel.editing ? <EditingEscape onDone={() => { setPlayEditing(panelKey, false); set(); }} /> : null}
    </aside>
  );
}

// Escape leaves edit mode without touching the draft.
function EditingEscape({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDone(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  return null;
}

export function hasPlayPanel(key: string): boolean {
  return !!state.playPanels[key]?.open;
}
