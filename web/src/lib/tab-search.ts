import type { Message } from '../types';

export function searchableText(value: string): string {
  return String(value || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();
}

export function tabSearchMatches(messages: Message[], query: string): number[] {
  const needle = String(query || '').replace(/\s+/g, ' ').trim().normalize('NFKC').toLocaleLowerCase();
  if (!needle) return [];
  const indices: number[] = [];
  messages.forEach((message, index) => {
    if (message.hiddenInTranscript || !message.content) return;
    const content = message.batch?.length ? message.batch.join('\n') : message.content;
    const raw = content.replace(/\s+/g, ' ').trim().normalize('NFKC').toLocaleLowerCase();
    if (raw.includes(needle) || searchableText(content).normalize('NFKC').toLocaleLowerCase().includes(needle)) indices.push(index);
  });
  return indices;
}

type Key = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'keyCode'>;
export function tabSearchShortcut(event: Key, { typing, blocked }: { typing: boolean; blocked: boolean }): boolean {
  return event.key === '/' && !typing && !blocked && !event.defaultPrevented && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}
