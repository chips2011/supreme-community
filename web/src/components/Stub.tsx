import type { ReactNode } from 'react';
import { toggleRail } from '../lib/ui';
import { navigate } from '../actions';

export function NotBuilt({ what }: { what: string }) {
  return (
    <div className="empty" style={{ margin: '40px auto' }}>
      <div className="ttl" style={{ fontSize: 14 }}>Not built yet</div>
      <div className="sub" style={{ maxWidth: 460 }}>{what}</div>
    </div>
  );
}

// Ported from the vanilla stub(title, desc, body, dark).
export function Stub({ title, desc, dark, children }: { title: string; desc?: string; dark?: boolean; children?: ReactNode }) {
  return (
    <>
      {dark ? (
        <div className="top" style={{ background: 'var(--ink)' }}>
          <span style={{ font: '600 11px/1 var(--f)', color: '#fff' }}>{title}</span>
          <i />
          <button className="btn" onClick={() => navigate('home')}>Back to app</button>
        </div>
      ) : (
        <div className="top">
          <button className="tgl" onClick={() => toggleRail()}><u /></button>
          <span className="crumb">{title}</span>
          <i />
        </div>
      )}
      <div className="conv" style={{ gap: 16, maxWidth: 900 }}>
        {dark ? null : <div className="sub" style={{ maxWidth: 640 }}>{desc}</div>}
        {children}
      </div>
    </>
  );
}

export function RoutingView() {
  return (
    <Stub title="Routing" desc="Per-step model assignment with cost caps. Frontier stays unlocked for customer-facing work; cheaper tiers handle the rest." dark>
      <NotBuilt what="Per-step model assignment with cost caps needs plays with per-run costs and multi-seat usage first. Nothing to route or cost out yet, so this stays empty until real per-run costs are wired." />
    </Stub>
  );
}
