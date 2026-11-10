import type { ReactNode } from 'react';
import { useApp, state } from '../store';
import { Icon } from '../icons';
import { RECOMMENDED_MODEL } from '../constants';
import { toggleRail } from '../lib/ui';
import { CompanyLogo } from './CompanyLogo';

export function TopBar({ children }: { children?: ReactNode }) {
  const s = useApp();
  const tip = s.railOpen ? 'Close sidebar' : 'Open sidebar';
  return (
    <div className="top">
      <button className="tgl" onClick={() => toggleRail()}>
        <Icon name="panelLeft" size={16} />
        <span className="tip">{tip}</span>
      </button>
      {children}
    </div>
  );
}

export function ModelMark({ id }: { id: string }) {
  if (id === RECOMMENDED_MODEL.id) return <span className="model-spark"><Icon name="sparkles" size={12} /></span>;
  const provider = String(state.modelById[id]?.provider
    || (/^gpt-|codex/i.test(id) ? 'codex' : /^(?:opus|sonnet|haiku)|claude/i.test(id) ? 'claude' : /grok/i.test(id) ? 'grok' : ''));
  if (provider === 'claude' || provider === 'codex' || provider === 'grok') return <CompanyLogo company={provider} size={14} />;
  return <u />;
}
