type KeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented' | 'keyCode'>;
type KeyScope = { typing: boolean; blocked: boolean; searchOpen: boolean };
export type LandedShortcut = 'search' | 'previous' | 'next' | 'complete' | 'exit' | 'up' | 'down' | 'blur' | null;

// Single-letter commands belong to the reader, never an editor, picker or
// confirmation. Held E completes one result, not the whole waiting pile.
export function landedShortcut(event: KeyEvent, scope: KeyScope): LandedShortcut {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || scope.blocked || scope.searchOpen) return null;
  if (event.key === 'Escape' && scope.typing && !event.metaKey && !event.ctrlKey && !event.altKey) return 'blur';
  if (scope.typing) return null;
  if (event.key === 'Enter' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return event.repeat ? null : 'complete';
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case '/': return event.repeat ? null : 'search';
    case 'k': case 'ArrowLeft': return 'previous';
    case 'j': case 'ArrowRight': return 'next';
    case 'e': return event.repeat ? null : 'complete';
    case 'Escape': return event.repeat ? null : 'exit';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    default: return null;
  }
}
