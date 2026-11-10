import { state, set, type Anchor } from '../store';

// Popover open/close. Anchored to the button that opened it (its bounding rect),
// same as the vanilla data-pop handler.
export function openPop(el: HTMLElement, kind: string, pane?: number): void {
  const r = el.getBoundingClientRect();
  state.pop = { kind, pane, anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
  set();
}

// Swap the open popover for another kind at the same anchor (a menu handing
// off to a picker), without a fresh element to measure.
export function openPopAt(anchor: Anchor | undefined, kind: string, pane?: number): void {
  state.pop = { kind, pane, anchor };
  set();
}

export function closePop(): void {
  state.pop = null;
  set();
}

export function toggleRail(): void {
  state.railOpen = !state.railOpen;
  set();
}
