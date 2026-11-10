import { useApp, state, set, modelLabel, performanceStop } from '../store';
import { PERFORMANCE_STOPS } from '../constants';
import { Icon } from '../icons';
import { ModelMark, TopBar } from './bits';
import { saveDefault } from '../actions';
import type { Performance, PerformanceRow } from '../types';

function performancePeriod(period?: Performance['period']): string {
  const from = new Date(period?.from || Date.now());
  const to = new Date(period?.to || Date.now());
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return '';
  const month = new Intl.DateTimeFormat('en-US', { month: 'short' }).format(from);
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  return `${month} ${from.getDate()}–${sameMonth ? '' : new Intl.DateTimeFormat('en-US', { month: 'short' }).format(to) + ' '}${to.getDate()}`;
}

function performanceSpend(row?: PerformanceRow): string {
  if (!row) return '$0.00';
  const metered = Number(row.spendUsd || 0);
  if (row.meteredSteps && row.unmeteredSteps) return `$${metered.toFixed(2)} + included`;
  if (row.meteredSteps) return `$${metered.toFixed(2)}`;
  return row.unmeteredSteps ? 'Included' : '$0.00';
}

function performanceInsight(data: Performance | null): string {
  if (!data || !data.steps) return 'Your model mix will appear after the first completed run.';
  const haiku = (data.rows || []).find((row) => row.model === 'haiku');
  if (haiku) {
    const stepShare = Math.round((haiku.steps / data.steps) * 100);
    const spendShare = (data.meteredSpendUsd || 0) > 0 ? Math.round((Number(haiku.spendUsd || 0) / (data.meteredSpendUsd || 1)) * 100) : 0;
    return spendShare
      ? `Haiku 4.5 did ${stepShare}% of the steps for ${spendShare}% of metered spend.`
      : `Haiku 4.5 handled ${stepShare}% of the steps through your included plan.`;
  }
  if (data.routedSteps) return `Recommended routed ${data.routedSteps} of ${data.steps} steps this month.`;
  return `${data.steps} completed step${data.steps === 1 ? '' : 's'} this month. Choose Recommended to start optimizing the mix.`;
}

export function PerformanceView() {
  const s = useApp();
  const data = s.performance;
  const stop = performanceStop();
  const period = performancePeriod(data?.period);

  let distribution;
  if (!data) {
    distribution = <div className="performance-loading"><span className="spin" /> Loading real usage…</div>;
  } else {
    const rows = data.rows || [];
    const totalWeight = rows.reduce((sum, row) => sum + ((data.meteredSpendUsd || 0) > 0 ? Number(row.spendUsd || 0) : row.steps), 0) || 1;
    const included = data.unmeteredSteps ? ` · ${data.unmeteredSteps} included` : '';
    distribution = (
      <>
        <div className="performance-distribution-head">
          <div><h1>Where it went</h1><p>{period} · {data.steps} steps · ${Number(data.meteredSpendUsd || 0).toFixed(2)}{included}</p></div>
        </div>
        {rows.length ? (
          <div className="performance-bar" aria-label="Model usage mix">
            {rows.map((row, index) => {
              const weight = (data.meteredSpendUsd || 0) > 0 ? Number(row.spendUsd || 0) : row.steps;
              return <span key={index} className={`shade-${Math.min(index, 5)}`} style={{ width: `${Math.max(1.5, (weight / totalWeight) * 100).toFixed(2)}%` }} title={modelLabel(row.model)} />;
            })}
          </div>
        ) : <div className="performance-bar empty-bar" />}
        <div className="performance-table">
          <div className="performance-tr performance-th"><span>Model</span><span>Used for</span><strong>Steps</strong><strong>Spend</strong></div>
          {rows.length ? rows.map((row, index) => (
            <div key={index} className="performance-tr">
              <span className="performance-model"><ModelMark id={row.model} /><b>{modelLabel(row.model)}</b></span>
              <span>{row.usedFor}</span>
              <strong>{row.steps}</strong>
              <strong>{performanceSpend(row)}</strong>
            </div>
          )) : <div className="performance-empty">No completed runs in this period yet.</div>}
        </div>
        <div className="performance-insight"><Icon name="sparkles" size={14} /><span>{performanceInsight(data)}</span></div>
        {data.unmeteredSteps ? <p className="performance-footnote">Included means the provider returned no per-run dollar receipt, usually because the run used your Claude or Codex subscription.</p> : null}
      </>
    );
  }

  return (
    <>
      <TopBar>
        <span className="crumb">Performance</span><i />
        <button className="performance-range" title="Current month">{period || 'This month'} <Icon name="chevronDown" size={11} /></button>
      </TopBar>
      <div className="performance-shell">
        <section className="performance-policy">
          <h1>Your tradeoff</h1>
          <p>One setting. Recommended routes every step under it.</p>
          <div className="performance-stops">
            {PERFORMANCE_STOPS.map((item) => (
              <button
                key={item.id}
                className={`performance-stop ${item.id === stop.id ? 'selected' : ''}`}
                onClick={() => { state.performancePolicy = item.id; saveDefault({ performancePolicy: item.id }); set(); }}
              >
                <span className="performance-radio"><i /></span>
                <span><b>{item.label}</b><small>{item.desc}</small></span>
              </button>
            ))}
          </div>
          <div className="performance-at"><small>At this stop</small><b>{stop.outcome}</b><strong>≈ ${stop.monthly} /mo at your pace</strong></div>
          <p className="performance-note">Applies to new runs. A model pinned in a tab always wins.</p>
        </section>
        <section className="performance-distribution">{distribution}</section>
      </div>
    </>
  );
}
