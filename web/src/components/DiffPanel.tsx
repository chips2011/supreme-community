import type { ReactNode } from 'react';
import { useApp, state, set } from '../store';

function colorizeDiff(patch: string): ReactNode[] {
  return patch.split('\n').map((l, i) => {
    let cls = '';
    if (l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ')) cls = 'fh';
    else if (l.startsWith('@@')) cls = 'hh';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    return <span key={i} className={cls}>{l || ' '}{'\n'}</span>;
  });
}

// Ported from vanilla diffPanel().
export function DiffPanel() {
  const s = useApp();
  const d = s.diff;
  if (!d) return null;
  let inner: ReactNode;
  if (d.loading) inner = <div className="sub" style={{ padding: 14 }}><span className="spin" /> loading diff…</div>;
  else if (d.error) inner = <div className="err" style={{ padding: 14 }}>{d.error}</div>;
  else if (!d.patch) inner = <div className="sub" style={{ padding: 14 }}>No changes in this worktree yet.</div>;
  else inner = <div className="diff">{colorizeDiff(d.patch)}</div>;
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: 12, background: 'var(--n100)' }}>
      <div className="diffwrap">
        <div className="dh">
          <span style={{ flex: 1 }}>Diff{d.dirty ? ' · uncommitted' : ''}</span>
          <button className="xs" onClick={() => { state.diff = null; set(); }}>✕</button>
        </div>
        {inner}
      </div>
    </div>
  );
}
