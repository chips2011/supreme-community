import { useApp } from '../store';
import { Icon } from '../icons';
import { mentionMatches } from '../lib/mention';
import { pickMention } from '../actions';
import type { Task } from '../types';

// Paper 21.1/21.2: one key, everything behind it. The @ dropdown narrows
// across types — destinations first (sibling tabs, then tabs in other
// workstreams), then people, then plays and context (ingredients); each row
// says what picking it does.
const TYPE_ICON = { tab: 'columns', person: 'user', play: 'zap', context: 'fileText' } as const;

export function MentionPicker({ task, tabId, idx }: { task: Task; tabId: string; idx: number }) {
  const s = useApp();
  const mention = s.contextMention[idx];
  if (!mention) return null;
  const items = mentionMatches(task, tabId, mention.query).slice(0, 8);
  const selected = Math.min(Math.max(0, mention.selected || 0), Math.max(0, items.length - 1));
  const label = mention.query ? `Matching “${mention.query}”` : 'Tabs, people, plays and context';
  return (
    <div className="mention-pop" role="listbox">
      <div className="mention-head">{label}<span>↑↓ choose · Enter insert</span></div>
      {items.length ? items.map((item, itemIdx) => (
        <button
          key={`${item.type}-${item.id}`}
          className={`mention-item ${itemIdx === selected ? 'sel' : ''}`}
          type="button"
          role="option"
          aria-selected={itemIdx === selected}
          data-mention-type={item.type}
          onClick={() => pickMention(idx, item, task, tabId)}
        >
          <span><Icon name={TYPE_ICON[item.type]} size={14} /></span>
          <div><b>{item.name}</b><p>{item.desc}</p></div>
          <small>{item.uses}</small>
        </button>
      )) : <div className="mention-empty">Nothing matches that search.</div>}
    </div>
  );
}
