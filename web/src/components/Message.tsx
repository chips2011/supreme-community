import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { draftPicks, WorkNotes, WrittenText } from '../lib/writtenText';
import type { DraftPick } from '../lib/writtenText';
import { hasRunActivity, RunCard, RunError } from './RunCard';
import { ContextualUserTurn } from './TerminalContext';
import { Icon } from '../icons';
import { turnWaiting } from '../lib/vitality';
import { meId } from '../store';
import { allowForSchedule, confirmEmailHandoff, openScheduled, openThreadAt } from '../actions';
import { fireLine } from '../lib/scheduled';
import { clockTime } from '../lib/orchestrator';
import { initials } from '../lib/people';
import type { ReactNode } from 'react';
import type { ConfirmationRequest, Message as Msg, PlayMarker, PingResult, ScheduledFire } from '../types';

function ConfirmationPrompt({ request, onReply, waitingOn, needs, asked, picked }: { request: ConfirmationRequest; onReply: (response: string) => void; waitingOn?: string; needs?: Msg['needs']; asked?: { threadId: string; messageId: string }; picked?: { send: DraftPick[]; skip: DraftPick[] } }) {
  const [answered, setAnswered] = useState(false);
  useEffect(() => { setAnswered(false); }, [request]);
  const reply = (response: string) => {
    if (answered) return;
    setAnswered(true);
    onReply(response);
  };
  if (waitingOn) {
    // A teammate's ask: their turn runs on their Mac with their accounts, so
    // this side watches instead of answering.
    return (
      <section className="confirmation-request waiting-other" aria-label={`Waiting on ${waitingOn}`}>
        <div className="confirmation-copy">
          <span className="confirmation-mark"><Icon name="message" size={13} /></span>
          <div><b>Waiting on {waitingOn} to confirm</b><p>{request.question}</p></div>
        </div>
      </section>
    );
  }
  return (
    <section className="confirmation-request" aria-label="Confirmation required">
      <div className="confirmation-copy">
        <span className="confirmation-mark"><Icon name="message" size={13} /></span>
        <div><b>Needs your confirmation</b><p>{request.question}</p></div>
      </div>
      <div className="confirmation-actions">
        {request.emailHandoff && asked?.threadId ? (
          <button className="primary" type="button" disabled={answered} onClick={() => { if (answered) return; setAnswered(true); void confirmEmailHandoff(asked.threadId, request.emailHandoff!).then((ok) => { if (!ok) setAnswered(false); }); }}>{request.confirmLabel}</button>
        ) : picked ? (
          <button className="primary" type="button" disabled={answered || !picked.send.length} onClick={() => reply(pickedResponse(request, picked))}>Send {picked.send.length}</button>
        ) : (
          <button className="primary" type="button" disabled={answered} onClick={() => reply(request.confirmResponse)}>{request.confirmLabel}</button>
        )}
        {/* Section 29, boards 29.7 and 29.8: a scheduled run stopped here
            because this was not on its task's Always allowed list. Allowing
            it answers this ask and lets the next run go ahead by itself. The
            button says exactly what is granted, and the grant is the pair
            the service checked, named by this answer's id. */}
        {needs && asked?.threadId && asked.messageId ? (
          <button type="button" disabled={answered} data-always-allow={`${needs.app} · ${needs.action}`} onClick={() => { void allowForSchedule(needs.scheduleId, asked); reply(request.confirmResponse); }}>Always allow {needs.app} · {needs.action}</button>
        ) : null}
        <button type="button" disabled={answered} onClick={() => reply(request.declineResponse)}>{request.declineLabel}</button>
        <small>{answered ? 'Sent.' : 'Buttons send your reply to the model.'}</small>
      </div>
    </section>
  );
}

// Section 31.1: the ticked drafts go back as plain words the model can act
// on, with the skipped ones named so nothing is guessed.
function numberRuns(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    runs.push(j > i ? `${sorted[i]} to ${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}` : runs[0] || '';
}
function pickedResponse(request: ConfirmationRequest, picked: { send: DraftPick[]; skip: DraftPick[] }): string {
  if (!picked.skip.length) return request.confirmResponse;
  const skipped = picked.skip.map((row) => `${row.n} (${row.name})`).join(', ');
  return `Send only ${numberRuns(picked.send.map((row) => row.n))}. Skip ${skipped}, do not send ${picked.skip.length > 1 ? 'those' : 'that one'}.`;
}

// The answer text and its confirmation card, sharing which drafts are ticked.
function AnswerWithConfirmation({ m, threadId, confirmationActive, onConfirmation }: { m: Msg; threadId: string; confirmationActive: boolean; onConfirmation?: (response: string) => void }) {
  const asking = confirmationActive && !!m.confirmation && !!onConfirmation;
  const picks = useMemo(() => (asking ? draftPicks(m.content) : []), [asking, m.content]);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => { setSkipped(new Set()); }, [m.content]);
  const toggle = (block: number) => setSkipped((current) => {
    const next = new Set(current);
    if (next.has(block)) next.delete(block); else next.add(block);
    return next;
  });
  const waitingOn = m.ranBy?.id && meId() && m.ranBy.id !== meId() ? m.ranBy.name.split(' ')[0] : undefined;
  const picking = picks.length && !waitingOn ? { skipped, toggle, picks } : undefined;
  const picked = picking ? { send: picks.filter((row) => !skipped.has(row.block)), skip: picks.filter((row) => skipped.has(row.block)) } : undefined;
  return (
    <>
      <WrittenText value={m.content} images={m.outputImages} inferWorkNotes={m.workNotes === undefined} picking={picking} />
      {asking ? <ConfirmationPrompt request={m.confirmation!} onReply={onConfirmation!} needs={m.needs} asked={{ threadId, messageId: m.id || '' }} waitingOn={waitingOn} picked={picked} /> : null}
    </>
  );
}

// A message a play typed: the user's own kickoff line first (their bubble),
// then the play's marker and the message it sent for this rule.

// Paper 21.2b: the chips that rode a send, mirrored under the bubble in the
// grey ingredient language the composer used. A person chip also carries the
// fate of its Slack ping: pinged, or not, and why — never a silent failure.
export function SentTokens({ contextRefs, mentions, pings }: { contextRefs?: string[]; mentions?: { email: string; name: string }[]; pings?: PingResult[] }) {
  if (!contextRefs?.length && !mentions?.length) return null;
  return (
    <div className="sent-tokens" aria-label="Sent with">
      {(contextRefs || []).map((name) => (
        <span key={`ref-${name}`} className="token-ingredient"><Icon name="fileText" size={11} />{name}</span>
      ))}
      {(mentions || []).map((person) => {
        const ping = (pings || []).find((row) => row.email.toLowerCase() === person.email.toLowerCase());
        const failed = !!ping && !ping.ok;
        const pinged = !!ping && ping.ok;
        const title = !ping ? 'Pinging on Slack…' : ping.ok ? 'Sent in Slack' : ping.error || 'Not pinged';
        // The receipt is on the chip, not behind a hover (E2E 2026-09-01: a
        // mention "looks like nothing happened").
        return (
          <span key={person.email} className={`token-ingredient${failed ? ' failed' : ''}${pinged ? ' pinged' : ''}`} title={title} data-ping={!ping ? 'pending' : ping.ok ? 'ok' : 'failed'}>
            <Icon name="user" size={11} />{person.name || person.email}{failed ? <small>no ping</small> : pinged ? <small>sent in Slack</small> : null}
          </span>
        );
      })}
    </div>
  );
}

export function PlayTurn({ marker, children }: { marker: PlayMarker; children: ReactNode }) {
  return (
    <div className="play-turn">
      {marker.kickoff ? <ContextualUserTurn>{marker.kickoff}</ContextualUserTurn> : null}
      <small className="play-mark"><Icon name="zap" size={10} />{marker.name}, step {marker.step} of {marker.steps}</small>
      {children}
    </div>
  );
}

export function TabPill({ name, target }: { name: string; target?: { threadId: string; tabId: string } | null }) {
  if (!target) return <b className="handoff-pill">{name}</b>;
  return <button type="button" className="handoff-pill" title={`Open ${name}`} onClick={() => { void openThreadAt(target.threadId, target.tabId); }}>{name}</button>;
}

export function HandoffMark({ direction, name, target = null }: { direction: 'in' | 'out'; name: string; target?: { threadId: string; tabId: string } | null }) {
  return (
    <div className={`handoff-mark ${direction}`}>
      <span className="handoff-glyph" aria-hidden>{direction === 'in' ? '\u21B3' : '\u2192'}</span>
      <span className="handoff-label">{direction === 'in' ? 'Handed over from' : 'Handed to'} <TabPill name={name} target={target} /></span>
      <i />
    </div>
  );
}

const TAB_MIN_LINES = 2;
const readsLong = (text: string) => text.length > 170 || text.split('\n').length > TAB_MIN_LINES;

export function TabMessage({ m, startOpen = false, searchIndex, searchSelected = false }: { m: Msg; startOpen?: boolean; searchIndex?: number; searchSelected?: boolean }) {
  const inbound = m.direction === 'in';
  const address = inbound ? m.from : m.to;
  const name = address ? `${address.threadTitle} / ${address.name}` : 'a tab';
  const sentence = inbound ? (m.replyTo ? 'Reply from' : 'Message from') : (m.replyTo ? 'Replied to' : 'Sent to');
  const [open, setOpen] = useState(startOpen);
  useEffect(() => { if (searchSelected) setOpen(true); }, [searchSelected]);
  const [long, setLong] = useState(() => readsLong(m.content || ''));
  const bubble = useRef<HTMLDivElement>(null);
  // The guess by length stands until the clamped bubble has a layout; then
  // the bubble says for sure, both ways, and says again whenever its size
  // changes (a lazily rendered row getting its layout, the pane resizing).
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el || open) return;
    const measure = () => { if (el.clientHeight) setLong(el.scrollHeight > el.clientHeight + 2); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [m.content, open]);
  const minimized = long && !open;
  return (
    <div className={`tab-message ${inbound ? 'in' : 'out'}${searchSelected ? ' chat-find-active' : ''}`} data-chat-message-index={searchIndex} data-tab-message={m.id} data-tab-direction={inbound ? 'in' : 'out'} data-tab-open={minimized ? 'false' : 'true'}>
      <div className={`handoff-mark ${inbound ? 'in' : 'out'}`}>
        <span className="handoff-glyph" aria-hidden>{inbound ? '\u21B3' : '\u2192'}</span>
        <span className="handoff-label">{sentence} <TabPill name={name} target={address?.threadId && address.tabId ? { threadId: address.threadId, tabId: address.tabId } : null} />{m.viaEmail ? <span className="email-chip" data-email-chip><Icon name="mail" size={10} />Email</span> : null}</span>
        {/* Section 27, board 27.4: the reply carries its time, beside the label. */}
        {m.ts ? <time className="tab-at">{clockTime(m.ts)}</time> : null}
        <i />
        {long ? (
          <button type="button" className="tab-toggle" aria-expanded={open} aria-label={open ? 'Minimize the message' : 'Show the whole message'} title={open ? 'Minimize' : 'Show the whole message'} data-tab-toggle onClick={() => setOpen((value) => !value)}>
            <Icon name="chevronDown" size={11} />
          </button>
        ) : null}
      </div>
      <div ref={bubble} className={`tbub${open ? '' : ' min'}${minimized ? ' more' : ''}`} onClick={minimized ? () => setOpen(true) : undefined}>{m.content}</div>
    </div>
  );
}

// Section 29, board 29.6: the line over a turn a scheduled task sent. On its
// slot it says when; late, it says when it was due, when it ran and why; and
// after slots went by unrun it says it ran once and how many did not. The
// label opens the task.
export function ScheduledMark({ fire }: { fire: ScheduledFire }) {
  const line = fireLine(fire);
  return (
    <div className="handoff-mark in scheduled-mark" data-scheduled-fire={fire.fireId}>
      <span className="handoff-glyph" aria-hidden><Icon name="clock" size={11} /></span>
      <button type="button" className="handoff-label" title={fire.name} onClick={() => openScheduled(fire.id)}>{line.label}</button>
      <i />
      {line.note ? <small className="scheduled-note">{line.note}</small> : null}
    </div>
  );
}

// Section 32, board 32.3a: a forwarded email is the turn, shown as the
// email it was, its subject and the start of it, the chevron for the rest.
function EmailTurn({ m, searchIndex, searchSelected = false }: { m: Msg; searchIndex?: number; searchSelected?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (searchSelected) setOpen(true); }, [searchSelected]);
  const text = String(m.content || '').trim();
  return (
    <div className={`email-turn${searchSelected ? ' chat-find-active' : ''}`} data-email-turn data-chat-message-index={searchIndex}>
      <div className="email-by"><Icon name="mail" size={11} />{m.fromEmail?.vime ? 'Vime' : 'You'} · by email</div>
      <div className={`email-card${open ? ' open' : ''}`}>
        <div className="email-card-head">
          <b>{m.fromEmail?.subject || 'No subject'}</b>
          <button type="button" className="email-card-toggle" aria-expanded={open} aria-label={open ? 'Minimize the email' : 'Show the whole email'} onClick={() => setOpen((value) => !value)}><Icon name="chevronDown" size={12} /></button>
        </div>
        <div className="email-card-body">{text}</div>
      </div>
    </div>
  );
}

function MessageImpl({ m, threadId = '', confirmationActive = false, onConfirmation, landed = false, onRetry = null, searchIndex, searchSelected = false }: { m: Msg; threadId?: string; confirmationActive?: boolean; onConfirmation?: (response: string) => void; landed?: boolean; onRetry?: (() => void) | null; searchIndex?: number; searchSelected?: boolean }) {
  if (m.role === 'tab') return <TabMessage m={m} searchIndex={searchIndex} searchSelected={searchSelected} />;
  // Section 32, board 32.3b: the closing email went out.
  if (m.role === 'email') {
    return (
      <div className="email-sent" data-emailed={m.emailedTo || ''}>
        <Icon name="mail" size={12} />
        <span>Emailed you back</span>
        {m.emailedTo ? <small>{m.emailedTo}</small> : null}
      </div>
    );
  }
  if (m.role === 'user' && m.fromEmail && !m.fromEmail.reply) return <EmailTurn m={m} searchIndex={searchIndex} searchSelected={searchSelected} />;
  if (m.role === 'user') {
    const handed = m.handedFrom ? <HandoffMark direction="in" name={m.handedFrom.threadTitle ? `${m.handedFrom.threadTitle} / ${m.handedFrom.name}` : m.handedFrom.name} target={(m.handedFrom.threadId || threadId) ? { threadId: m.handedFrom.threadId || threadId, tabId: m.handedFrom.tabId } : null} /> : null;
    const prompts = m.batch?.length ? m.batch : [m.content];
    const turns = <>{prompts.map((prompt, index) => (
      <ContextualUserTurn
        searchIndex={searchIndex}
        searchSelected={searchSelected}
        contexts={index === 0 ? m.terminalContexts : undefined}
        briefing={index === 0 ? m.briefing : undefined}
        attachments={(m.attachments || []).filter((attachment) => Number(attachment.promptIndex || 0) === index)}
        key={`${index}-${prompt}`}
      >
        {prompt}
      </ContextualUserTurn>
    ))}</>;
    // Paper 21.2b: the chips that rode this send, mirrored under the bubble
    // in the same grey ingredient language the composer used.
    const tokens = (m.contextRefs?.length || m.mentions?.length)
      ? <SentTokens contextRefs={m.contextRefs} mentions={m.mentions} pings={m.pings} />
      : null;
    const turnsWithTokens = tokens ? <>{turns}{tokens}</> : turns;
    const body = m.play ? <PlayTurn marker={m.play}>{turnsWithTokens}</PlayTurn> : turnsWithTokens;
    // Same team (Paper 19.6): the other person's message carries their name.
    // A turn that came in from Slack says so above the person's name.
    const slackRow = m.fromSlack ? (
      <div className="handoff-mark in slack-from" data-from-slack={m.fromSlack.channel}>
        <span className="handoff-glyph" aria-hidden>#</span>
        <span className="handoff-label">From Slack · #{m.fromSlack.channelName || m.fromSlack.channel}</span>
        <i />
      </div>
    ) : null;
    if (m.author && m.author.id !== meId()) {
      return (
        <div className="turn-by" data-author={m.author.name}>
          {slackRow}
          {handed}
          <small className="turn-author"><span className="av-mini" aria-hidden>{initials(m.author.name)}</span>{m.author.name}</small>
          {body}
        </div>
      );
    }
    if (m.scheduled) return <><ScheduledMark fire={m.scheduled} />{body}</>;
    // A yes that came back by email says so above it.
    if (m.fromEmail?.reply) return <><div className="email-by" data-email-by><Icon name="mail" size={11} />You · by email</div>{body}</>;
    if (handed) return <>{handed}{body}</>;
    // A play typed this one (Paper 17.5). The marker is in the data; the
    // kickoff line the user typed rides on the play's first message.
    return body;
  }
  if (m.role === 'assistant') {
    const hasActivity = hasRunActivity({ tools: m.tools, computer: m.computer, connectors: m.connectors, outsideTouches: m.outsideTouches });
    if (m.ok === false) {
      const why = m.content || m.error || 'The run failed with no output.';
      return (
        <div className={`assistant-block${searchSelected ? ' chat-find-active' : ''}`} data-chat-message-index={searchIndex}>
          <WorkNotes notes={m.workNotes} />
          {hasActivity ? (
            <RunCard
              tools={m.tools}
              error={why}
              computer={m.computer}
              connectors={m.connectors}
              outsideTouches={m.outsideTouches}
              stopped={m.stopped}
              turnMs={m.turnMs}
            />
          ) : <RunError message={why} />}
          {onRetry ? (
            <button type="button" className="run-redo" onClick={onRetry}>
              <Icon name="refresh" size={11} /> Send again
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className={`assistant-block${landed ? ' landed' : ''}${m.interim ? ' interim' : ''}${searchSelected ? ' chat-find-active' : ''}`} data-chat-message-index={searchIndex}>
        <WorkNotes notes={m.workNotes} />
        <RunCard
          tools={m.tools}
          computer={m.computer}
          connectors={m.connectors}
          outsideTouches={m.outsideTouches}
          stopped={m.stopped}
          turnMs={m.turnMs}
          waiting={turnWaiting(m)}
        />
        <AnswerWithConfirmation m={m} threadId={threadId} confirmationActive={confirmationActive} onConfirmation={onConfirmation} />
      </div>
    );
  }
  return null;
}

// A saved message is frozen history: a set() storm from live shared runs must
// not re-render (and re-parse) every one of them. Cache fetches rebuild the
// object each poll, so compare by the fields that can actually change after a
// message lands; onConfirmation's identity is ignored on purpose (it closes
// over stable thread and tab ids).
export const Message = memo(MessageImpl, (prev, next) => (
  prev.confirmationActive === next.confirmationActive
  && prev.searchIndex === next.searchIndex && prev.searchSelected === next.searchSelected
  && prev.threadId === next.threadId
  && prev.landed === next.landed
  // Presence, not identity: the closure is rebuilt every render, but the
  // button only appears or disappears when the transcript tail changes.
  && !!prev.onRetry === !!next.onRetry
  && (prev.m === next.m || (
    prev.m.ts === next.m.ts
    && prev.m.content === next.m.content
    && prev.m.ok === next.m.ok
    && prev.m.stopped === next.m.stopped
    && prev.m.error === next.m.error
    && prev.m.interim === next.m.interim
    && JSON.stringify(prev.m.outputImages) === JSON.stringify(next.m.outputImages)
    && !!prev.m.confirmation === !!next.m.confirmation
    && (prev.m.connectors?.length || 0) === (next.m.connectors?.length || 0)
    && (prev.m.outsideTouches?.length || 0) === (next.m.outsideTouches?.length || 0)
    && (prev.m.workNotes?.length || 0) === (next.m.workNotes?.length || 0)
    && (prev.m.tools?.length || 0) === (next.m.tools?.length || 0)
  ))
));
