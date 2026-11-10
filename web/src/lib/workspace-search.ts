export type WorkspaceSearchResult = { id: string; taskId: string; tabId: string | null; title: string; project: string; tab: string; archived: boolean; tabArchived: boolean; matches: number; snippet: string; messageQuery: string };
export type WorkspaceSearchPage = { results: WorkspaceSearchResult[]; total: number; nextOffset: number | null };
type Key = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'keyCode'>;
export function workspaceSearchShortcut(event: Key, blocked: boolean): boolean {
  return event.key.toLocaleLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented && !blocked;
}
