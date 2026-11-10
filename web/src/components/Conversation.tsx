import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SentGroup, WroteRow } from './OrchRows';
import { useHeldReplies } from '../lib/laneClock';
import type { TrafficEvent } from '../types';
import { pendingConfirmation, peekingTab, useApp, state } from '../store';
import { HandoffMark, Message } from './Message';
import { FoldMark } from './Fold';
import { CapacityMarker, ModelHandoffMarker } from './ModelHandoff';
import { Composer } from './Composer';
import { LiveStreamBlock, RunBlockView } from './StreamingBlock';
import { DuelProgressMarker, DuelTimelineMarker } from './Duel';
import { SignupFork, SignupMarker } from './SignupMarker';
import { keepPeekedTab, openDecidedDuel, openMap, runTab, unfoldTab, readTabMessagesNow, selectTab, streamKey, tabRunRef, unarchiveThread, withdrawQueued, retryBlockedPrompts, takeBackBlockedPrompt } from '../actions';
import { DoneMark } from './DoneMark';
import { Icon } from '../icons';
import type { QueuedMessage } from '../types';
import { trackConversationScroll } from '../lib/dom';
import type { EmbeddedDuel, Fold, Message as MessageT, ModelHandoff, Task, Tab } from '../types';
import { TerminalContextChips } from './TerminalContext';
import { ImageAttachments } from './ImageAttachments';
import { tabAsleep, tabVitality } from '../lib/vitality';
import { BRINGS_BACK, OPENS_WITH, earlierCount, forgetWholeThread, startFor, wantsWholeThread } from '../lib/earlier';
import { tabSearchMatches } from '../lib/tab-search';
import { TabFind } from './TabFind';

const DONE_OFFER_QUIET_MS = 6 * 3_600_000;

function transcriptNodes(
  messages: MessageT[],
  handoffs: ModelHandoff[],
  duels: EmbeddedDuel[],
  onOpenDuel: (duelId: string) => void,
  confirmationIndex: number,
  onConfirmation: (response: string) => void,
  landedIndex = -1,
  handedTo: { toTabId: string; toName: string; at: string; atMessageCount: number; toThreadId?: string; toThreadTitle?: string }[] = [],
  retryIndex = -1,
  onRetry: (() => void) | null = null,
  fold: { record: Fold; onUnfold: () => void } | null = null,
  threadId = '',
  orchestrator = false,
  traffic: TrafficEvent[] = [],
  // Where the drawn transcript starts; everything before it waits behind
  // the Show earlier row.
  from = 0,
  searchSelected = -1,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Section 27: what the orchestrator wrote to its map sits in the
  // transcript where it happened, with its undo (board 27.6).
  const slots = new Map<number, TrafficEvent[]>();
  for (const event of traffic) {
    const at = Date.parse(event.at) || 0;
    let slot = messages.findIndex((message) => (Date.parse(message.ts || '') || 0) >= at);
    if (slot < 0) slot = messages.length;
    slots.set(slot, [...(slots.get(slot) || []), event]);
  }
  for (let boundary = from; boundary <= messages.length; boundary += 1) {
    // Paper 12.2: the one surface auto-contextualize has, where the folded
    // messages end and the ones the model still reads verbatim begin.
    if (fold && boundary === fold.record.keptFrom && boundary > 0) nodes.push(<FoldMark key={`fold-${fold.record.id}`} fold={fold.record} onUnfold={fold.onUnfold} />);
    handedTo
      .filter((row) => row.atMessageCount === boundary)
      .forEach((row) => nodes.push(<HandoffMark key={`handed-${row.toTabId}-${row.at}`} direction="out" name={row.toThreadTitle ? `${row.toThreadTitle} / ${row.toName}` : row.toName} target={(row.toThreadId || threadId) ? { threadId: row.toThreadId || threadId, tabId: row.toTabId } : null} />));
    handoffs
      .filter((handoff) => handoff.atMessageCount === boundary)
      .forEach((handoff) => nodes.push(<ModelHandoffMarker key={`handoff-${handoff.id}`} handoff={handoff} />));
    duels
      .filter((duel) => duel.atMessageCount === boundary)
      .forEach((duel) => nodes.push(<DuelTimelineMarker key={`duel-${duel.duelId}`} duel={duel} onOpen={() => onOpenDuel(duel.duelId)} />));
    (slots.get(boundary) || []).forEach((event) => nodes.push(<WroteRow key={`wrote-${event.id}`} event={event} threadId={threadId} />));
    if (boundary < messages.length && !messages[boundary].hiddenInTranscript) {
      const message = messages[boundary];
      // Section 27: the sends that left in one turn read as one row.
      if (orchestrator && message.role === 'tab' && message.direction === 'out') {
        let end = boundary;
        while (end + 1 < messages.length && messages[end + 1].role === 'tab' && messages[end + 1].direction === 'out') end += 1;
        if (end > boundary) {
          nodes.push(<SentGroup key={`sent-${boundary}`} messages={messages.slice(boundary, end + 1)} fromIndex={boundary} searchSelected={searchSelected} />);
          boundary = end;
          continue;
        }
      }
      if (message.role === 'assistant' && message.fellBackFrom && message.model) nodes.push(<CapacityMarker key={`capacity-${boundary}`} fromModel={message.fellBackFrom} toModel={message.model} />);
      nodes.push(<Message key={`message-${boundary}`} m={messages[boundary]} threadId={threadId} searchIndex={boundary} searchSelected={boundary === searchSelected} confirmationActive={boundary === confirmationIndex} onConfirmation={onConfirmation} landed={boundary === landedIndex} onRetry={boundary === retryIndex ? onRetry : null} />);
    }
  }
  return nodes;
}

function queueLine(item: QueuedMessage): string {
  if (item.status === 'running') return item.mine ? 'You, going in now, on your Mac' : `${item.name}, going in now`;
  if (item.status === 'expired') return `Did not go, ${item.name}'s Mac was away`;
  if (item.status === 'failed') return 'Did not go';
  if (item.mine) return 'You, goes in after this turn, runs on your Mac';
  return item.online ? `${item.name}, goes in after this turn` : `Waiting for ${item.name}'s Mac`;
}

// Ported from vanilla conv(): transcript + live run + composer.
export function Conversation({ task, tab, idx }: { task: Task; tab: Tab; idx: number }) {
  useApp();
  const key = streamKey(task.id, tab.id);
  const localStream = state.streams[key] || null;
  const activeRun = tab.activeRun || null;
  const streaming = !!(localStream || activeRun);
  // Same team: a run on another person's Mac is shown, never steered or
  // stopped from here, and this composer stays live (the message queues).
  const remote = !localStream && !!activeRun?.remote;
  const runRef = remote ? null : tabRunRef(task, tab);
  const teamQueue = (tab.queue || []).filter((item) => !(item.mine && item.status === 'expired') && item.status !== 'done');
  const typers = (tab.typing || []).map((typer) => typer.name);
  const queued = state.queuedPrompts[key] || [];
  const messages = tab.messages || [];
  // Section 27, board 27.4: in an orchestrator tab a reply lands in the
  // thread as its returning pass reaches the hub, not before.
  const heldReplies = useHeldReplies(tab);
  const shownMessages = tab.type === 'orchestrator' && heldReplies.size ? messages.filter((message) => !(message.id && heldReplies.has(message.id))) : messages;
  const find = state.view === 'tab' && state.tabSearch?.key === key ? state.tabSearch : null;
  const searchHits = useMemo(() => tabSearchMatches(shownMessages, find?.query || ''), [shownMessages, find?.query]);
  const searchSelected = find && searchHits.length ? searchHits[Math.min(find.selected, searchHits.length - 1)] : -1;
  const activeFold = tab.folds?.length ? tab.folds[tab.folds.length - 1] : null;
  const opened = useRef<{ key: string; start: number } | null>(null);
  const [, redraw] = useState(0);
  if ((!opened.current || opened.current.key !== key) && shownMessages.length) opened.current = { key, start: startFor(shownMessages, OPENS_WITH) };
  if (opened.current?.key === key && wantsWholeThread(key)) opened.current.start = 0;
  const startAt = opened.current?.key === key ? Math.min(opened.current.start, shownMessages.length) : 0;
  const earlier = earlierCount(shownMessages, startAt);
  const convEl = useRef<HTMLDivElement>(null);
  const heldPlace = useRef<{ el: Element; top: number } | null>(null);
  const showEarlier = (row: HTMLElement) => {
    if (!opened.current) return;
    // What is on screen stays where it is; the older stretch arrives above.
    // The turn under the row is the thing held, by its own edge, since its
    // spacing changes once it is no longer the first thing drawn.
    const under = row.nextElementSibling;
    if (under) heldPlace.current = { el: under, top: under.getBoundingClientRect().top };
    const showing = shownMessages.slice(startAt).filter((message) => !message.hiddenInTranscript).length;
    opened.current.start = startFor(shownMessages, showing + BRINGS_BACK);
    redraw((tick) => tick + 1);
  };
  useLayoutEffect(() => {
    const el = convEl.current;
    const held = heldPlace.current;
    heldPlace.current = null;
    if (!el || !held || !held.el.isConnected) return;
    el.dataset.autoFollow = 'false';
    // The rows that just arrived are drawn lazily: the ones next to the
    // screen take their real heights over the following frames and push the
    // page down again, so the place is held until they have, or until the
    // reader moves.
    let frames = 24;
    const letGo = () => { frames = 0; };
    el.addEventListener('wheel', letGo, { once: true, passive: true });
    el.addEventListener('touchmove', letGo, { once: true, passive: true });
    const hold = () => {
      if (frames <= 0 || !held.el.isConnected) { el.removeEventListener('wheel', letGo); el.removeEventListener('touchmove', letGo); return; }
      frames -= 1;
      const drift = held.el.getBoundingClientRect().top - held.top;
      if (Math.abs(drift) >= 1) el.scrollTop += drift;
      requestAnimationFrame(hold);
    };
    hold();
  });
  useEffect(() => () => forgetWholeThread(key), [key]);
  // Section 26: waiting is a position, not a state. Inbound tab messages
  // after this tab's last answer have not been read by any turn.
  const lastAnswer = messages.map((message) => message.role).lastIndexOf('assistant');
  const waitingMail = messages.slice(lastAnswer + 1).filter((message) => message.role === 'tab' && message.direction === 'in');
  const confirmation = !streaming ? pendingConfirmation(tab) : null;
  let confirmationIndex = -1;
  if (confirmation) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].confirmation === confirmation) { confirmationIndex = index; break; }
    }
  }
  let retryIndex = -1;
  let retryPrompt = '';
  if (!streaming && !teamQueue.length && !queued.length) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].hiddenInTranscript) continue;
      if (messages[index].role === 'assistant' && messages[index].ok === false && !messages[index].stopped) {
        for (let back = index - 1; back >= 0; back -= 1) {
          if (messages[back].role === 'user' && (messages[back].content || '').trim()) {
            retryIndex = index;
            retryPrompt = messages[back].content;
            break;
          }
        }
      }
      break;
    }
  }
  const liveHandoff = localStream?.handoff || activeRun?.handoff || null;
  const handoffsById = new Map((tab.handoffs || []).map((handoff) => [handoff.id, handoff]));
  if (liveHandoff) handoffsById.set(liveHandoff.id, liveHandoff);
  const handoffs = [...handoffsById.values()].sort((a, b) => a.atMessageCount - b.atMessageCount || a.startedAt.localeCompare(b.startedAt));
  const duels = [...(tab.duels || [])].sort((a, b) => a.atMessageCount - b.atMessageCount || String(a.pickedAt || '').localeCompare(String(b.pickedAt || '')));
  const liveDuels = (task.tabs || []).filter((candidate) => candidate.type === 'duel'
    && candidate.duel?.sourceTabId === tab.id
    && !candidate.duel.choice);
  const empty = messages.every((message) => message.hiddenInTranscript) && !duels.length && !liveDuels.length && !streaming;
  const lastVisible = [...messages].reverse().find((message) => !message.hiddenInTranscript && !message.note);
  // Paper 20.6: this tab is an archived peek — read-only, gone on switch.
  const peeking = peekingTab(task, tab.id);
  const landedClean = !!lastVisible && lastVisible.role === 'assistant' && lastVisible.ok !== false && !lastVisible.stopped;
  const quietLongEnough = !!lastVisible && Date.now() - (Date.parse(lastVisible.ts || '') || Date.now()) >= DONE_OFFER_QUIET_MS;
  // Paper 16.6: the latest turn's rule reads green while the tab is awake and
  // nothing is waiting on the user; every earlier turn is a plain hairline.
  let landedIndex = -1;
  if (!streaming && tabVitality(task, tab) === 'awake' && !tabAsleep(task, tab)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].hiddenInTranscript) continue;
      if (messages[index].role === 'assistant') landedIndex = index;
      break;
    }
  }

  return (
    <><TabFind searchKey={key} hits={searchHits} convRef={convEl} />
    <div className="conv ph-no-capture" ref={convEl} tabIndex={-1} data-conv-key={key} onScroll={(event) => trackConversationScroll(event.currentTarget)}>
      {peeking ? <PeekBanner task={task} tab={tab} /> : task.archived ? <ArchivedBanner task={task} /> : null}
      {task.origin === 'signup' ? <SignupMarker /> : null}
      {/* Connected tabs, board 2: a tab opened from a card says where it
          came from, in the hairline grammar; the row leads back to the map. */}
      {state.openedFrom && state.openedFrom.threadId === task.id && state.openedFrom.tabId === tab.id ? (
        <button type="button" className="handoff-mark opened-from" data-opened-from={state.openedFrom.mapThreadId} title="Back to the map" onClick={() => void openMap(state.openedFrom!.mapThreadId)}>
          <span className="handoff-glyph"><Icon name="connected" size={14} /></span>
          <span className="handoff-label">Opened from {state.openedFrom.title}</span>
          <i />
        </button>
      ) : null}
      {empty ? (
        <div className="empty">
          <div className="ttl" style={{ fontSize: 14 }}>Nothing in this tab yet</div>
          <div className="sub">Tell it what to do below. Every tab in this workstream shares the same context.</div>
        </div>
      ) : null}
      {startAt > 0 && !find?.query.trim() ? (
        <button type="button" className="earlier-row" data-show-earlier={earlier} onClick={(event) => showEarlier(event.currentTarget)}>
          <span className="handoff-glyph" aria-hidden><Icon name="arrowUp" size={11} /></span>
          <span className="earlier-label">Show earlier</span>
          <i />
          <small>{earlier} {earlier === 1 ? 'message' : 'messages'}</small>
        </button>
      ) : null}
      {transcriptNodes(
        shownMessages,
        handoffs,
        duels,
        (duelId) => openDecidedDuel(idx, task.id, tab.id, duelId),
        confirmationIndex,
        (response) => { void runTab(task.id, tab.id, response, tab.model); },
        landedIndex,
        tab.handedTo || [],
        retryIndex,
        retryIndex >= 0 ? () => { void runTab(task.id, tab.id, retryPrompt, tab.model, { redo: true }); } : null,
        activeFold ? { record: activeFold, onUnfold: () => { void unfoldTab(task.id, tab.id, activeFold.id); } } : null,
        task.id,
        tab.type === 'orchestrator',
        tab.type === 'orchestrator' ? (task.traffic || []) : [],
        find?.query.trim() ? 0 : startAt,
        searchSelected,
      )}
      {liveDuels.map((duelTab) => (
        <DuelProgressMarker key={duelTab.id} duelTab={duelTab} onOpen={() => selectTab(idx, duelTab.id)} />
      ))}
      {streaming
        ? (localStream
          ? <LiveStreamBlock streamKey={key} runRef={runRef} />
          : <RunBlockView run={{ model: activeRun!.model, prompt: activeRun!.prompt, prompts: activeRun!.prompts, hiddenPrompt: activeRun!.hiddenPrompt, terminalContexts: activeRun!.terminalContexts, attachments: activeRun!.attachments, mentions: activeRun!.mentions, contextRefs: activeRun!.contextRefs, pings: activeRun!.pings, steers: activeRun!.steers, tools: activeRun!.tools, effort: activeRun!.effort, statusText: activeRun!.statusText, text: activeRun!.text, draftText: activeRun!.draftText, workNotes: activeRun!.workNotes, error: activeRun!.error, computer: activeRun!.computer, connectors: activeRun!.connectors, startedAt: activeRun!.startedAt, play: activeRun!.play || null, remote: activeRun!.remote || null, interims: activeRun!.interims, scheduled: activeRun!.scheduled || null }} runRef={runRef} />)
        : null}
      {teamQueue.length ? (
        <div className="queued-turns" aria-label={`${teamQueue.length} queued ${teamQueue.length === 1 ? 'message' : 'messages'} for this thread`}>
          {teamQueue.map((item) => (
            <div className={`queued-turn team ${item.status}`} key={item.id} data-team-queued={item.id} data-queue-owner={item.mine ? 'me' : item.name}>
              <div className="ubub">{item.prompt}</div>
              <small>
                {queueLine(item)}
                {item.mine && item.status === 'queued' ? <button type="button" onClick={() => void withdrawQueued(task.id, tab.id, item.id)}>Take back</button> : null}
              </small>
            </div>
          ))}
        </div>
      ) : null}
      {queued.length ? (
        <div className="queued-turns" aria-label={queued.some((item) => item.error) ? 'Messages that did not start' : `${queued.length} queued ${queued.length === 1 ? 'message' : 'messages'} for the next batch`}>
          {queued.map((item, index) => (
            <div className={`queued-turn${item.error ? ' blocked' : ''}`} key={item.id} data-blocked-prompt={item.error ? item.id : undefined}>
              <TerminalContextChips contexts={item.terminalContexts} compact />
              <ImageAttachments attachments={item.attachments} compact />
              <div className="ubub">{item.prompt}</div>
              {item.error ? (
                <div className="blocked-send" role="status">
                  <span>{item.error}</span>
                  <div className="blocked-send-actions">
                    {index === queued.findIndex((candidate) => candidate.error) ? <button type="button" disabled={streaming} onClick={() => retryBlockedPrompts(task.id, tab.id)}>Send again</button> : null}
                    <button type="button" onClick={() => takeBackBlockedPrompt(task.id, tab.id, item.id)}>Take back</button>
                  </div>
                </div>
              ) : <small>{queued.some((candidate) => candidate.error) ? 'Waiting for your retry' : index === 0 ? 'Queued next' : `Queued · ${index + 1} of ${queued.length}`}</small>}
            </div>
          ))}
        </div>
      ) : null}
      {!streaming && waitingMail.length ? (
        <div className="tabmail-waiting" data-waiting={waitingMail.length}>
          {/* Section 21's clock, drawn: something will happen at a later moment. */}
          <svg className="handoff-glyph" width="15" height="15" viewBox="0 0 15 15" aria-hidden><circle cx="7.5" cy="7.5" r="5.3" fill="none" stroke="#9C978E" strokeWidth="1.4" /><path d="M7.5 4.5V7.7L9.8 9.1" fill="none" stroke="#9C978E" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{waitingMail.length} waiting, read on the next run</span>
          <i />
          <button type="button" className="tabmail-read-now" onClick={() => readTabMessagesNow(task.id, tab.id)}>Read now</button>
        </div>
      ) : null}
      {!streaming && !task.archived && !peeking && ((landedClean && quietLongEnough) || tab.done) ? <DoneMark task={task} tab={tab} paneIdx={idx} quietSince={lastVisible?.ts} /> : null}
      {!streaming ? <SignupFork task={task} tab={tab} /> : null}
      <i className="conv-spacer" />
      {typers.length ? (
        <div className="typing-line" aria-live="polite" data-typing={typers.join(', ')}>
          <span className="typing-dots" aria-hidden><i /><i /><i /></span>
          {typers.length === 1 ? `${typers[0]} is typing` : `${typers.slice(0, -1).join(', ')} and ${typers[typers.length - 1]} are typing`}
        </div>
      ) : null}
      {task.archived || peeking ? null : <Composer task={task} tab={tab} idx={idx} disabled={streaming && !localStream?.landed && !remote} runRef={runRef} />}
    </div></>
  );
}

function agoLabel(iso: string | null | undefined): string {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days >= 1) return ` ${days} day${days === 1 ? '' : 's'} ago`;
  const hours = Math.floor((Date.now() - at) / 3_600_000);
  return hours >= 1 ? ` ${hours} hour${hours === 1 ? '' : 's'} ago` : ' today';
}

// Paper 20.4: an archived workstream is read, not reopened.
function ArchivedBanner({ task }: { task: Task }) {
  return (
    <div className="archived-banner" role="status">
      <Icon name="archive" size={14} />
      <div><b>Archived{agoLabel(task.archivedAt)}</b><p>You are reading it, not reopening it. Nothing here will run.</p></div>
      <button type="button" onClick={() => { void unarchiveThread(task.id); }}>Unarchive</button>
    </div>
  );
}

// Paper 20.6: the peek tab's banner — the strip chip is transient, and the
// button is the actual decision.
function PeekBanner({ task, tab }: { task: Task; tab: Tab }) {
  return (
    <div className="archived-banner" role="status">
      <Icon name="archive" size={14} />
      <div><b>You are reading it, not reopening it.</b><p>Nothing here will run, and this tab goes when you switch away.</p></div>
      <button type="button" onClick={() => { void keepPeekedTab(task.id, tab.id); }}>Keep it open</button>
    </div>
  );
}
