import { useEffect, useRef, type ReactNode } from 'react';
import { useApp, state, set, modelLabel } from '../store';
import { EFFORT_NAMES } from '../constants';
import { Icon } from '../icons';
import { WrittenText } from '../lib/writtenText';
import { formatDuration } from '../lib/format';
import { closeDecidedDuel, duelPhase, duelEffortIndex, lockDuel, pickDuel, retryDuel, selectTab, stopTabRun } from '../actions';
import { tabRunRef } from '../actions';
import { Composer } from './Composer';
import { Message } from './Message';
import type { Duel, EmbeddedDuel, Task, Tab } from '../types';
import { ModelMark } from './bits';

function DuelSlot({ side, phase }: { side: 'a' | 'b'; phase: string }) {
  const started = phase !== 'setup';
  const warming = phase === 'ramping';
  const ready = phase === 'ready' || phase === 'running' || phase === 'results';
  return (
    <div className="duel-slot">
      <div className={`cslot ${started ? 'lock' : ''} ${warming ? 'pulse' : ''}`}>{started ? side.toUpperCase() : '?'}</div>
      {warming ? <span>warming up…</span> : null}
      {ready ? <span className="duel-ready-label"><i />ready</span> : null}
    </div>
  );
}

function focusDraft(idx: number) {
  const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
  if (ta) ta.focus();
}

function DuelCard({ task, tab, idx, runningControl }: { task: Task; tab: Tab; idx: number; runningControl?: ReactNode }) {
  const s = useApp();
  const d = tab.duel || ({} as NonNullable<Tab['duel']>);
  const lock = s.duelLocks[tab.id];
  const phase = lock ? 'ramping' : (duelPhase(tab) || 'setup');
  const effortIdx = duelEffortIndex(tab);
  const effort = EFFORT_NAMES[effortIdx] || 'High';
  const source = (task.tabs || []).find((candidate) => candidate.id === d.sourceTabId);

  return (
    <div className={`duel-card ${phase}`}>
      <div className="duel-card-main">
        <div className="duel-head">
          <Icon name="columns" size={14} /><h2>Duel</h2>
        </div>
        <p className="duel-tagline">Two hidden models, one task. You pick the winner.</p>
        <div className="duel-slots"><DuelSlot side="a" phase={phase} /><span className="vsb">vs</span><DuelSlot side="b" phase={phase} /></div>
        <p className="duel-context">Both carry the full “{source?.name || 'this tab'}” context.</p>
      </div>
      {phase === 'setup' ? (
        <div className="duel-foot duel-setup-foot">
          <span>Effort</span>
          <input
            className="dslider"
            aria-label="Duel effort"
            type="range"
            min={0}
            max={4}
            step={1}
            value={effortIdx}
            style={{ '--value': effortIdx } as React.CSSProperties}
            onChange={(e) => { state.duelEffort[tab.id] = Number(e.target.value); set(); }}
          />
          <b>{effort}</b>
          <button className="btn pri" onClick={() => lockDuel(idx)}>Lock it in</button>
        </div>
      ) : null}
      {phase === 'ramping' ? <div className="duel-foot duel-status-foot"><span>Getting both ready…</span></div> : null}
      {phase === 'ready' ? (
        <div className="duel-foot"><b>Both ready</b><i /><button className="btn pri" onClick={() => focusDraft(idx)}>Give them the task ↓</button></div>
      ) : null}
      {phase === 'running' ? <div className="duel-foot"><b><span className="spin" /> Contenders at work</b><i />{runningControl}</div> : null}
      {phase === 'results' ? (
        d.a?.ok === false && d.b?.ok === false ? (
          <div className="duel-foot"><b>Both contenders failed</b><i /><button className="btn pri" onClick={() => retryDuel(idx)}>Retry the Duel</button></div>
        ) : d.a?.ok === false || d.b?.ok === false ? (
          <div className="duel-foot"><b>One contender answered</b><i /><span>Pick it below, or</span><button className="btn" onClick={() => retryDuel(idx)}>retry</button></div>
        ) : (
          <div className="duel-foot"><b>Both answered</b><i /><span>Pick a winner below</span></div>
        )
      ) : null}
    </div>
  );
}

function DuelResultCard({ task, tab, side }: { task: Task; tab: Tab; side: 'a' | 'b' }) {
  const d = tab.duel || ({} as NonNullable<Tab['duel']>);
  const result = d[side] || ({} as NonNullable<typeof d.a>);
  const letter = side.toUpperCase();
  const failed = result.ok === false;
  return (
    <section className={`duel-result ${failed ? 'failed' : ''}`}>
      <header>
        <span className="duel-contender-pill"><Icon name="sparkles" size={11} /> Contender {letter}</span>
        <time>{failed ? 'Run failed' : formatDuration(result.durationMs)}</time>
      </header>
      <div className="duel-output">
        {failed
          ? <div className="err">{result.text || 'This contender failed to return an answer.'}</div>
          : <WrittenText value={result.text || ''} />}
      </div>
      <button className="btn pri duel-pick" disabled={failed} onClick={() => pickDuel(task.id, d.duelId, side)}>Continue with Contender {letter}</button>
    </section>
  );
}

export function PickedDuelHistory({
  tab,
  duel,
  children,
  sourceName,
  onReturn,
}: {
  tab: Tab;
  duel?: Duel;
  children?: ReactNode;
  sourceName?: string;
  onReturn?: () => void;
}) {
  const s = useApp();
  const d = duel || tab.duel || ({} as NonNullable<Tab['duel']>);
  const winnerSide = (d.winnerSide || d.choice) as 'a' | 'b';
  const loserSide = winnerSide === 'a' ? 'b' : 'a';
  const winner = d[winnerSide] || ({} as NonNullable<typeof d.a>);
  const loser = d[loserSide] || ({} as NonNullable<typeof d.a>);
  const openKey = d.duelId || tab.id;
  const open = !!s.duelAltOpen[openKey];
  const winnerDur = formatDuration(winner.durationMs);
  const loserDur = formatDuration(loser.durationMs);
  return (
    <>
      <div className="ubub">{d.prompt || ''}</div>
      <div className="assistant-block">
        <WrittenText value={winner.text || ''} />
        <div className="foot"><span className="model-inline"><ModelMark id={winner.model || ''} />{modelLabel(winner.model)}{winnerDur ? ' · ' + winnerDur : ''}</span></div>
      </div>
      <button className="duel-alt-toggle model-inline" onClick={() => { state.duelAltOpen[openKey] = !state.duelAltOpen[openKey]; set(); }}>
        {open ? 'Hide' : 'Show'} <ModelMark id={loser.model || ''} />{modelLabel(loser.model)}'s take {open ? '↑' : '↓'}
      </button>
      {open ? (
        <div className="duel-alt">
          <div className="duel-alt-head"><b className="model-inline"><ModelMark id={loser.model || ''} />{modelLabel(loser.model)}</b><small>Contender {loserSide.toUpperCase()} · {loserDur}</small></div>
          <WrittenText value={loser.text || ''} />
        </div>
      ) : null}
      <button className="duel-note" onClick={onReturn} disabled={!onReturn}>
        <Icon name="columns" size={12} />
        <span><b className="model-inline"><ModelMark id={winner.model || ''} />{modelLabel(winner.model)} wins.</b> Folding the result back into {sourceName || tab.name}</span>
        <i />
        {onReturn ? <em>↘</em> : null}
      </button>
      {children !== undefined ? children : (tab.messages || []).slice(2).map((m, i) => <Message key={i} m={m} />)}
    </>
  );
}

export function DuelTimelineMarker({ duel, onOpen }: { duel: EmbeddedDuel; onOpen: () => void }) {
  const winnerSide = duel.winnerSide || duel.choice;
  const loserSide = winnerSide === 'a' ? 'b' : 'a';
  const winner = duel[winnerSide];
  const loser = duel[loserSide];
  const prompt = String(duel.prompt || '').replace(/\s+/g, ' ').trim();
  const label = `Duel · ${modelLabel(winner?.model)} beat ${modelLabel(loser?.model)} · “${prompt}” · effort ${duel.effort}`;
  return (
    <button className="duel-marker" onClick={onOpen} aria-label={`${label}. Open decided Duel`}>
      <Icon name="columns" size={12} />
      <span className="duel-marker-result model-inline">Duel · <ModelMark id={winner?.model || ''} /><b>{modelLabel(winner?.model)}</b> beat <ModelMark id={loser?.model || ''} />{modelLabel(loser?.model)}</span>
      <span className="duel-marker-meta">· “{prompt}” · effort {duel.effort}</span>
      <i />
      <span className="duel-marker-open">open ↗</span>
    </button>
  );
}

export function DuelProgressMarker({ duelTab, onOpen }: { duelTab: Tab; onOpen: () => void }) {
  const s = useApp();
  const phase = duelPhase(duelTab) || 'setup';
  const warming = !!s.duelLocks[duelTab.id];
  const bothFailed = phase === 'results' && duelTab.duel?.a?.ok === false && duelTab.duel?.b?.ok === false;
  const status = warming
    ? 'warming up'
    : phase === 'setup'
      ? 'choosing effort'
      : phase === 'ready'
        ? 'ready for a task'
        : phase === 'running'
          ? 'contenders at work'
          : bothFailed
            ? 'both contenders failed — retry from the Duel'
            : 'waiting for your pick';
  const heading = bothFailed ? 'Duel needs a retry' : 'Duel in progress';
  return (
    <button className="duel-marker duel-progress-marker" onClick={onOpen} aria-label={`${heading}: ${status}. Open Duel`}>
      <Icon name="columns" size={12} />
      <u />
      <span className="duel-marker-result"><b>{heading}</b></span>
      <span className="duel-marker-meta">· {status}</span>
      <i />
      <span className="duel-marker-open">{bothFailed ? 'open ↗' : 'watch ↗'}</span>
    </button>
  );
}

export function DecidedDuelView({ tab, duel, idx }: { tab: Tab; duel: EmbeddedDuel; idx: number }) {
  const convRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (convRef.current) convRef.current.scrollTop = 0; }, [duel.duelId]);
  return (
    <div className="conv duel-decided" ref={convRef}>
      <button className="duel-return" onClick={() => closeDecidedDuel(idx)}><span>←</span> Back to {tab.name}</button>
      <PickedDuelHistory tab={tab} duel={duel} sourceName={tab.name}>{null}</PickedDuelHistory>
      <i className="conv-spacer" />
      <div className="duel-readonly">This duel is decided. Read-only.</div>
    </div>
  );
}

// Ported from vanilla duelView().
export function DuelView({ task, tab, idx }: { task: Task; tab: Tab; idx: number }) {
  useApp();
  const phase = duelPhase(tab);
  const runRef = tabRunRef(task, tab);
  const source = (task.tabs || []).find((candidate) => candidate.id === tab.duel?.sourceTabId);

  if (phase === 'picked') {
    return (
      <div className="conv">
        <PickedDuelHistory
          tab={tab}
          sourceName={source?.name}
          onReturn={source ? () => selectTab(idx, source.id) : undefined}
        />
        <i className="conv-spacer" />
        <Composer task={task} tab={tab} idx={idx} runRef={runRef} />
      </div>
    );
  }
  if (phase === 'results') {
    return (
      <div className="conv duel-conv">
        <div className="duel-stage"><DuelCard task={task} tab={tab} idx={idx} /></div>
        <div className="ubub">{(tab.duel || {}).prompt || ''}</div>
        <div className="duel-results">
          <DuelResultCard task={task} tab={tab} side="a" />
          <DuelResultCard task={task} tab={tab} side="b" />
        </div>
      </div>
    );
  }
  if (phase === 'running') {
    const prompt = (tab.duel || {}).prompt || '';
    const stopping = !!(runRef && state.stoppingRuns[runRef.key]);
    return (
      <div className="conv duel-conv">
        <div className="duel-stage">
          <DuelCard
            task={task}
            tab={tab}
            idx={idx}
            runningControl={runRef ? (
              <button
                className={`interrupt-hint ${stopping ? 'stopping' : ''}`}
                disabled={stopping}
                title={stopping ? 'Interrupting…' : 'Interrupt both contenders'}
                aria-keyshortcuts="Escape"
                onClick={() => stopTabRun(runRef.threadId, runRef.tabId)}
              >
                {stopping ? 'Interrupting…' : <><kbd>Esc</kbd><span>to interrupt</span></>}
              </button>
            ) : null}
          />
        </div>
        {prompt ? <div className="ubub">{prompt}</div> : null}
        <i className="conv-spacer" />
        <Composer task={task} tab={tab} idx={idx} disabled runRef={runRef} />
      </div>
    );
  }
  const ready = phase === 'ready';
  return (
    <div className="conv duel-conv">
      <div className="duel-stage"><DuelCard task={task} tab={tab} idx={idx} /></div>
      <i className="conv-spacer" />
      <Composer task={task} tab={tab} idx={idx} disabled={!ready} runRef={runRef} />
    </div>
  );
}
