import { state, set, modelLabel, draftKey } from '../store';
import { RECOMMENDED_MODEL } from '../constants';
import { Icon } from '../icons';
import { EffortBars } from '../lib/effort';
import { laneStates } from '../lib/orchestrator';
import { PlayPicker } from './PlayPicker';
import { insertPlayPick, playPickerQuery, playsMatching, resolvePlayCommand } from '../actions';
import { ModelMark } from './bits';
import { openPop } from '../lib/ui';
import { MentionPicker } from './MentionPicker';
import { modelSwitchCause } from './ModelHandoff';
import { TerminalContextChips } from './TerminalContext';
import { ImageAttachments } from './ImageAttachments';
import { contextTargetDrop, contextTargetLeave, contextTargetOver } from '../lib/dnd';
import { addDroppedFiles, duelPhase, createDuel, triggerSend, clearPendingHandoff, newTab, noteTyping, pickMention, removePendingContextRef, removePendingImage, removePendingPing, removeTerminalContext, streamKey, type TabRunRef } from '../actions';
import { mentionAtCursor, mentionMatches } from '../lib/mention';
import { SessionNotice } from './Fold';
import { landedPlace } from '../lib/landed';
import { landedComplete, landedStep } from '../actions';
import type { Task, Tab } from '../types';

// Ported from vanilla composer(): textarea + model/effort/connectors/duel/send
// controls, with @mention detection + keyboard navigation.
export function Composer({ task, tab, idx, disabled = false, runRef = null }: { task: Task; tab: Tab; idx: number; disabled?: boolean; runRef?: TabRunRef | null }) {
  const draft = state.drafts[draftKey(idx)] || '';
  const isDuel = tab.type === 'duel';
  const phase = isDuel ? duelPhase(tab) : null;
  const modelText = isDuel && phase !== 'picked' ? 'Contenders · 2' : modelLabel(tab.model);
  const shownEffort = isDuel && phase !== 'picked' ? ((tab.duel || {}).effort || 'High') : state.effort;
  const effortLocked = isDuel && phase !== 'picked';
  const inputLocked = disabled && !runRef;
  const terminalContextKey = streamKey(task.id, tab.id);
  const terminalContexts = state.pendingTerminalContexts[terminalContextKey] || [];
  const handoffTarget = state.pendingHandoff[terminalContextKey] || null;
  const pings = state.pendingPings[terminalContextKey] || [];
  const contextRefs = state.pendingContextRefs[terminalContextKey] || [];
  const images = state.pendingImages[terminalContextKey] || [];
  const contextName = terminalContexts[0]?.sourceTab;
  const previousTurn = [...(tab.messages || [])].reverse().find((message) => message.role === 'assistant' && message.model);
  const previousModel = previousTurn?.fellBackFrom || previousTurn?.model;
  const nextModel = tab.model !== RECOMMENDED_MODEL.id ? tab.model : null;
  const pendingHandoff = previousModel && nextModel && previousModel !== nextModel
    ? { from: state.modelById[previousModel], to: state.modelById[nextModel] }
    : null;
  // Board 12.6: a model switch or a fold means a fresh provider session on
  // the next send; one strip says which, what carries over, and the cost,
  // until that turn lands. A tab with a fold never carries its transcript.
  const folded = !!tab.folds?.length;
  const coldAfterFold = folded && Object.keys(tab.sessions || {}).length === 0;
  const sessionCause = pendingHandoff ? modelSwitchCause(previousModel!, nextModel!) : null;

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    state.drafts[draftKey(idx)] = v;
    if (v.trim()) noteTyping(task, tab);
    const mention = mentionAtCursor(v, e.target.selectionStart);
    // Prose test: a spaced query that matches nothing is the user typing
    // their message past a hand-written @Name, not searching. Close instead
    // of hunting. Single-word misses keep the "nothing matches" hint.
    const prose = !!(mention && /\s\S/.test(mention.query)
      && mentionMatches(task, tab.id, mention.query).length === 0);
    if (mention && !prose) {
      const previous = state.contextMention[idx];
      if (previous && previous.start === mention.start && previous.query === mention.query) mention.selected = previous.selected || 0;
      state.contextMention[idx] = mention;
    } else if (state.contextMention[idx]) {
      delete state.contextMention[idx];
    }
    set();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // /plays picker (Paper 17.4): arrows choose, Enter or Tab inserts the
    // play's name; once a full name is in, Enter sends the run.
    const pickQuery = playPickerQuery(state.drafts[draftKey(idx)] || '');
    const picked = resolvePlayCommand(state.drafts[draftKey(idx)] || '');
    if (pickQuery !== null && !(picked && picked !== 'unknown')) {
      const plays = playsMatching(pickQuery);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (plays.length) {
          const current = state.playPick[idx]?.selected || 0;
          state.playPick[idx] = { selected: (current + (e.key === 'ArrowDown' ? 1 : -1) + plays.length) % plays.length };
          set();
        }
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        if (plays.length) {
          e.preventDefault();
          insertPlayPick(idx, plays[Math.min(state.playPick[idx]?.selected || 0, plays.length - 1)]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        state.drafts[draftKey(idx)] = '';
        delete state.playPick[idx];
        set();
        return;
      }
    }
    const mention = state.contextMention[idx];
    if (mention) {
      const items = mentionMatches(task, tab.id, mention.query).slice(0, 8);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          mention.selected = (Number(mention.selected || 0) + delta + items.length) % items.length;
          set();
        }
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
        if (items.length) {
          e.preventDefault();
          const item = items[Math.min(mention.selected || 0, items.length - 1)];
          pickMention(idx, item, task, tab.id);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        delete state.contextMention[idx];
        set();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      triggerSend(String(idx));
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;
    e.preventDefault();
    void addDroppedFiles(terminalContextKey, files, 'paste');
  };

  // A file drop from the OS carries dataTransfer.files; anything else is an
  // internal context-mention drag, which keeps its existing handlers.
  const onComposerDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      return;
    }
    contextTargetOver(e);
  };
  const onComposerDrop = (e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files') && e.dataTransfer.files?.length) {
      e.preventDefault();
      e.stopPropagation();
      void addDroppedFiles(terminalContextKey, Array.from(e.dataTransfer.files), 'drop');
      return;
    }
    contextTargetDrop(e, idx);
  };

  return (
    <div
      className={`comp ${disabled && !runRef ? 'disabled' : ''} ${runRef ? 'running' : ''}`}
      onDragOver={onComposerDragOver}
      onDragLeave={contextTargetLeave}
      onDrop={onComposerDrop}
    >
      {inputLocked ? null : <MentionPicker task={task} tabId={tab.id} idx={idx} />}
      {inputLocked ? null : <PlayPicker idx={idx} />}
      {(pendingHandoff || coldAfterFold) && !runRef ? <SessionNotice cause={sessionCause} folded={folded} /> : null}
      {handoffTarget || pings.length || contextRefs.length ? (
        // Paper 21.2b: picked tokens are chips, destination first, then the
        // ingredients. No helper caption — the chips explain themselves.
        <div className="pending-terminal-context">
          {handoffTarget ? (
            <span className="token-destination" data-handoff-chip={handoffTarget.name}>
              <Icon name="columns" size={11} />{handoffTarget.name}
              <button type="button" aria-label="Remove the destination" onClick={() => clearPendingHandoff(terminalContextKey)}>×</button>
            </span>
          ) : null}
          {contextRefs.map((name) => (
            <span key={`ref-${name}`} className="token-ingredient" data-context-chip={name}>
              <Icon name="fileText" size={11} />{name}
              <button type="button" aria-label={`Stop reading ${name}`} onClick={() => removePendingContextRef(terminalContextKey, name)}>×</button>
            </span>
          ))}
          {pings.map((ping) => (
            <span key={`ping-${ping.email}`} className="token-ingredient" data-ping-chip={ping.name}>
              <Icon name="user" size={11} />{ping.name}
              <button type="button" aria-label={`Don't ping ${ping.name}`} onClick={() => removePendingPing(terminalContextKey, ping.email)}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      {terminalContexts.length ? (
        <div className="pending-terminal-context">
          <TerminalContextChips
            contexts={terminalContexts}
            onRemove={(context) => removeTerminalContext(task.id, tab.id, context.sourceTaskId, context.sourceTabId)}
          />
          <small>say what it should take from {contextName}{terminalContexts.length > 1 ? ` + ${terminalContexts.length - 1} more` : ''}</small>
        </div>
      ) : null}
      <ImageAttachments
        attachments={images}
        pending
        onRemove={(attachment) => removePendingImage(terminalContextKey, attachment.id)}
      />
      <textarea
        rows={2}
        placeholder={contextName ? `What should it take from ${contextName}?` : runRef ? 'Type your next message while this runs…' : 'Ask for a change, @mention context, run /commands'}
        data-draft={idx}
        value={draft}
        disabled={inputLocked}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="bt">
        {isDuel ? (
          <button className="chip mdl" title="Duel contenders are blind until you choose"><u /><span className="mdl-name">{modelText}</span></button>
        ) : (
          <button
            className={`chip mdl ${tab.model === RECOMMENDED_MODEL.id ? 'recommended' : ''}`}
            onClick={(e) => openPop(e.currentTarget, 'tabmodel', idx)}
          >
            <ModelMark id={tab.model} /><span className="mdl-name">{modelText}</span> <Icon name="chevronDown" size={11} />
          </button>
        )}
        <button className="pinbtn fold" title="Attach context and manage connectors" onClick={(e) => openPop(e.currentTarget, 'connectors', idx)}>
          <Icon name="paperclip" size={15} />
        </button>
        {effortLocked ? (
          <button className="eff" title="Effort locked for both contenders"><EffortBars value={shownEffort} /> <span className="eff-label">{shownEffort}</span></button>
        ) : (
          <button className="eff" title={`Effort · ${shownEffort}`} onClick={(e) => openPop(e.currentTarget, 'effort')}><EffortBars value={shownEffort} /> <span className="eff-label">{shownEffort}</span></button>
        )}
        <i />
        {/* Section 27: how many roster tabs the orchestrator is still waiting on. */}
        {tab.type === 'orchestrator' ? (() => { const out = Object.values(laneStates(tab)).filter((lane) => lane.askedAt && !lane.answeredAt).length; return out ? <span className="comp-out" data-tabs-out={out}>{out} {out === 1 ? 'tab' : 'tabs'} still out</span> : null; })() : null}
        <button className="plusbtn fold" title="New blank tab · same context and model" onClick={() => { void newTab(task.id, tab.model || task.model || 'recommended', idx); }}>
          <Icon name="plus" size={15} />
        </button>
        {isDuel ? null : (
          <>
            {state.panes.length > 1 ? <button className="pullbtn fold" onClick={(e) => openPop(e.currentTarget, 'pullcontext', idx)}><Icon name="fileText" size={12} /> Pull</button> : null}
            <button className="duelbtn fold" onClick={() => createDuel(idx)}><span className="dico"><Icon name="columns" size={12} /></span>Duel</button>
          </>
        )}
        {/* Paper 13.2: as the pane narrows, Duel, Pull, New tab and Attach fold
            into these dots in that order; the effort label and model name go
            next; send never folds. The CSS container queries decide when. */}
        <button className="morebtn" title="More" aria-label="More composer actions" onClick={(e) => openPop(e.currentTarget, 'composermore', idx)}>
          <Icon name="ellipsis" size={15} />
        </button>
        <button
          className={`send ${(draft.trim() || images.length) && !inputLocked ? 'on' : ''}`}
          disabled={inputLocked}
          aria-label={runRef ? 'Steer current run' : 'Send'}
          title={runRef ? 'Send to the current run' : 'Send'}
          onClick={() => triggerSend(String(idx))}
        >
          ↑
        </button>
        {state.view === 'landed' ? <LandedControls /> : null}
      </div>
    </div>
  );
}

function LandedControls() {
  const place = landedPlace();
  return (
    <span className="landed-ctl" data-landed-controls>
      <span className="landed-div" aria-hidden />
      <button type="button" className="landed-step" title="Previous (K or left arrow)" aria-label="Previous" aria-keyshortcuts="k ArrowLeft" data-landed-prev disabled={!place.prev} onClick={() => landedStep(-1)}><Icon name="chevronLeft" size={14} /><kbd>K</kbd></button>
      <span className="landed-left" data-landed-left>{place.recent
        ? (place.at >= 0 ? <><b key={place.at}>{place.at + 1}</b> of {place.rows.length} recent</> : <><b key={place.rows.length}>{place.rows.length}</b> recent</>)
        : <><b key={place.left}>{place.left}</b> left</>}</span>
      <button type="button" className="landed-step" title="Next (J or right arrow)" aria-label="Next" aria-keyshortcuts="j ArrowRight" data-landed-next disabled={!place.next} onClick={() => landedStep(1)}><Icon name="chevronRight" size={14} /><kbd>J</kbd></button>
      <button type="button" className="landed-complete" title="Complete (E or Command Return)" aria-keyshortcuts="e Meta+Enter" data-landed-complete onClick={() => landedComplete()}>Complete<kbd>E</kbd></button>
    </span>
  );
}
