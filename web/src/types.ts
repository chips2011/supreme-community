// Types derived from the backend contract (server.mjs + lib/store.mjs). The
// frontend must not change the backend, so these mirror exactly what the server
// sends and accepts. See the plan file for the full contract map.

export type Provider = 'claude' | 'codex' | 'openrouter';

export interface Model {
  id: string;
  label: string;
  provider: Provider;
  cli: string;
  family: string;
  // An older generation: off the picker, still runs for a tab set to it.
  retired?: boolean;
}

export interface Recommendation {
  policy?: string | null;
  category?: string | null;
  usedFor?: string | null;
}

export interface ComputerStep {
  at?: string;
  step: string;
  phase?: 'step' | 'paused' | 'resumed' | 'released' | 'blocked' | 'recovering' | 'connected';
}

export interface ComputerActivity {
  runId: string;
  state: 'active' | 'paused' | 'released' | 'done' | 'stopped' | 'error';
  connection?: 'unavailable' | 'recovering' | 'connected';
  surface: 'Chrome' | 'browser';
  app: string;
  startedAt?: string;
  updatedAt?: string;
  currentStep: string;
  steps: ComputerStep[];
  hasPreview?: boolean;
  previewSeq?: number | null;
}

export type ConnectorAction = 'listen' | 'read' | 'search' | 'create' | 'update' | 'draft' | 'send' | 'schedule' | 'connect' | 'publish' | 'upload' | 'delete' | 'use';

export interface ConnectorActivity {
  id: string;
  connector: string;
  action: ConnectorAction;
  state: 'active' | 'done' | 'error' | 'stopped';
  detail?: string;
  account?: string;
  outcome?: string;
  count?: number | null;
  unit?: string;
  url?: string;
  startedAt?: string;
  updatedAt?: string;
}

export type OutsideTouchAction = Exclude<ConnectorAction, 'listen' | 'read' | 'search' | 'use'>;

export interface OutsideTouch {
  id: string;
  platform: string;
  action: OutsideTouchAction;
  state: 'done' | 'error' | 'stopped';
  count?: number | null;
  unit?: string;
  account?: string;
  detail?: string;
  outcome?: string;
  url?: string;
}

export interface TerminalContext {
  id?: string;
  sourceTaskId: string;
  sourceTabId: string;
  sourceProject?: string;
  sourceThread?: string;
  sourceTab: string;
  guidance?: string;
  messageCount?: number;
  charCount?: number;
  tokenEstimate?: number;
  capturedAt?: string;
  fileName?: string;
}

export interface ConfirmationRequest {
  question: string;
  confirmLabel: string;
  confirmResponse: string;
  declineLabel: string;
  declineResponse: string;
  // Section 32, board 32.3a: the yes hands a forwarded email to the tab the
  // orchestrator picked, by the service, not as a reply to the model.
  emailHandoff?: string;
}

export interface ImageAttachment {
  id: string;
  // Defaults to 'image' when absent (back-compat with records saved before
  // general file attachments existed). 'file' is any non-image attachment.
  kind?: 'image' | 'file';
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | string;
  size: number;
  // Present on kind:'file' records so the backend can locate the stored file.
  extension?: string;
  promptIndex?: number;
  url?: string;
  available?: boolean;
}

export interface PendingImageAttachment extends ImageAttachment {
  dataUrl: string;
}

export interface SteeredPrompt {
  id: string;
  prompt: string;
  prompts?: string[];
  sentAt: string;
  terminalContexts?: TerminalContext[];
  attachments?: ImageAttachment[];
  // Paper 21.2b: the chips that rode this steer, and how each ping went.
  mentions?: { email: string; name: string }[];
  contextRefs?: string[];
  pings?: PingResult[] | null;
  delivery?: 'sending' | 'accepted';
}

export interface PingResult { email: string; name?: string; ok: boolean; error?: string }

// Section 26: where a tab message came from or went to.
export interface TabAddress { threadId: string; tabId: string; name: string; threadTitle: string }

export interface Message {
  role: 'user' | 'assistant' | string;
  content: string;
  outputImages?: { target: string; name: string; url: string }[];
  // Multiple messages queued during a run are one provider turn, while the UI
  // keeps each original message as its own bubble.
  batch?: string[];
  ts?: string;
  model?: string;
  // A picked Duel keeps its prompt in provider context while its timeline
  // marker represents that prompt in the visible transcript.
  hiddenInTranscript?: boolean;
  fromDuel?: string;
  // Optional on assistant messages; absent on user + duel-pick messages.
  requestedModel?: string;
  // The model OpenAI turned away as full; `model` is the one that finished.
  fellBackFrom?: string;
  routePolicy?: string | null;
  routeCategory?: string | null;
  routeUsedFor?: string | null;
  ok?: boolean;
  stopped?: boolean;
  error?: string | null;
  usage?: unknown;
  costUsd?: number | null;
  // Present on newly structured assistant messages. Absence marks a legacy
  // response whose work-note split still needs the display heuristic.
  workNotes?: string[];
  tools?: ToolEvent[];
  effort?: string;
  // Full wall-clock for the turn (thinking included); the computer/connector
  // activity timestamps only cover the tool window.
  turnMs?: number;
  confirmation?: ConfirmationRequest | null;
  computer?: ComputerActivity | null;
  connectors?: ConnectorActivity[];
  outsideTouches?: OutsideTouch[];
  terminalContexts?: TerminalContext[];
  attachments?: ImageAttachment[];
  steered?: boolean;
  // A message sent to a person (Slack), not to the model. No reply follows.
  // Every message carries an id (assigned at push, backfilled at read) so a
  // fold's facts can cite the message they came from.
  id?: string;
  // Auto-contextualize: folded messages this turn brought back verbatim.
  recalled?: { id: string; index: number }[];
  note?: boolean;
  // Present on user messages whose turn carried a sibling-tab briefing.
  briefing?: { count: number };
  // Present on a user message a play typed (Paper 17.5), never on the user's own.
  play?: PlayMarker | null;
  // The model's answer to an earlier message, split off when a follow-up was
  // sent mid-turn; the follow-up's answer comes after it.
  interim?: boolean;
  // Same team (Paper 19): who typed it, and whose Mac ran the answer.
  author?: { id: string; name: string };
  // Paper 21.4: this message was handed over from a sibling tab.
  // threadId and threadTitle are set when the sender sits in another workstream.
  handedFrom?: { tabId: string; name: string; at?: string; threadId?: string; threadTitle?: string } | null;
  // Paper 21.2b: the chips that rode this send — Slack pings and picked
  // context blocks — kept so the transcript shows what went with it.
  mentions?: { email: string; name: string }[];
  // Paper 21.2b: what became of each person chip's Slack ping.
  pings?: PingResult[];
  contextRefs?: string[];
  ranBy?: { id: string; name: string; machine?: string | null };
  // Section 26: a message between tabs (role 'tab'), the same object seen
  // from both ends: 'out' with `to` on the sender, 'in' with `from` on the
  // receiver. A reply is a new message that names the one it answers.
  direction?: 'in' | 'out';
  from?: TabAddress;
  to?: TabAddress;
  pairId?: string;
  chainId?: string;
  hop?: number;
  replyTo?: string;
  // A turn that came in from Slack (2026-09-16): the channel and thread it
  // was asked in, so the transcript says so and the answer goes back there.
  fromSlack?: { channel: string; channelName: string; ts: string; threadTs: string };
  // On a user turn: how many unread tab messages it carried to the model.
  tabMessages?: number;
  // Section 29: a scheduled task sent this turn; its line says when it was
  // due and when it ran.
  scheduled?: ScheduledFire | null;
  // On the answer of a scheduled turn that stopped to ask: what it needs,
  // so the confirm row can allow it for next time (board 29.7).
  needs?: { app: string; action: string; scheduleId: string };
  // Section 32: a turn that came in by email, and a tab message carrying one.
  fromEmail?: { from: string; subject: string; reply?: boolean; vime?: boolean };
  viaEmail?: boolean;
  // Section 32: the closing email went to this address (role 'email').
  emailedTo?: string;
}

// Section 29, scheduled tasks by tab.
export type ScheduleRepeat =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'once'; at: string }
  | { kind: 'reply' };

export type ScheduleLateReason = 'closed' | 'busy' | 'asleep';

export interface ScheduledFire {
  id: string;
  name: string;
  fireId: string;
  dueAt: string;
  ranAt: string;
  missed?: number;
  reason?: ScheduleLateReason;
  manual?: boolean;
}

export interface ScheduleHistoryRow {
  id: string;
  dueAt: string;
  ranAt: string;
  missed?: number;
  reason?: ScheduleLateReason;
  manual?: boolean;
  error?: string;
}

export interface Schedule {
  id: string;
  name: string;
  instructions: string;
  threadId: string;
  tabId: string;
  repeat: ScheduleRepeat;
  enabled: boolean;
  allowed: { app: string; action: string }[];
  nextAt: string | null;
  history: ScheduleHistoryRow[];
  running?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type ModelHandoffStatus = 'preparing' | 'completed' | 'failed';

export interface ModelHandoff {
  id: string;
  type: 'model_handoff';
  fromModel: string;
  toModel: string;
  fromProvider?: Provider | null;
  toProvider?: Provider | null;
  mode: 'transcript_replay';
  status: ModelHandoffStatus;
  atMessageCount: number;
  messageCount: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export type ToolActivityKind = 'computer' | 'connector' | 'research' | 'context' | 'work' | 'tool';

export interface ToolEvent {
  name: string;
  detail?: string;
  kind?: ToolActivityKind;
}

// runPublic(run) shape + prompt + active. Present on a tab only while a run is
// in flight (server live-patches it into GET /api/tasks/:id).
export interface ActiveRun {
  // Paper 21.2b: the chips that rode this send, and how the pings went.
  mentions?: { email: string; name: string }[];
  contextRefs?: string[];
  pings?: PingResult[] | null;
  id: string;
  taskId: string;
  tabId: string;
  model: string;
  requestedModel?: string;
  recommendation?: Recommendation | null;
  handoff?: ModelHandoff | null;
  // Section 21: the tab this turn was handed from, shown as the row above
  // the message while the run is live, the same row the landed message keeps.
  handedFrom?: { tabId: string; name: string; at?: string; threadId?: string; threadTitle?: string } | null;
  // Section 29: the scheduled task that sent this turn.
  scheduled?: ScheduledFire | null;
  prompt?: string;
  prompts?: string[];
  hiddenPrompt?: boolean;
  play?: PlayMarker | null;
  startedAt?: string;
  finishedAt?: string | null;
  seq: number;
  text: string;
  draftText?: string;
  workNotes?: string[];
  tools: ToolEvent[];
  effort?: string;
  statusText: string;
  error?: string | null;
  active?: boolean;
  stopping?: boolean;
  paused?: boolean;
  computer?: ComputerActivity | null;
  connectors?: ConnectorActivity[];
  terminalContexts?: TerminalContext[];
  attachments?: ImageAttachment[];
  steers?: SteeredPrompt[];
  // Answers to earlier messages in this turn, split off at each steer.
  interims?: InterimAnswer[];
  // Same team: this run is on another person's Mac, mirrored for the view.
  remote?: RemoteRunner | null;
}

export interface InterimAnswer { id: string | null; text: string; at?: string }

export interface DuelResult {
  // model is redacted (deleted) by the server until a pick is made.
  model?: string;
  text: string;
  ok?: boolean;
  durationMs?: number;
}

export type DuelPhase = 'setup' | 'ready' | 'running' | 'results' | 'picked';

export interface Duel {
  duelId: string;
  // Client-generated idempotency keys keep setup/run durable when Electron
  // briefly loses the HTTP response while the local service keeps working.
  setupRequestId?: string;
  runRequestId?: string;
  sourceTabId?: string;
  duelTabId?: string;
  phase?: DuelPhase;
  effort: string;
  prompt?: string | null;
  a?: DuelResult | null;
  b?: DuelResult | null;
  choice?: 'a' | 'b' | null;
  // models[] is redacted until a pick is made.
  models?: string[];
  winnerSide?: 'a' | 'b';
  rampedAt?: string;
  completedAt?: string;
  pickedAt?: string;
}

export interface EmbeddedDuel extends Duel {
  sourceTabId: string;
  duelTabId?: string;
  atMessageCount: number;
  choice: 'a' | 'b';
  winnerSide: 'a' | 'b';
}

// Plays (Paper 17). A play is a name, a "use it when" line and a rules block
// in the user's words. A run is an agent that types one message per rule;
// each of those messages carries the marker below in the data itself.
export interface PlayMarker { id: string; runId: string; name: string; step: number; steps: number; kickoff?: string }
export interface PlayDraft {
  name: string;
  useWhen: string;
  // The rules block: a small HTML subset (numbered by default) with connector
  // tokens as <span class="play-token" data-name="Gmail">.
  rules: string;
  projectId?: string | null;
  repo?: string | null;
  repoName?: string | null;
  sourceTaskId?: string | null;
  sourceTabId?: string | null;
}
export interface Play extends PlayDraft {
  id: string;
  rulesText: string;
  steps: string[];
  createdAt: string;
  updatedAt: string;
  runs: number;
  lastRunAt: string | null;
  // Same team: who last changed a shared play.
  updatedBy?: { id: string; name: string };
}
export interface PlayJobStep { label: string; state: 'done' | 'now' | 'next' | 'failed' }
export interface PlayFindJob {
  id: string;
  taskId: string;
  tabId: string;
  status: 'reading' | 'ready' | 'failed' | 'stopped';
  steps: PlayJobStep[];
  result: PlayDraft | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
// `outcome` is the model's own report of what the rule did ("41 of 60"), prose
// for the panel only; nothing may be computed from it.
export interface PlayRunStep { label: string; state: 'next' | 'now' | 'done' | 'skipped' | 'stopped' | 'failed'; outcome: string }
export interface PlayRun {
  id: string;
  playId: string;
  name: string;
  taskId: string;
  tabId: string;
  status: 'running' | 'waiting' | 'stopping' | 'stopped' | 'done' | 'failed';
  step: number;
  steps: PlayRunStep[];
  kickoff: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type TabStatus = 'idle' | 'running' | 'done' | 'error';

// Auto-contextualize (Paper 12.2 to 12.4): a fold is a record on the tab,
// never a mutation of the transcript. The model reads the latest fold's
// narrative and facts plus every message from keptFrom on; each fact cites
// the message it came from, and one the check replaced carries the
// source's own words (verbatim).
export interface FoldFact { text: string; sourceId?: string; sourceIndex?: number | null; verified?: boolean; verbatim?: boolean; missing?: boolean; lost?: string[] }
export interface Fold {
  id: string;
  at: string;
  trigger: 'settle' | 'admission' | 'manual' | 'cold';
  keptFrom: number;
  throughIndex: number;
  count: number;
  foldedNow: number;
  narrative: string;
  facts: FoldFact[];
  model: string;
  tokensBefore: number;
  tokensAfter: number;
  previousFoldId?: string | null;
  // Connectors set aside with this fold, by name.
  setAside?: string[];
}

export interface Tab {
  id: string;
  name: string;
  model: string;
  status?: TabStatus;
  // Paper 21.5b: hairline rows for messages this tab handed to siblings.
  handedTo?: { toTabId: string; toName: string; at: string; atMessageCount: number; toThreadId?: string; toThreadTitle?: string }[];
  // Paper 20, tab level: the bookend's mark and the tray's one-line result.
  done?: boolean;
  doneAt?: string | null;
  doneLine?: string | null;
  // Section 27: an orchestrator reaches every tab in the project and keeps a
  // roster (its workstream's map); the network panel opens beside it.
  type?: 'duel' | 'orchestrator';
  messages: Message[];
  handoffs?: ModelHandoff[];
  sessions?: Record<string, { id: string; model: string; msgCount: number }>;
  activeRun?: ActiveRun | null;
  // Same team: messages waiting behind a running turn, who is typing, and
  // when this tab last landed a turn (the merge rule for shared threads).
  queue?: QueuedMessage[];
  typing?: TabTyper[];
  turnAt?: string;
  duel?: Duel | null;
  duels?: EmbeddedDuel[];
  archivedAt?: string;
  archivedIndex?: number;
  // Rolling digest of this tab's conversation, kept by the server for
  // workstream briefings; msgCount is the transcript length it reflects.
  summary?: { text: string; msgCount: number; updatedAt: string };
  briefingHash?: string;
  // Server-computed estimate of context-window fullness; never persisted.
  // band: hidden until the tab is genuinely filling, filling in ink blue, full
  // from the "Almost full" line. Both thresholds live in server.mjs.
  contextMeter?: {
    usedTokens: number;
    windowTokens: number;
    pct: number;
    band: 'hidden' | 'filling' | 'full';
    // measured: the provider's own count for the last turn (tool output
    // included); estimated: text length only, for a tab that has not run.
    source?: 'measured' | 'estimated';
    parts: { connectors: number; conversation: number; attachments: number; briefing: number };
    summedUp: { messages: number; at: string } | null;
  };
  // Set by "Sum up older messages": turns before keptFrom fold into summary
  // for the model, while the transcript keeps every message.
  compaction?: { msgCount: number; keptFrom: number; elided: number; at: string; foldId?: string };
  // The folds this tab made, latest last; the latest is the projection.
  folds?: Fold[];
}

export interface ContextBlock {
  id: string;
  name: string;
  content: string;
}

// Connected tabs (Paper page 8-2). A card is a tab on the workstream's map:
// one line of description, the tools it uses with a line of context each,
// one skill, and its position; Starts is derived from the edges that land
// on it. An edge is what hands over, in the person's words, with the rule
// the words parsed into.
export interface MapTool { name: string; context: string }
export interface MapCard {
  key: string;
  threadId: string;
  tabId: string;
  own: boolean;
  name: string;
  threadTitle: string;
  status?: string;
  done?: boolean;
  description: string;
  tools: MapTool[];
  skill: { id: string | null; name: string } | null;
  minimized: boolean;
  // Section 27: what the tab owes the orchestrator, and who put the card
  // here (the orchestrator may take off only what it added).
  owes?: string;
  by?: 'orchestrator';
  x?: number;
  y?: number;
  addedAt?: string;
}
export interface MapRule { when: string; then: string; with: string; label: string; trigger: string }
export interface MapRef { threadId: string; tabId: string; name?: string; threadTitle?: string }
export interface MapEdge {
  id: string;
  from: MapRef;
  to: MapRef;
  words: string;
  rule: MapRule;
  createdAt?: string | null;
  updatedAt?: string | null;
}
export interface TabMap { cards: Record<string, MapCard>; edges: MapEdge[] }

// Section 27: one roster write by the orchestrator, as the traffic shows it.
export interface TrafficEvent {
  id: string;
  at: string;
  kind: 'roster';
  by: 'orchestrator';
  action: 'add' | 'new' | 'remove' | 'write';
  tab: { threadId: string; tabId: string; name: string; threadTitle: string };
  text: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  undone: boolean;
  undoneAt?: string;
}

export interface Task {
  id: string;
  title: string;
  projectId?: string;
  repo: string;
  repoName: string;
  base?: string;
  branch?: string;
  worktreePath?: string;
  cwd?: string;
  model: string;
  tools?: string;
  connectors?: boolean;
  status?: string;
  archived?: boolean;
  archivedAt?: string | null;
  pinned?: boolean;
  // 'signup' marks the workstream Supreme started from what it read at sign up.
  origin?: 'signup' | 'slack' | null;
  // The one fork at the end of that first task (Paper 14.10).
  signupFork?: 'archived' | 'repeat' | null;
  // Same team: set when the project is shared.
  shared?: SharedInfo | null;
  viewers?: { id: string; name: string; tabId: string | null }[];
  createdBy?: { id: string; name: string };
  activeTab: string;
  tabs: Tab[];
  archivedTabs?: Tab[];
  contextBlocks?: ContextBlock[];
  // Connected tabs: the map, read whole by the server (every live tab a
  // card). mapMemberships lists other workstreams whose map holds one of
  // this workstream's tabs.
  map?: TabMap;
  // Opt-in maps: true while the workstream has no map (new ones start so).
  mapOff?: boolean;
  // Section 27: what the orchestrator wrote to its map, each with an undo.
  traffic?: TrafficEvent[];
  // Own tabs taken off the map by hand; Add tab lists them.
  mapHiddenTabs?: { id: string; name: string }[];
  mapMemberships?: string[];
  diffStat?: string | null;
  prUrl?: string | null;
  lastActivity?: string;
  createdAt?: string;
  updatedAt?: string;
  cloudHandoff?: {
    machineId: string;
    state?: 'starting' | 'running' | 'stopping' | string;
    startedAt?: string;
    stoppedAt?: string;
    workspaceError?: string;
    workspace?: {
      source?: Record<string, unknown>;
      returned?: Record<string, unknown>;
      originalWorktreePath?: string;
      originalBranch?: string;
    };
  };
  lastWorkspaceHandoff?: {
    mode: 'applied' | 'staged' | 'unchanged' | string;
    changedFiles?: number;
    conflicts?: string[];
    at?: string;
  };
}

export interface SummaryLane { key: string; askedAt: string | null; answeredAt: string | null }
export interface SummaryTab { id: string; name: string; status?: string; done?: boolean; type?: 'duel' | 'orchestrator'; landedAt?: string; landedBy?: string; returnedAt?: string; returnedBy?: string; lanes?: SummaryLane[] }

// GET /api/tasks list-item shape (taskSummary).
export interface TaskSummary {
  id: string;
  origin?: 'signup' | 'slack' | null;
  slackInbox?: { state: 'working' | 'needs-you' | 'finished'; reason: string; tabId: string | null; channelName: string } | null;
  title: string;
  projectId?: string;
  repo: string;
  repoName: string;
  branch?: string;
  base?: string;
  model: string;
  status?: string;
  archived?: boolean;
  archivedAt?: string | null;
  pinned?: boolean;
  // Presence v2: teammates currently looking at this thread, and which tab.
  viewers?: { id: string; name: string; tabId: string | null }[];
  // done = every live tab is done; doneTabs lists each one for the tray.
  done?: boolean;
  doneTabs?: { id: string; name: string; doneAt: string | null; doneLine: string | null }[];
  shared?: { projectId: string };
  remoteRun?: { name: string };
  tabCount: number;
  // Connected tabs: the Map index's count line, and whether it lists this
  // workstream at all (maps are opt-in).
  mapOff?: boolean;
  mapCards?: number;
  mapDone?: number;
  mapHandovers?: number;
  // Each live tab, light: the @ menu hands to a tab in any workstream.
  // Section 28: `landedAt` is when the tab's last turn came back clean (the
  // rail's unread dot reads it for a workstream that is not loaded) and
  // `landedBy` whose Mac ran it on a shared one; an orchestrator's row
  // carries the lanes it has asked, for its card's count.
  tabs?: SummaryTab[];
  archivedTabCount: number;
  archivedTabs: { id: string; name: string; archivedAt: string | null }[];
  messageCount: number;
  needsConfirmationCount?: number;
  lastActivity?: string;
  createdAt?: string;
  updatedAt?: string;
  diffStat?: string | null;
  prUrl?: string | null;
}

export interface Project {
  id?: string;
  path: string;
  name: string;
  base?: string;
  hasRemote?: boolean;
  managed?: boolean;
  archived?: boolean;
  contextBlocks?: ContextBlock[];
  // Same team: present once the project is shared (either direction).
  shared?: SharedInfo | null;
}

// Same team (Paper section 19).
export interface RemoteRunner { userId: string | null; name: string; machine: string | null }
export interface QueuedMessage {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  status: 'queued' | 'running' | 'expired' | 'failed' | 'done';
  createdAt: string;
  mine: boolean;
  online: boolean;
}
export interface TabTyper { userId: string; name: string }
export interface SharedMember {
  id: string;
  email: string;
  userId: string | null;
  role: 'owner' | 'editor';
  name: string;
  accepted: boolean;
  me: boolean;
  online: boolean;
}
export interface SharedInfo {
  projectId: string;
  role: 'owner' | 'editor' | null;
  ownerId: string;
  ownerName: string;
  members: SharedMember[];
}
export interface TeamStatus {
  enabled: boolean;
  kind: 'supabase' | 'hub' | null;
  user: { id: string; email: string; name: string } | null;
  projects: string[];
  machine: string;
}

export interface Connector {
  name: string;
  url: string;
  connected: boolean;
  status: string;
  provider?: 'claude' | 'codex';
}

// GET /api/connectors/overview — the Connectors page. One row per connector
// across providers; uses are counted per turn, seededUses come from the
// one-time read of local Claude Code / Codex histories.
export interface ConnectorProviderState { connected: boolean; status: string; url: string; server?: string }
export interface ConnectorRow {
  key: string;
  name: string;
  names: string[];
  // 'computer' is the one plugin row (Claude in Chrome, the Codex Chrome
  // extension); its connected state is the extension being installed.
  kind?: 'connector' | 'computer';
  providers: Partial<Record<'claude' | 'codex', ConnectorProviderState>>;
  connected: boolean;
  signIn: Array<'claude' | 'codex'>;
  // Providers whose Chrome extension is missing (computer row only).
  install?: Array<'claude' | 'codex'>;
  uses: number;
  seededUses: number;
  totalUses: number;
  lastUsedAt: string | null;
  isNew: boolean;
}
export interface ConnectorsOverview {
  checkedAt: string | null;
  seededAt: string | null;
  mostUsed: ConnectorRow[];
  rest: ConnectorRow[];
  count: number;
  connectedCount: number;
}

export interface PlatformContextAccess {
  kind: 'chrome' | 'connector' | 'cli' | 'app' | 'api' | string;
  label: string;
  ready: boolean;
  provider?: string | null;
  detail: string;
}

export interface PlatformContextEntry {
  id: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PlatformContextExample {
  id: string;
  excerpt: string;
  url?: string;
}

export interface PlatformContextSource {
  kind: 'manual' | 'history';
  accessKind: string;
  label: string;
  exampleCount: number | null;
  examples?: PlatformContextExample[];
  retrievedAt?: string | null;
}

export interface PlatformContextMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  kind?: 'access';
}

export interface PlatformContextSummary {
  key: string;
  name: string;
  mark: string;
  savedCount: number;
  draftCount: number;
  hasSuggestions: boolean;
  access: PlatformContextAccess;
}

export interface PlatformContextDetail {
  key: string;
  name: string;
  mark: string;
  entries: PlatformContextEntry[];
  draftEntries: PlatformContextEntry[];
  messages: PlatformContextMessage[];
  source: PlatformContextSource | null;
  draftSource: PlatformContextSource | null;
  savedAt: string | null;
  updatedAt: string | null;
  suggestions: PlatformContextEntry[];
  access: PlatformContextAccess;
}

export interface LayoutPaneRef {
  threadId: string;
  tabId: string | null;
  /** Relative flex weight. Omitted layouts fall back to equal-width panes. */
  width?: number;
}

export interface LayoutRecord {
  panes: LayoutPaneRef[];
  updatedAt: number;
  deleted?: boolean;
}

export interface Settings {
  userName?: string;
  defaultModel?: string;
  defaultEffort?: string;
  performancePolicy?: string;
  threadLayouts?: Record<string, LayoutRecord>;
  openrouterKey?: string;
  dataDir?: string;
  home?: string;
}

// SSE run events — no `event:` line; discriminate on the JSON `type` field.
export type RunEvent =
  | { type: 'start'; runId?: string; model?: string; requestedModel?: string; recommendation?: Recommendation | null; handoff?: ModelHandoff | null; handedFrom?: { tabId: string; name: string; at?: string; threadId?: string; threadTitle?: string } | null; scheduled?: ScheduledFire | null; effort?: string; terminalContexts?: TerminalContext[]; attachments?: ImageAttachment[]; tabId?: string }
  | { type: 'session'; id: string }
  | { type: 'candidate-reset' }
  | { type: 'candidate-delta'; text?: string }
  | { type: 'progress'; text?: string }
  | ({ type: 'steer' } & SteeredPrompt)
  | { type: 'delta'; text?: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'status'; text?: string }
  | ({ type: 'computer'; phase?: ComputerStep['phase']; connection?: ComputerActivity['connection']; surface?: 'Chrome' | 'browser'; app?: string; step?: string; hasPreview?: boolean; at?: string; seq?: number })
  | ({ type: 'connector'; id?: string; phase?: 'start' | 'complete' | 'error' | 'stopped'; connector?: string; action?: ConnectorAction; detail?: string; account?: string; outcome?: string; count?: number | null; unit?: string; at?: string; seq?: number })
  | { type: 'stopped'; text?: string }
  | { type: 'saved'; status?: string; diffStat?: string | null; tabId?: string; ok?: boolean; stopped?: boolean; waiting?: boolean }
  | { type: 'error'; message?: string }
  | { type: 'run-finished'; runId?: string; tabId?: string }
  | { type: string; [k: string]: unknown };

export interface RemoteSession {
  taskId: string;
  taskTitle: string;
  repoName: string;
  tabId: string;
  tabName: string;
  model: string;
  status: TabStatus;
  lastActivity: string;
  messageCount: number;
  preview: string;
  lastRole: string | null;
  run: ActiveRun | null;
}

export interface RemoteSnapshot {
  machine: { name: string; online: boolean } | null;
  mobileApp: {
    installed: boolean;
    live: boolean;
    deviceName: string | null;
    appVersion: string | null;
    lastSeen: string | null;
  };
  sessions: RemoteSession[];
  activeCount: number;
  at?: string;
}

export interface Stats {
  threads: number;
  tabs: number;
  runs: number;
  errors: number;
  connectorsOn: number;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
  duels?: number;
  picks?: number;
  wins?: Record<string, number>;
}

export interface DuelHistorySide {
  model: string;
  text: string;
  ok: boolean;
  durationMs?: number | null;
}

export interface DuelHistoryEntry {
  id: string;
  prompt: string;
  threadId: string;
  tabId: string;
  project: string;
  thread: string;
  sourceTab: string;
  source: string;
  effort: string;
  at?: string;
  picked: boolean;
  choice?: 'a' | 'b' | 'neither' | null;
  winner?: string;
  a?: DuelHistorySide | null;
  b?: DuelHistorySide | null;
}

export interface DuelHistory {
  duels: DuelHistoryEntry[];
  count: number;
}

export interface PerformanceRow {
  model: string;
  usedFor: string;
  steps: number;
  spendUsd?: number;
  meteredSteps?: number;
  unmeteredSteps?: number;
}

export interface Performance {
  period?: { from?: string; to?: string };
  steps: number;
  rows: PerformanceRow[];
  meteredSpendUsd?: number;
  unmeteredSteps?: number;
  routedSteps?: number;
}

export interface DiffState {
  threadId: string;
  loading?: boolean;
  files?: unknown[];
  patch?: string;
  dirty?: boolean;
  error?: string;
}

export interface Pane {
  repo: string | null;
  threadId: string;
  tabId: string | null;
  /** Relative flex weight, persisted with the root thread's split layout. */
  width?: number;
}

// GET /api/status — per-install environment readiness (which model providers are
// connected), used for onboarding + graceful degradation.
export interface ProviderStatus {
  provider: string;
  label: string;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  path: string | null;
  connectCommand: string | null;
  hint: string;
  loginUrl?: string;
  installUrl?: string;
  email?: string;
  plan?: string;
  webConnected?: boolean;
  // Present while the CLI installer is running (or after it failed).
  install?: {
    running: boolean;
    phase: 'downloading' | 'installing' | 'finishing' | 'failed' | string;
    note: string;
    error: string | null;
    elapsedMs: number;
  } | null;
}

export interface ChromeProviderStatus {
  installed: boolean;
  activeProfileInstalled: boolean;
  activeProfileEnabled: boolean;
  profiles: string[];
  installUrl: string;
  testStatus?: 'untested' | 'ready' | 'failed';
  testMessage?: string;
}

export interface OnboardingLabStatus {
  enabled: boolean;
  scenario: string;
  scenarios: Array<{ id: string; label: string }>;
}

export interface ModelUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string | null;
  windowDurationMins?: number | null;
  scopeModel?: string | null;
}

export interface ModelUsageCredits {
  enabled?: boolean;
  usedMinor?: number | null;
  limitMinor?: number | null;
  currency?: string;
  exponent?: number;
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string | null;
}

export interface ModelUsageResetCredit {
  title: string;
  description?: string;
  status?: string;
  grantedAt?: string | null;
  expiresAt?: string | null;
}

export interface ProviderUsage {
  provider: 'claude' | 'codex' | 'grok';
  available: boolean;
  source?: string;
  fetchedAt: string;
  windows: ModelUsageWindow[];
  credits?: ModelUsageCredits | null;
  resetCredits?: { availableCount: number; credits: ModelUsageResetCredit[] } | null;
  message?: string;
}

export interface ModelUsage {
  fetchedAt: string;
  providers: Record<'claude' | 'codex' | 'grok', ProviderUsage>;
}

export interface Status {
  ready: boolean;
  ok: boolean;
  providers: Record<string, ProviderStatus>;
  connectedProviders: string[];
  readyModels: string[];
  chrome: {
    installed: boolean;
    enabled: boolean;
    byProvider?: Record<string, boolean>;
    installUrl: string;
    activeProfile?: string | null;
    providers?: Partial<Record<'claude' | 'codex', ChromeProviderStatus>>;
  };
  git: { installed: boolean };
  node: string;
  home: string;
  dataDir: string;
  cloudWorker?: { configured: boolean };
  onboardingLab?: OnboardingLabStatus;
  team?: TeamStatus;
}
