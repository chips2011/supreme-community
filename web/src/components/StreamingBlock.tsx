import { useEffect, useState } from 'react';
import { useStream, state, modelLabel, toolLabel } from '../store';
import { stopTabRun, type TabRunRef } from '../actions';
import { WorkNotes, WrittenText } from '../lib/writtenText';
import { followConv } from '../lib/dom';
import { hasRunActivity, RunCard, RunError } from './RunCard';
import { ModelMark } from './bits';
import { HandoffMark, PlayTurn, ScheduledMark, SentTokens } from './Message';
import type { PingResult, ScheduledFire } from '../types';
import type { ComputerActivity as ComputerActivityT, ConnectorActivity, ImageAttachment, InterimAnswer, PlayMarker, SteeredPrompt, ToolEvent, RemoteRunner } from '../types';
import type { TerminalContext } from '../types';
import { ContextualUserTurn } from './TerminalContext';
import { initials } from '../lib/people';
import { withoutFollowups } from '../lib/followups';

const EMPTY_WORK_NOTES: string[] = [];

interface RunView {
  remote?: RemoteRunner | null;
  model?: string | null;
  prompt?: string;
  prompts?: string[];
  hiddenPrompt?: boolean;
  tools: (string | ToolEvent)[];
  statusText?: string;
  text?: string;
  draftText?: string;
  workNotes?: string[];
  effort?: string;
  error?: string | null;
  computer?: ComputerActivityT | null;
  connectors?: ConnectorActivity[];
  terminalContexts?: TerminalContext[];
  attachments?: ImageAttachment[];
  steers?: SteeredPrompt[];
  // Answers to earlier messages in this turn, one in front of each steer.
  interims?: InterimAnswer[];
  startedAt?: string | null;
  // The turn has finished and is landing on screen (Paper 16.6): the card
  // plays its ending here before the transcript takes over.
  landed?: { at: number; green: boolean } | null;
  // A play typed this turn (Paper 17.5).
  play?: PlayMarker | null;
  // Section 21: handed here from another tab; the row shows while it runs.
  handedFrom?: { tabId: string; name: string; threadId?: string; threadTitle?: string } | null;
  // Section 29: the scheduled task that sent this turn.
  scheduled?: ScheduledFire | null;
  // Paper 21.2b: the chips that rode this send, and how the pings went.
  mentions?: { email: string; name: string }[];
  contextRefs?: string[];
  pings?: PingResult[] | null;
}

// Steered messages in send order, each with the answer the model had given
// before it (an interim) standing in front of it, so a follow-up never looks
// like it swallowed the earlier reply.
function SteeredTurns({ steers = [], interims = [] }: { steers?: SteeredPrompt[]; interims?: InterimAnswer[] }) {
  if (!steers.length) return null;
  const remaining = interims.filter((item) => item.text.trim());
  return (
    <div className="steered-turns" aria-label={`${steers.length} ${steers.length === 1 ? 'message' : 'messages'} sent to the current run`}>
      {steers.map((steer) => {
        const prompts = steer.prompts?.length ? steer.prompts : steer.prompt ? [steer.prompt] : [];
        const index = remaining.findIndex((item) => item.id === steer.id);
        const interim = index >= 0 ? remaining.splice(index, 1)[0] : (remaining.length && !remaining[0].id ? remaining.shift() : null);
        return (
          <div className={`steered-turn ${steer.delivery || 'accepted'}`} key={steer.id}>
            {interim ? (
              <div className="assistant-block interim" data-interim>
                <WrittenText value={interim.text} inferWorkNotes={false} />
              </div>
            ) : null}
            {prompts.map((prompt, index) => (
              <ContextualUserTurn
                contexts={index === 0 ? steer.terminalContexts : undefined}
                attachments={(steer.attachments || []).filter((attachment) => Number(attachment.promptIndex || 0) === index)}
                key={`${steer.id}-${index}`}
              >
                {prompt}
              </ContextualUserTurn>
            ))}
            {steer.mentions?.length || steer.contextRefs?.length
              ? <SentTokens contextRefs={steer.contextRefs} mentions={steer.mentions} pings={steer.pings || undefined} />
              : null}
            <small>{steer.delivery === 'sending' ? 'Sending to this run…' : 'Steering current run'}</small>
          </div>
        );
      })}
    </div>
  );
}

// A ticking wait clock while the model works. Long pre-tool waits looked like
// hangs when the only signal was a wordless "thinking" pulse.
function ThinkingClock({ startedAt }: { startedAt?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const parsed = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(parsed)) return null;
  const seconds = Math.max(0, Math.floor((now - parsed) / 1_000));
  if (seconds < 5) return null;
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return <em className="thinking-clock">{label}</em>;
}

function ThinkingState({ remote = null,
  model,
  statusText,
  workNotes,
  runRef,
  hasActivity,
  error,
  startedAt,
}: { remote?: RemoteRunner | null;
  model?: string | null;
  statusText?: string;
  workNotes: string[];
  runRef?: TabRunRef | null;
  hasActivity: boolean;
  error?: string | null;
  startedAt?: string | null;
}) {
  const label = model ? modelLabel(model) : 'Model';
  const stopping = !!(runRef?.key && state.stoppingRuns[runRef.key]);
  const status = error ? 'stopped' : stopping ? 'interrupting' : 'thinking';
  const idle = !error && !hasActivity;
  const reasoning = !error && idle ? String(statusText || '').trim() : '';
  return (
    <div className={`thinking-state ${error ? 'failed' : ''}`}>
      <div className="thinking-head" aria-label={`${label} ${status}`}>
        {model ? <ModelMark id={model} /> : <u />}
        <b>{label}</b>
        <span className="thinking-status"><i />{status}{stopping ? '…' : ''}</span>
        {!error && !stopping ? <ThinkingClock startedAt={startedAt} /> : null}
        {remote ? <span className="thinking-remote" data-remote-run={remote.name}>Running on {remote.name}'s Mac</span> : null}
        {runRef && !remote && !hasActivity && !error ? (
          <button
            type="button"
            className="thinking-interrupt"
            disabled={stopping}
            aria-keyshortcuts="Escape"
            onClick={() => stopTabRun(runRef.threadId, runRef.tabId)}
          >
            {stopping ? 'Interrupting…' : <><kbd>Esc</kbd><span>to interrupt</span></>}
          </button>
        ) : null}
      </div>
      {reasoning ? <div className="thinking-reasoning">{reasoning}</div> : null}
      <WorkNotes notes={workNotes} live />
    </div>
  );
}

// The live assistant block. Shared markup for both the local SSE stream and a
// recovered activeRun. Ported from the vanilla streaming render.
export function RunBlockView({ run, runRef }: { run: RunView; runRef?: TabRunRef | null }) {
  const toolLabels = (run.tools || []).map(toolLabel);
  const prompts = run.prompts?.length ? run.prompts : run.prompt ? [run.prompt] : [];
  // Rendered as it arrives: the store already paints live text at most
  // twenty times a second. Deferring it here on top of that let a run of
  // sync updates starve the deferred render, and the live block sat frozen
  // for seconds while the text piled up behind it (2026-09-07 probe).
  const writtenText = withoutFollowups(run.text || run.draftText || '');
  const workNotes = run.workNotes || EMPTY_WORK_NOTES;
  const hasActivity = hasRunActivity({ tools: run.tools, computer: run.computer, connectors: run.connectors });
  const workNotesRevision = workNotes.join('\u0000');
  const toolRevision = toolLabels.join('|');
  const connectorRevision = (run.connectors || []).map((activity) => `${activity.id}:${activity.updatedAt}:${activity.state}`).join('|');
  const computerRevision = run.computer?.updatedAt || '';
  useEffect(() => {
    if (runRef?.key) followConv(runRef.key);
  }, [runRef?.key, writtenText, workNotesRevision, run.statusText, run.error, toolRevision, connectorRevision, computerRevision]);
  const promptTurns = run.hiddenPrompt ? null : prompts.map((prompt, index) => (
    <ContextualUserTurn
      contexts={index === 0 ? run.terminalContexts : undefined}
      attachments={(run.attachments || []).filter((attachment) => Number(attachment.promptIndex || 0) === index)}
      key={`${index}-${prompt}`}
    >
      {prompt}
    </ContextualUserTurn>
  ));
  // The chips that rode this send show under the live bubble exactly as they
  // will under the landed one, so a ping's fate never waits for Esc.
  const promptTurnsWithTokens = promptTurns && !run.hiddenPrompt
    ? <>{promptTurns}<SentTokens contextRefs={run.contextRefs} mentions={run.mentions} pings={run.pings || undefined} /></>
    : promptTurns;
  // Same team (Paper 19.6): the other person's message carries their name
  // while their Mac is still working on it.
  const attributedTurns = run.remote && promptTurnsWithTokens
    ? (
      <div className="turn-by" data-author={run.remote.name}>
        <small className="turn-author"><span className="av-mini" aria-hidden>{initials(run.remote.name)}</span>{run.remote.name}</small>
        {promptTurnsWithTokens}
      </div>
    )
    : promptTurnsWithTokens;
  return (
    <>
      {run.scheduled && !run.hiddenPrompt ? <ScheduledMark fire={run.scheduled} /> : null}
      {run.handedFrom && !run.hiddenPrompt ? <HandoffMark direction="in" name={run.handedFrom.threadTitle ? `${run.handedFrom.threadTitle} / ${run.handedFrom.name}` : run.handedFrom.name} target={(run.handedFrom.threadId || runRef?.threadId) ? { threadId: run.handedFrom.threadId || runRef!.threadId, tabId: run.handedFrom.tabId } : null} /> : null}
      {run.play && attributedTurns ? <PlayTurn marker={run.play}>{attributedTurns}</PlayTurn> : attributedTurns}
      <SteeredTurns steers={run.steers} interims={run.interims} />
      <div className={`assistant-block ${run.landed ? (run.landed.green ? 'landed' : '') : 'writing'}`}>
        {run.landed
          ? <WorkNotes notes={workNotes} />
          : <ThinkingState model={run.model} statusText={run.statusText} workNotes={workNotes} runRef={run.remote ? null : runRef} hasActivity={hasActivity} error={run.error} startedAt={run.startedAt} remote={run.remote || null} />}
        <RunCard
          tools={run.tools}
          statusText={run.statusText}
          error={run.error}
          computer={run.computer}
          connectors={run.connectors}
          runRef={run.landed ? null : runRef}
          waiting={!!run.landed && !run.landed.green}
          turnStartedAt={run.startedAt}
          turnMs={run.landed && run.startedAt ? Math.max(0, run.landed.at - Date.parse(run.startedAt)) : null}
        />
        {run.error && !hasActivity ? <RunError message={run.error} /> : null}
        <WrittenText value={writtenText} inferWorkNotes={false} />
      </div>
    </>
  );
}

// Subscribes to the stream slice so token deltas re-render only this block, not
// the whole app (the vanilla trick of patching #streamtext directly).
export function LiveStreamBlock({ streamKey, runRef }: { streamKey: string; runRef?: TabRunRef | null }) {
  useStream(streamKey);
  const st = state.streams[streamKey];
  if (!st) return null;
  return <RunBlockView run={{ model: st.model, prompt: st.prompt, prompts: st.prompts, hiddenPrompt: st.hiddenPrompt, terminalContexts: st.terminalContexts, attachments: st.attachments, mentions: st.mentions, contextRefs: st.contextRefs, pings: st.pings, steers: st.steers, tools: st.tools, effort: st.effort, statusText: st.statusText, text: st.text, draftText: st.draftText, workNotes: st.workNotes, error: st.error, computer: st.computer, connectors: st.connectors, startedAt: st.startedAt, landed: st.landed || null, play: st.play || null, interims: st.interims, handedFrom: st.handedFrom || null, scheduled: st.scheduled || null }} runRef={runRef} />;
}
