import { useSyncExternalStore } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { MODEL_DESC, PERFORMANCE_STOPS, type PerformanceStop } from './constants';
import type {
  Model, Connector, Stats, Performance, DuelHistory, Project, TaskSummary, Pane, Task, Tab,
  LayoutRecord, ToolEvent, ToolActivityKind, Recommendation, DiffState, RemoteSnapshot, ComputerActivity, ConnectorActivity, ModelHandoff, Status, ModelUsage, TerminalContext,
  ConfirmationRequest, ImageAttachment, PendingImageAttachment, ConnectorsOverview,
  SteeredPrompt, PlatformContextSummary, PlatformContextDetail,
  Play, PlayDraft, PlayFindJob, PlayRun, PlayMarker, InterimAnswer, PingResult, Schedule, ScheduledFire } from './types';

// A single mutable state object mirroring the vanilla `S`. Components read it via
// hooks; actions mutate it and call set()/setStream() to notify. This keeps the
// exact mental model of the original render()-rebuilds-everything design while
// letting React reconcile (which preserves focus/scroll/selection for free).

export type View = 'home' | 'tab' | 'landed' | 'slack' | 'map' | 'maps' | 'scheduled' | 'plays' | 'duels' | 'performance' | 'routing' | 'remote' | 'models' | 'context' | 'connectors' | 'onboarding';

// Paper 17: the one editor for plays. It sits to the right of a pane (Find a
// Play, or a run in progress) and to the right of the Plays list, keyed by
// pane index or 'page'.
export interface PlayPanelState {
  open: boolean;
  mode: 'find' | 'edit' | 'run';
  jobId: string | null;
  runId: string | null;
  playId: string | null;
  draft: PlayDraft | null;
  dirty: boolean;
  // A Find a Play result arrived while the panel was closed: the ⚡ goes green.
  landed: boolean;
  editing: boolean;
  busy: boolean;
  error: string | null;
}

// Composer drafts belong to the tab they were typed into, not to the pane
// slot showing it: a pane slot changes workstreams all the time (split, open
// another thread) and used to carry the draft across. Same key shape as the
// attachments and pending context, thread::tab.
export function paneTabKey(idx: number): string {
  const pane = state.panes[idx];
  if (!pane) return `pane:${idx}`;
  const task = state.cache[pane.threadId];
  const tabId = pane.tabId || task?.activeTab || '';
  return `${pane.threadId}::${tabId}`;
}

export function draftKey(idx: number | string): string {
  if (idx === 'home') return 'home';
  return paneTabKey(Number(idx));
}

export function defaultPlayPanel(): PlayPanelState {
  return { open: false, mode: 'edit', jobId: null, runId: null, playId: null, draft: null, dirty: false, landed: false, editing: false, busy: false, error: null };
}

export interface Anchor { left: number; right: number; top: number; bottom: number }
export interface Pop { kind: string; pane?: number; anchor?: Anchor }
export interface Renaming { kind: 'tab' | 'thread' | 'project'; id: string; threadId?: string; paneIdx?: number | null; required?: boolean }
export interface Drag { project?: string; thread?: string; tab?: string; context?: { sourceTaskId: string; sourceTabId: string } }
export interface Mention { start: number; end: number; query: string; selected: number }
export interface DuelLock { rampA: boolean; rampB: boolean }
export interface QueuedPrompt { id: string; prompt: string; model?: string; queuedAt: string; error?: string; terminalContexts?: TerminalContext[]; attachments?: PendingImageAttachment[]; mentions?: { email: string; name: string }[]; contextMentions?: string[] }
export interface DuelReview { paneIdx: number; threadId: string; sourceTabId: string; duelId: string }
export type OnboardingProvider = 'claude' | 'codex';
export type OnboardingStep = 'signin' | 'models' | 'linkedin' | 'greeting' | 'directions' | 'complete';
// What Supreme read at sign up (Paper section 14). Server-owned; the client
// only sends answers and the choice.
export interface OnboardingProfile {
  name: string; firstName: string; headline: string; role: string; company: string;
  location: string; photoUrl: string; url: string; summary: string; seniority: string;
}
export interface OnboardingArea { label: string; evidence: string; preselected: boolean }
export interface OnboardingDirection { title: string; detail: string; needs: string[]; prompt: string }
export interface OnboardingRead {
  status: 'reading' | 'ready' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  roleLine?: string;
  areas?: OnboardingArea[];
  voice?: { summary: string; sources: { prompts: number; sentEmails: number; transcripts: number } };
  directions?: OnboardingDirection[];
  thin?: boolean;
  gap?: string;
  evidence?: { claudeSessions: number; codexSessions: number; prompts: number; memoryFiles: number; skills: number; tools: number };
}
export interface OnboardingAnswers {
  role: '' | 'right' | 'not-quite';
  roleNote: string;
  areas: string[];
  somethingElse: string;
  voice: '' | 'me' | 'own';
  voiceNote: string;
}
export interface OnboardingState {
  complete: boolean;
  signedIn: boolean;
  step: OnboardingStep;
  email: string;
  webProviders: string[];
  selectedProvider: OnboardingProvider | '';
  verifiedProviders: OnboardingProvider[];
  chromeSkipped: boolean;
  chromeReady: boolean;
  chromeError: string;
  linkedinUrl: string;
  profile: OnboardingProfile | null;
  read: OnboardingRead | null;
  answers: OnboardingAnswers;
  direction: number | null;
  firstTaskId: string | null;
}

export function defaultOnboarding(): OnboardingState {
  return {
    complete: false, signedIn: false, step: 'signin', email: '', webProviders: [],
    selectedProvider: 'codex', verifiedProviders: [], chromeSkipped: false, chromeReady: false, chromeError: '',
    linkedinUrl: '', profile: null, read: null,
    answers: { role: '', roleNote: '', areas: [], somethingElse: '', voice: '', voiceNote: '' },
    direction: null, firstTaskId: null,
  };
}

export interface StreamState {
  // Paper 21.2b: the chips that rode this send, and how their pings went.
  mentions?: { email: string; name: string }[];
  contextRefs?: string[];
  pings?: PingResult[];
  threadId: string;
  tabId: string;
  prompt: string;
  prompts: string[];
  hiddenPrompt?: boolean;
  text: string;
  draftText: string;
  workNotes: string[];
  tools: (string | ToolEvent)[];
  effort?: string;
  statusText: string;
  runId: string | null;
  startedAt?: string;
  // The server's verdict when the turn saved (Paper 16.6): ok, interrupted,
  // or finished but asking the user for something.
  saved?: { ok: boolean; stopped: boolean; waiting: boolean };
  // Set while the finished turn is still on screen as the live block so the
  // run card can finish its lap and light green before the transcript takes
  // over. green is false when the turn ended waiting on the user.
  landed?: { at: number; green: boolean };
  // Set when a play typed this turn (Paper 17.5).
  play?: PlayMarker | null;
  model?: string | null;
  requestedModel?: string | null;
  recommendation?: Recommendation | null;
  handoff?: ModelHandoff | null;
  handedFrom?: { tabId: string; name: string; at?: string; threadId?: string; threadTitle?: string } | null;
  // Section 29: the scheduled task that sent this turn.
  scheduled?: ScheduledFire | null;
  terminalContexts?: TerminalContext[];
  attachments?: ImageAttachment[];
  steers?: SteeredPrompt[];
  // Answers to earlier messages in this turn, split off at each steer.
  interims?: InterimAnswer[];
  error?: string;
  computer?: ComputerActivity | null;
  connectors?: ConnectorActivity[];
}

export interface RemoteState {
  machine: RemoteSnapshot['machine'];
  mobileApp: RemoteSnapshot['mobileApp'] | null;
  activeCount: number;
  loading: boolean;
}

export interface ContextConciergeState {
  platforms: PlatformContextSummary[];
  selected: string | null;
  detail: PlatformContextDetail | null;
  draft: string;
  historyStaged: boolean;
  justSaved: boolean;
  showExamples: boolean;
  error: string | null;
  loading: boolean;
  stream: StreamState | null;
}

export interface State {
  view: View;
  railOpen: boolean;
  authConfigured: boolean;
  session: Session | null;
  user: User | null;
  authReady: boolean;
  authError: string | null;
  userName: string;
  models: Model[];
  modelById: Record<string, Model>;
  connectors: Connector[];
  connectorsLoaded: boolean;
  connectorsRefreshing: boolean;
  connectorsOverview: ConnectorsOverview | null;
  connectorsOverviewLoading: boolean;
  status: Status | null;
  modelUsage: ModelUsage | null;
  modelUsageLoading: boolean;
  modelUsageError: string | null;
  stats: Stats | null;
  performance: Performance | null;
  duelHistory: DuelHistory | null;
  performancePolicy: string;
  showArchived: boolean;
  projects: Project[];
  threads: TaskSummary[];
  panes: Pane[];
  activePane: number;
  // Section 30, Landed: the row on screen (`threadId:tabId`) and when its
  // landing was, so the page can step on from a row that has since left.
  landedCurrent: string | null;
  landedCurrentAt: number;
  landedSearchOpen: boolean;
  slackInboxFilter: 'active' | 'history';
  slackInboxQuery: string;
  slackInboxOffset: number;
  slackReturnThread: string | null;
  slackInboxCounts: { active: number; history: number } | null;
  tabSearch: { key: string; query: string; selected: number } | null;
  workspaceSearchOpen: boolean;
  threadLayouts: Record<string, LayoutRecord>;
  layoutRoot: string | null;
  // Connected tabs: the workstream whose map is on screen, and the card a
  // tab was opened from (board 2's "Opened from" hairline), cleared the
  // moment you move on.
  mapRoot: string | null;
  // Section 29: the scheduled tasks on this Mac, and the one whose page is
  // open (null is the index).
  schedules: Schedule[];
  scheduledOpen: string | null;
  openedFrom: { threadId: string; tabId: string; mapThreadId: string; title: string } | null;
  cache: Record<string, Task>;
  drafts: Record<string, string>;
  effort: string;
  homeModel: string;
  homeProject: string | null;
  pop: Pop | null;
  projectCreateOpen: boolean;
  renaming: Renaming | null;
  // Same team: the share dialog for one project (its path).
  shareDialog: { path: string } | null;
  drag: Drag | null;
  duel: { paneIdx: number; threadId: string; tabId: string } | null;
  duelReview: DuelReview | null;
  duelLocks: Record<string, DuelLock>;
  duelEffort: Record<string, number>;
  duelAltOpen: Record<string, boolean>;
  contextOpen: Record<string, boolean>;
  // Tab ids collapsed into a pane's "+N" (Paper 13.3, option A); written by TabsRow.
  tabOverflow: Record<string, string[]>;
  // Paper 17: plays, the panels editing or running them, and the /plays picker.
  plays: Play[];
  playsLoaded: boolean;
  playPanels: Record<string, PlayPanelState>;
  playFindJobs: Record<string, PlayFindJob>;
  playRuns: Record<string, PlayRun>;
  playPick: Record<string, { selected: number }>;
  // Paper 16: the three motion layers. They are always on in the product;
  // the hidden ?motiondemo=1 harness can isolate a layer during design QA.
  motion: { road: boolean; ground: boolean; edges: boolean };
  // Paper 21.3: the destination chip — this composer's message is handed to a
  // sibling tab on send. Keyed like pending images (thread::tab).
  pendingHandoff: Record<string, { tabId: string; name: string; threadId?: string }>;
  contextQuery: Record<string, string>;
  contextMention: Record<string, Mention | undefined>;
  // Paper 21.2b: a person picked from the @ menu is a chip, not text — a
  // Slack ping riding the send. Keyed thread::tab like pending images.
  pendingPings: Record<string, { email: string; name: string }[] | undefined>;
  // Paper 21.2b: a picked context block is a chip too; the send carries the
  // block names and the server injects them exactly as typed @[Name] tokens.
  pendingContextRefs: Record<string, string[] | undefined>;
  // Whether this Mac has a Slack bot token saved — the @ menu's people rows
  // promise a ping, and must stop promising when Slack is not connected.
  // null until boot learns the answer.
  slackReady: boolean | null;
  // Paper 20.6: an archived tab being peeked at, keyed by thread id. It sits
  // in the strip dashed, read-only, and leaves when you switch away.
  peeks: Record<string, string | undefined>;
  contextConcierge: ContextConciergeState;
  remote: RemoteState;
  diff: DiffState | null;
  streams: Record<string, StreamState>;
  stoppingRuns: Record<string, boolean>;
  queuedPrompts: Record<string, QueuedPrompt[]>;
  pendingTerminalContexts: Record<string, TerminalContext[]>;
  pendingImages: Record<string, PendingImageAttachment[]>;
  cloudHandoffBusy: Record<string, boolean>;
  onboarding: OnboardingState;
  installingProviders: Record<string, boolean>;
  connectingProviders: Record<string, boolean>;
  onboardingCheckingProvider: OnboardingProvider | null;
  onboardingChromeChecking: boolean;
  onboardingStarting: boolean;
  onboardingLinkedInBusy: boolean;
  busy: boolean;
  toast: string | null;
  // manual double-click detection for tab rename
  lastTab: { k: string; t: number } | null;
}

export const state: State = {
  view: 'home',
  railOpen: true,
  authConfigured: false,
  session: null,
  user: null,
  authReady: false,
  authError: null,
  userName: '',
  models: [],
  modelById: {},
  connectors: [],
  connectorsLoaded: false,
  connectorsRefreshing: false,
  connectorsOverview: null,
  connectorsOverviewLoading: false,
  status: null,
  modelUsage: null,
  modelUsageLoading: false,
  modelUsageError: null,
  stats: null,
  performance: null,
  duelHistory: null,
  performancePolicy: 'balanced',
  showArchived: false,
  projects: [],
  threads: [],
  panes: [],
  activePane: 0,
  landedCurrent: null,
  landedCurrentAt: 0,
  landedSearchOpen: false,
  slackInboxFilter: 'active',
  slackInboxQuery: '',
  slackInboxOffset: 0,
  slackReturnThread: null,
  slackInboxCounts: null,
  tabSearch: null,
  workspaceSearchOpen: false,
  threadLayouts: {},
  layoutRoot: null,
  mapRoot: null,
  schedules: [],
  scheduledOpen: null,
  openedFrom: null,
  cache: {},
  drafts: {},
  // New accounts start at Maximum for every model they connect: the first
  // computer-use turn failed at Medium and worked at Maximum on the first
  // outside user test, and a slow success beats a fast miss. A saved choice
  // (localStorage prefs or the server's defaultEffort) still wins.
  effort: 'Maximum',
  homeModel: 'sonnet',
  homeProject: null,
  pop: null,
  projectCreateOpen: false,
  renaming: null,
  shareDialog: null,
  drag: null,
  duel: null,
  duelReview: null,
  duelLocks: {},
  duelEffort: {},
  duelAltOpen: {},
  contextOpen: {},
  tabOverflow: {},
  plays: [],
  playsLoaded: false,
  playPanels: {},
  playFindJobs: {},
  playRuns: {},
  playPick: {},
  motion: { road: true, ground: true, edges: true },
  pendingHandoff: {},
  contextQuery: {},
  contextMention: {},
  pendingPings: {},
  pendingContextRefs: {},
  slackReady: null,
  peeks: {},
  contextConcierge: {
    platforms: [], selected: null, detail: null, draft: '', historyStaged: false,
    justSaved: false, showExamples: false, error: null, loading: false, stream: null,
  },
  remote: {
    machine: null, mobileApp: null, activeCount: 0, loading: false,
  },
  diff: null,
  streams: {},
  stoppingRuns: {},
  queuedPrompts: {},
  pendingTerminalContexts: {},
  pendingImages: {},
  cloudHandoffBusy: {},
  onboarding: defaultOnboarding(),
  installingProviders: {},
  connectingProviders: {},
  onboardingCheckingProvider: null,
  onboardingChromeChecking: false,
  onboardingStarting: false,
  onboardingLinkedInBusy: false,
  busy: false,
  toast: null,
  lastTab: null,
};

let structuralV = 0;
let streamV = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// A full change: bumps both counters so every subscriber re-renders. This is the
// analogue of the vanilla render() call. Stream changes still waiting for
// their frame go out with it, so nothing is ever seen out of order.
export function set(mut?: (s: State) => void): void {
  if (mut) mut(state);
  structuralV += 1;
  streamV += 1;
  applyPendingStream();
  notify();
}

const streamVersions = new Map<string, number>();
const pendingStreamKeys = new Set<string>();
let pendingStreamAll = false;
let streamFlush: { kind: 'frame' | 'timer'; id: number } | null = null;
let lastStreamFlushAt = 0;
// Live text is painted at most this often. Every paint of a long transcript
// costs a style pass and a layout of everything on screen, so twenty a second
// reads as continuous while leaving the thread free for clicks.
const STREAM_FRAME_MS = 48;

function applyPendingStream(): void {
  if (streamFlush) {
    if (streamFlush.kind === 'frame') cancelAnimationFrame(streamFlush.id); else clearTimeout(streamFlush.id);
    streamFlush = null;
  }
  if (pendingStreamAll) streamV += 1;
  for (const key of pendingStreamKeys) streamVersions.set(key, (streamVersions.get(key) || 0) + 1);
  pendingStreamKeys.clear();
  pendingStreamAll = false;
}

function flushStream(): void {
  streamFlush = null;
  lastStreamFlushAt = Date.now();
  applyPendingStream();
  notify();
}

export function setStream(mut?: (s: State) => void, key?: string): void {
  if (mut) mut(state);
  if (key) pendingStreamKeys.add(key); else pendingStreamAll = true;
  if (streamFlush) return;
  // A hidden window gets no animation frames; a timer keeps its state moving
  // so the transcript is current the moment it is looked at again.
  const wait = Math.max(0, STREAM_FRAME_MS - (Date.now() - lastStreamFlushAt));
  if (typeof requestAnimationFrame !== 'function' || document.hidden) streamFlush = { kind: 'timer', id: window.setTimeout(flushStream, Math.max(wait, 80)) };
  else if (wait > 0) streamFlush = { kind: 'timer', id: window.setTimeout(() => { streamFlush = { kind: 'frame', id: requestAnimationFrame(flushStream) }; }, wait) };
  else streamFlush = { kind: 'frame', id: requestAnimationFrame(flushStream) };
}

export function getState(): State {
  return state;
}

// Subscribes to structural changes. Returns the (mutable) state object; the
// component re-renders whenever set() is called.
export function useApp(): State {
  useSyncExternalStore(subscribe, () => structuralV);
  return state;
}

// Subscribes to streaming changes only (plus structural, since set() bumps
// both). With a key, only that stream's changes count: a token landing in one
// pane leaves the other panes' live blocks alone.
export function useStream(key?: string): State {
  useSyncExternalStore(subscribe, () => (key ? `${streamV}:${streamVersions.get(key) || 0}` : String(streamV)));
  return state;
}

// ---------------------------------------------------------------------------
// derived helpers (pure over current state)

export function peekingTab(task: Task, tabId: string | null | undefined): boolean {
  return !!tabId && state.peeks[task.id] === tabId && !(task.tabs || []).some((tab) => tab.id === tabId);
}

export function emptyTab(tab: Tab | null | undefined): boolean {
  if (!tab) return false;
  if ((tab.messages || []).length || tab.activeRun || (tab.queue || []).length) return false;
  if (tab.type === 'duel' || tab.duel || (tab.duels || []).length || tab.done) return false;
  return true;
}

export function modelLabel(id: string | undefined | null): string {
  if (id === 'recommended') return 'Recommended';
  return (id && state.modelById[id] && state.modelById[id].label) || id || '—';
}

export function modelDesc(id: string | undefined | null): string {
  if (id === 'recommended') return 'Best-value pick per step';
  return MODEL_DESC[id as string] || (id && state.modelById[id] ? state.modelById[id].family : '');
}

export function performanceStop(id: string = state.performancePolicy): PerformanceStop {
  return PERFORMANCE_STOPS.find((stop) => stop.id === id) || PERFORMANCE_STOPS[2];
}

// Graceful degradation: a model is selectable when its provider is connected in
// this install. Defaults to available when status is unknown (e.g. an older
// running server without /api/status), so nothing is falsely greyed out.
export function modelReady(id: string | undefined | null): boolean {
  if (!state.status || !id) return true;
  if (id === 'recommended') return (state.status.connectedProviders || []).length > 0;
  const m = state.modelById[id];
  if (!m) return true;
  const p = state.status.providers[m.provider];
  return p ? p.ready : true;
}

export function providerHint(id: string | undefined | null): string {
  if (!state.status || !id) return '';
  const m = id === 'recommended' ? null : state.modelById[id];
  const p = m && state.status.providers[m.provider];
  return p && !p.ready ? p.hint : '';
}

export function threadsForRepo(repoPath: string): TaskSummary[] {
  const projectId = state.projects.find((project) => project.path === repoPath)?.id;
  return state.threads.filter((thread) => {
    if (thread.archived) return false;
    if (thread.done) return false;
    if (projectId && thread.projectId) return thread.projectId === projectId;
    return thread.repo === repoPath;
  });
}

export function activeTabOf(task: Task) {
  return (task.tabs || []).find((tb) => tb.id === task.activeTab) || (task.tabs || [])[0] || null;
}

export function pendingConfirmation(tab: Tab | null | undefined): ConfirmationRequest | null {
  if (!tab || tab.activeRun) return null;
  if (Object.values(state.streams).some((stream) => stream.tabId === tab.id)) return null;
  const visible = (tab.messages || []).filter((message) => !message.hiddenInTranscript && !message.note);
  const last = visible[visible.length - 1];
  if (!last || last.role !== 'assistant' || last.ok === false || last.stopped) return null;
  return last.confirmation || null;
}

// A confirmation from a turn a teammate ran is theirs to answer (their Mac,
// their connectors): shown as waiting on them, never a reply badge here.
export function confirmationWaitingOn(tab: Tab | null | undefined): string | null {
  const visible = (tab?.messages || []).filter((message) => !message.hiddenInTranscript);
  const ranBy = visible[visible.length - 1]?.ranBy;
  const my = meId();
  return ranBy?.id && my && ranBy.id !== my ? ranBy.name : null;
}

export function taskConfirmationCount(task: Task | null | undefined): number {
  return (task?.tabs || []).reduce(
    (count, tab) => count + (pendingConfirmation(tab) && !confirmationWaitingOn(tab) ? 1 : 0),
    0,
  );
}

export function projectLabel(repoPath: string, fallback?: string): string {
  return (state.projects.find((p) => p.path === repoPath) || {}).name || fallback || 'Project';
}

const TOOL_ACTIVITY_KINDS = new Set<ToolActivityKind>(['computer', 'connector', 'research', 'context', 'work', 'tool']);

export function toolKind(tool: ToolEvent | string): ToolActivityKind {
  if (typeof tool !== 'string' && tool.kind && TOOL_ACTIVITY_KINDS.has(tool.kind)) return tool.kind;
  const name = String(typeof tool === 'string' ? tool : tool.name || '').toLowerCase();
  // Modality wins over destination. For example, "Notion browser" is
  // computer control, not a Notion connector call.
  if (/browser|chrome|computer|playwright/.test(name)) return 'computer';
  if (/linkedin|gmail|email|notion|calendar|connector/.test(name)) return 'connector';
  if (/websearch|webfetch|research|search/.test(name)) return 'research';
  if (/read|glob|grep|shell|bash|exec|terminal|command|context/.test(name)) return 'context';
  if (/write|edit|patch|preparing work|file changes/.test(name)) return 'work';
  return 'tool';
}

export function toolLabel(tool: ToolEvent | string): string {
  const supplied = String(typeof tool === 'string' ? tool : tool.name || '').trim();
  const name = supplied.toLowerCase();
  const kind = toolKind(tool);
  if (typeof tool !== 'string' && tool.kind && supplied) return supplied;
  if (kind === 'computer') return 'Computer control';
  if (kind === 'connector') {
    if (/linkedin/.test(name)) return 'LinkedIn via Chrome';
    if (/gmail|email/.test(name)) return 'Email connector';
    if (/notion/.test(name)) return 'Notion connector';
    if (/calendar/.test(name)) return 'Calendar connector';
    return 'Connected tool';
  }
  if (kind === 'research') return 'Web research';
  if (kind === 'context') return 'Local context';
  if (kind === 'work') return 'File changes';
  return supplied && !/^using a connected tool$/i.test(supplied) ? supplied : 'Connected tool';
}

export function userStatusText(value: unknown): string {
  if (/^stopping/i.test(String(value || ''))) return 'Interrupting…';
  if (/^stopped/i.test(String(value || ''))) return 'Interrupted';
  return value ? 'Working through the task…' : '';
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string): void {
  set((s) => { s.toast = msg; });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast === msg) set((s) => { s.toast = null; });
  }, 3200);
}

// Same team: who I am, as the service sees it (works with or without a
// Supabase session, the smoke's hub included).
export function meId(): string | null {
  return state.status?.team?.user?.id || state.user?.id || null;
}
