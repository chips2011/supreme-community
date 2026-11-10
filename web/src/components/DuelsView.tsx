import { useState } from 'react';
import { useApp, modelLabel } from '../store';
import { Icon } from '../icons';
import { WrittenText } from '../lib/writtenText';
import { openThread, selectTab } from '../actions';
import type { DuelHistoryEntry, DuelHistorySide } from '../types';
import { ModelMark } from './bits';

async function openDuelSource(duel: DuelHistoryEntry): Promise<void> {
  await openThread(duel.threadId);
  if (duel.tabId) selectTab(0, duel.tabId);
}

function whenLabel(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const today = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.round((current - day) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ModelPill({ model }: { model?: string | null }) {
  return <span className="duel-history-pill">{model ? <><ModelMark id={model} />{modelLabel(model)}</> : 'Contender'}</span>;
}

function OutputCard({ side, picked }: { side: DuelHistorySide; picked: boolean }) {
  return (
    <article className={`duel-history-output ${picked ? 'picked' : ''}`}>
      <header>
        <ModelPill model={side.model} />
        {picked ? <span className="duel-history-pick">Your pick</span> : null}
      </header>
      {side.text ? <WrittenText value={side.text} /> : <p>Output was not retained for this earlier Duel.</p>}
    </article>
  );
}

function ExpandedDuel({ duel }: { duel: DuelHistoryEntry }) {
  if (!duel.picked || !duel.a || !duel.b) {
    return (
      <div className="duel-history-expanded duel-history-awaiting">
        <b>Awaiting your pick</b>
        <span>Compare the blind contenders in the source workstream.</span>
        <button className="btn" onClick={() => void openDuelSource(duel)}>Open workstream ↗</button>
      </div>
    );
  }
  return (
    <div className="duel-history-expanded">
      <label>Your prompt</label>
      <div className="duel-history-prompt-full">{duel.prompt}</div>
      <div className="duel-history-outputs">
        <OutputCard side={duel.a} picked={duel.choice === 'a'} />
        <OutputCard side={duel.b} picked={duel.choice === 'b'} />
      </div>
      <button className="btn duel-history-open" onClick={() => void openDuelSource(duel)}>Open workstream ↗</button>
    </div>
  );
}

function DuelRow({ duel, open, onToggle }: { duel: DuelHistoryEntry; open: boolean; onToggle: () => void }) {
  const winner = duel.winner === 'neither' ? 'Neither' : duel.winner ? modelLabel(duel.winner) : 'Awaiting pick';
  return (
    <div className={`duel-history-entry ${open ? 'open' : ''}`}>
      <button className="duel-history-row" onClick={onToggle} aria-expanded={open}>
        <span className="duel-history-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
        <b title={duel.prompt}>{duel.prompt}</b>
        <span className="duel-history-source" title={duel.source}>{duel.source}</span>
        <span className="duel-history-matchup">
          <ModelPill model={duel.picked ? duel.a?.model : null} />
          <small>vs</small>
          <ModelPill model={duel.picked ? duel.b?.model : null} />
        </span>
        <span>{duel.effort}</span>
        <time dateTime={duel.at}>{whenLabel(duel.at)}</time>
        <span className={`duel-history-winner ${duel.picked ? '' : 'pending'}`}>
          {duel.winner && duel.winner !== 'neither' ? <ModelMark id={duel.winner} /> : null}{winner}
        </span>
      </button>
      {open ? <ExpandedDuel duel={duel} /> : null}
    </div>
  );
}

export function DuelsView() {
  const state = useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  const history = state.duelHistory;
  const duels = history?.duels || [];
  return (
    <div className="duels-page">
      <header className="duels-top">
        <Icon name="columns" size={15} />
        <b>Duels</b>
        <i />
        <span>{history ? `${history.count} duel${history.count === 1 ? '' : 's'}` : 'Loading…'}</span>
      </header>
      <main className="duels-body">
        {!history ? <div className="duels-empty">Loading Duel history…</div> : null}
        {history && !duels.length ? <div className="duels-empty"><b>No Duels yet</b><span>Start one from any tab to compare two models on the same brief.</span></div> : null}
        {duels.length ? (
          <section className="duel-history" aria-label="Duel history">
            <div className="duel-history-head" aria-hidden>
              <span /><span>Prompt</span><span>Source</span><span>Matchup</span><span>Effort</span><span>When</span><span>Winner</span>
            </div>
            {duels.map((duel) => (
              <DuelRow key={duel.id} duel={duel} open={openId === duel.id} onToggle={() => setOpenId(openId === duel.id ? null : duel.id)} />
            ))}
          </section>
        ) : null}
      </main>
    </div>
  );
}
