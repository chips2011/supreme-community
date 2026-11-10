// Each conversation owns its own auto-follow state. Streaming content follows
// only while that pane is already at the bottom; scrolling up opts that pane out
// until the user returns to the bottom. This is especially important in split
// view, where activity in one tab must never move a neighboring conversation.
const FOLLOW_GAP = 24;
let positionRequest = 0;
const chosenPositions = new WeakMap<HTMLElement, number>();
const readingHistory = new WeakSet<HTMLElement>();

// An explicit History choice supersedes every earlier landing request,
// including its initial forced frame if the browser has not delivered it yet.
// A later tab navigation gets a newer request and can land normally again.
export function cancelConversationLanding(element: HTMLElement): void {
  chosenPositions.set(element, ++positionRequest);
  readingHistory.add(element);
  element.dataset.autoFollow = 'false';
  delete element.dataset.ownTop;
  delete element.dataset.landedTop;
  delete element.dataset.landingUntil;
}

function superseded(element: HTMLElement, request?: number): boolean {
  return request !== undefined && (chosenPositions.get(element) || 0) > request;
}

function conversations(key?: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.conv')]
    .filter((element) => !key || element.dataset.convKey === key);
}

function moveToBottom(key: string | undefined, force: boolean, request?: number): void {
  conversations(key).forEach((element) => {
    if (superseded(element, request)) return;
    // A late stream effect must not pull the reader out of a chosen History
    // turn either. A newer explicit navigation, or scrolling to the bottom,
    // releases that choice; ordinary live following is otherwise unchanged.
    if (readingHistory.has(element)) {
      if (request === undefined) return;
      readingHistory.delete(element);
    }
    if (!force && element.dataset.autoFollow === 'false') return;
    const before = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    element.dataset.autoFollow = 'true';
    // Where this move put it. Rows off screen are rendered lazily, so the
    // conversation can grow between this move and the scroll event it
    // raises; that event must not read as the reader scrolling up. A move
    // that changed nothing raises no event, so it leaves no mark: a tab
    // opened short used to mark 0, and once the thread had grown a reader
    // scrolling back to the top landed on that mark and was pulled down
    // again by the next poll.
    if (element.scrollTop !== before) element.dataset.ownTop = String(element.scrollTop);
    // Where the landing last put it (see trackConversationScroll).
    element.dataset.landedTop = String(element.scrollTop);
  });
}

export function trackConversationScroll(element: HTMLElement): void {
  // One move raises at most one scroll event, so its mark is spent on the
  // first event after it, whoever raised that event.
  const own = element.dataset.ownTop;
  delete element.dataset.ownTop;
  if (own !== undefined && Number(own) === element.scrollTop) { element.dataset.autoFollow = 'true'; return; }
  if (landing(element)) {
    element.dataset.landedTop = String(element.scrollTop);
    element.dataset.autoFollow = 'true';
    return;
  }
  const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (gap <= FOLLOW_GAP) readingHistory.delete(element);
  element.dataset.autoFollow = gap <= FOLLOW_GAP ? 'true' : 'false';
}

const SETTLE_AT = [80, 180, 320, 520, 800, 1200, 2000, 3000];
const LANDING_MS = SETTLE_AT[SETTLE_AT.length - 1] + 200;

function landing(element: HTMLElement): boolean {
  return Number(element.dataset.landingUntil || 0) > performance.now();
}

// The reader moved: the landing is over and the follow rules are theirs.
// Only what a person does counts (the wheel, a finger, a scrolling key, the
// scrollbar); a scroll event the browser raised on its own never does. Each
// of these arrives before the scroll event it causes.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);
const readerListening = new WeakSet<HTMLElement>();
let keysListening = false;
function listenForReader(element: HTMLElement): void {
  // (A stand-in element in a smoke has no listeners to add to.)
  if (readerListening.has(element) || typeof element.addEventListener !== 'function') return;
  readerListening.add(element);
  const moved = () => { delete element.dataset.landingUntil; };
  element.addEventListener('wheel', moved, { passive: true });
  element.addEventListener('touchmove', moved, { passive: true });
  element.addEventListener('pointerdown', moved, { passive: true });
  if (keysListening || typeof document.addEventListener !== 'function') return;
  keysListening = true;
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!SCROLL_KEYS.has(event.key) || target?.closest('input, textarea, select, [contenteditable]')) return;
    for (const conv of conversations()) delete conv.dataset.landingUntil;
  });
}

export function scrollConv(key?: string): void {
  const request = ++positionRequest;
  requestAnimationFrame(() => {
    // The landing lasts as long as the settle passes do.
    const until = String(performance.now() + LANDING_MS);
    conversations(key).forEach((element) => {
      if (superseded(element, request)) return;
      element.dataset.landingUntil = until;
      // The element is kept from tab to tab; what the last tab left in it
      // says nothing about this landing.
      delete element.dataset.ownTop;
      listenForReader(element);
    });
    moveToBottom(key, true, request);
    requestAnimationFrame(() => moveToBottom(key, false, request));
  });
  for (const delay of SETTLE_AT) setTimeout(() => moveToBottom(key, false, request), delay);
}

// Follow requests are coalesced into one pass per animation frame: a stream
// asks after every tick, and reading scrollHeight forces a layout each time
// it is asked, so five live panes were paying for hundreds of layouts a
// second. `undefined` (every conversation) absorbs the named ones.
const pendingFollow = new Map<string | undefined, boolean>();
let followFrame = 0;

function flushFollow(): void {
  followFrame = 0;
  const wanted = [...pendingFollow.entries()];
  pendingFollow.clear();
  const all = wanted.find(([key]) => key === undefined);
  if (all) {
    const force = all[1] || wanted.some(([, f]) => f);
    moveToBottom(undefined, force);
    return;
  }
  for (const [key, force] of wanted) moveToBottom(key, force);
}

function queueFollow(key: string | undefined, force: boolean): void {
  pendingFollow.set(key, (pendingFollow.get(key) || false) || force);
  if (!followFrame) followFrame = requestAnimationFrame(flushFollow);
}

// A live run follows every streamed tick so the active work never slips below
// the fold. Selecting another tab still restores its own saved conversation.
export function followConv(key?: string): void {
  queueFollow(key, true);
}

export function nudgeConv(key?: string): void {
  queueFollow(key, false);
}
