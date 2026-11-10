import { useState } from 'react';
import { Icon } from '../icons';
import { OrchMark } from './OrchMark';
import { TabMessage } from './Message';
import { undoTraffic } from '../actions';
import type { Message as Msg, TrafficEvent } from '../types';

// Section 27, boards 27.2 and 27.6: in an orchestrator's transcript, the
// sends that left in one turn read as one row ("Sent to 6 tabs" and the
// names, opening to each message), and a write to the map reads as a row
// with the mark, what it did, and the undo.
export function SentGroup({ messages, fromIndex = 0, searchSelected = -1 }: { messages: Msg[]; fromIndex?: number; searchSelected?: number }) {
  const [open, setOpen] = useState(false);
  const expanded = open || searchSelected >= fromIndex && searchSelected < fromIndex + messages.length;
  const names = messages.map((message) => message.to?.name || 'a tab');
  return (
    <div className={`sent-group${expanded ? ' open' : ''}`} data-sent-group={messages.length}>
      <button type="button" className="sent-group-row" aria-expanded={expanded} onClick={() => setOpen((value) => !value)}>
        <span className="handoff-glyph" aria-hidden>{'↱'}</span>
        <b>Sent to {messages.length} tabs</b>
        <span className="sent-group-names">{names.join(', ')}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {expanded ? <div className="sent-group-body">{messages.map((message, index) => <TabMessage key={message.id || index} m={message} startOpen searchIndex={fromIndex + index} searchSelected={fromIndex + index === searchSelected} />)}</div> : null}
    </div>
  );
}

export function undoLabel(event: TrafficEvent): string {
  return event.action === 'remove' ? 'Put it back' : event.action === 'write' ? 'Undo' : 'Take it off';
}

export function WroteRow({ event, threadId }: { event: TrafficEvent; threadId: string }) {
  return (
    <div className={`wrote-row${event.undone ? ' undone' : ''}`} data-wrote-row={event.id}>
      <OrchMark size={13} />
      <span className="wrote-text">{event.text}</span>
      {event.undone
        ? <em className="wrote-undone">Taken back</em>
        : <button type="button" className="wrote-undo" data-wrote-undo onClick={() => void undoTraffic(threadId, event.id)}>{undoLabel(event)}</button>}
    </div>
  );
}
