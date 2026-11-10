import { state, set } from '../store';
import { Icon } from '../icons';
import { contextDragStart, dragEnd } from '../lib/dnd';

export function ContextHandle({ taskId, tabId, paneIdx, on }: { taskId: string; tabId: string; paneIdx: number; on: boolean }) {
  return (
    <button
      className={`context-toggle context-handle ${on ? 'on' : ''}`}
      title="Open blocks · or drag anywhere onto another tab"
      aria-label="Open context"
      draggable
      onDragStart={(event) => contextDragStart(event, taskId, tabId)}
      onDragEnd={dragEnd}
      onClick={() => { state.contextOpen[paneIdx] = !state.contextOpen[paneIdx]; set(); }}
    >
      <span className="context-grip" aria-hidden><Icon name="gripVertical" size={11} /></span>
      <Icon name="fileText" size={12} /><span>Context</span>
    </button>
  );
}
