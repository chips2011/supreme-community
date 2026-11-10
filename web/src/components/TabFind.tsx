import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { Icon } from '../icons';
import { state, set, useApp } from '../store';
import { cancelConversationLanding } from '../lib/dom';

type HighlightApi = { Highlight?: new (...ranges: Range[]) => unknown; CSS: typeof CSS & { highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void } } };

function rangesIn(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const text = nodes.map((node) => node.data).join('');
  const lower = text.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle || lower.length !== text.length) return [];
  const ranges: Range[] = [];
  let at = lower.indexOf(needle);
  while (at >= 0 && ranges.length < 200) {
    const end = at + needle.length;
    let offset = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    for (const node of nodes) {
      if (!startNode && at < offset + node.length) { startNode = node; startOffset = at - offset; }
      if (startNode && end <= offset + node.length) {
        const range = document.createRange();
        range.setStart(startNode, startOffset); range.setEnd(node, end - offset);
        ranges.push(range); break;
      }
      offset += node.length;
    }
    at = lower.indexOf(needle, end);
  }
  return ranges;
}

export function TabFind({ searchKey, hits, convRef }: { searchKey: string; hits: number[]; convRef: RefObject<HTMLDivElement | null> }) {
  const s = useApp();
  const find = s.view === 'tab' && s.tabSearch?.key === searchKey ? s.tabSearch : null;
  const input = useRef<HTMLInputElement>(null);
  const priorTop = useRef<number | null>(null);
  const open = !!find;
  const query = find?.query || '';
  const selected = hits.length ? Math.min(find?.selected || 0, hits.length - 1) : 0;
  const messageIndex = hits[selected];
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useLayoutEffect(() => {
    const conv = convRef.current;
    if (!conv) return;
    if (open && priorTop.current == null) priorTop.current = conv.scrollTop;
    if (!open && priorTop.current != null) {
      const top = priorTop.current; priorTop.current = null;
      cancelConversationLanding(conv);
      const frame = requestAnimationFrame(() => { conv.scrollTop = top; });
      return () => cancelAnimationFrame(frame);
    }
  }, [open, convRef]);
  useLayoutEffect(() => {
    if (!open || messageIndex == null || !query.trim()) return;
    const conv = convRef.current;
    if (!conv) return;
    cancelConversationLanding(conv);
    const roots = [...conv.querySelectorAll<HTMLElement>(`[data-chat-message-index="${messageIndex}"]`)];
    const target = roots.find((root) => root.textContent?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || roots[0];
    if (!target) return;
    const disclosures = [...target.querySelectorAll('details')].map((element) => ({ element, open: element.open }));
    disclosures.forEach(({ element }) => { element.open = true; });
    const api = window as unknown as HighlightApi;
    let frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const ranges = rangesIn(target, query);
      if (api.Highlight && api.CSS.highlights) api.CSS.highlights.set('supreme-chat-find', new api.Highlight(...ranges));
      // Lazy transcript rows can settle a frame after the first scroll.
      frame = requestAnimationFrame(() => { target.scrollIntoView({ block: 'center', behavior: 'instant' }); });
    });
    return () => {
      cancelAnimationFrame(frame); api.CSS.highlights?.delete('supreme-chat-find');
      disclosures.forEach(({ element, open: wasOpen }) => { if (element.isConnected) element.open = wasOpen; });
    };
  }, [open, messageIndex, query, convRef]);
  if (!find) return null;
  const move = (direction: number) => {
    if (!hits.length || !state.tabSearch || state.tabSearch.key !== searchKey) return;
    state.tabSearch = { ...state.tabSearch, selected: (selected + direction + hits.length) % hits.length }; set();
  };
  const close = () => {
    state.tabSearch = null; set();
    requestAnimationFrame(() => convRef.current?.focus({ preventScroll: true }));
  };
  return <div className="tab-find" role="search" aria-label="Find in this tab" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <Icon name="search" size={14} /><input ref={input} data-tab-find-input aria-label="Search this conversation" placeholder="Search this conversation" value={query} maxLength={200} onChange={(event) => { state.tabSearch = { key: searchKey, query: event.target.value, selected: 0 }; set(); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    <span className="tab-find-count" role="status" aria-live="polite">{query.trim() ? hits.length ? `${selected + 1} / ${hits.length} messages` : 'No matches' : ''}</span>
    <button type="button" aria-label="Previous match" title="Previous match, Shift Enter" disabled={!hits.length} onClick={() => move(-1)}><Icon name="chevronUp" size={13} /></button>
    <button type="button" aria-label="Next match" title="Next match, Enter" disabled={!hits.length} onClick={() => move(1)}><Icon name="chevronDown" size={13} /></button>
    <button type="button" aria-label="Close conversation search" title="Close search, Esc" onClick={close}><Icon name="x" size={13} /></button>
  </div>;
}
