import { Icon } from '../icons';
import type { ImageAttachment, TerminalContext as TerminalContextT } from '../types';
import type { ReactNode } from 'react';
import { ImageAttachments } from './ImageAttachments';

export function TerminalContextChips({
  contexts,
  onRemove,
  compact = false,
}: {
  contexts?: TerminalContextT[];
  onRemove?: (context: TerminalContextT) => void;
  compact?: boolean;
}) {
  if (!contexts?.length) return null;
  return (
    <div className={`terminal-context-chips ph-no-capture ${compact ? 'compact' : ''}`}>
      {contexts.map((context) => (
        <span className="terminal-context-chip" key={`${context.sourceTaskId}:${context.sourceTabId}`} title={`${context.sourceProject || 'Project'} › ${context.sourceThread || 'Workstream'} › ${context.sourceTab}`}>
          <Icon name="fileText" size={11} />
          <b>Context</b><s>· {context.sourceTab}</s>
          {onRemove ? (
            <button type="button" aria-label={`Remove context from ${context.sourceTab}`} onClick={() => onRemove(context)}>
              <Icon name="x" size={10} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function ContextualUserTurn({ contexts, attachments, briefing, children, searchIndex, searchSelected = false }: { contexts?: TerminalContextT[]; attachments?: ImageAttachment[]; briefing?: { count: number }; children: ReactNode; searchIndex?: number; searchSelected?: boolean }) {
  return (
    <div className={`contextual-user-turn${searchSelected ? ' chat-find-active' : ''}`} data-chat-message-index={searchIndex}>
      {briefing?.count ? (
        <div className="terminal-context-chips compact">
          <span className="terminal-context-chip" title="This turn included a short briefing of what the other tabs in this workstream are doing.">
            <Icon name="message" size={11} />
            <b>Briefed</b><s>· {briefing.count} sibling {briefing.count === 1 ? 'tab' : 'tabs'}</s>
          </span>
        </div>
      ) : null}
      <TerminalContextChips contexts={contexts} compact />
      <ImageAttachments attachments={attachments} />
      {children === '' || children == null ? null : <div className="ubub">{children}</div>}
    </div>
  );
}
