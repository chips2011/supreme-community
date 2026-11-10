import { api } from './api';
import { andList } from './lib/people';
import {
  state, set, setStream, toast, threadsForRepo, toolLabel, userStatusText,
} from './store';
import type { OnboardingProvider, QueuedPrompt, StreamState, View, PlayPanelState } from './store';
import { defaultOnboarding, defaultPlayPanel, draftKey, emptyTab, paneTabKey } from './store';
import type { Play, PlayDraft, PlayFindJob, PlayRun, Project, QueuedMessage, Schedule, SharedInfo } from './types';
import { RECOMMENDED_MODEL, PERFORMANCE_STOPS, EFFORT_NAMES } from './constants';
import { loadPrefs, savePrefs, persistThreadLayouts, loadBlockedPrompts, saveBlockedPrompts } from './lib/prefs';
import { markSeen, touch, view } from './lib/vitality';
import { landedDeck, landedKey, landedPlace } from './lib/landed';
import type { LandedRow } from './lib/landed';
import { landedShortcut } from './lib/landed-keys';
import { tabSearchShortcut } from './lib/tab-search';
import { workspaceSearchShortcut } from './lib/workspace-search';
import { softTick } from './components/DoneTray';
import { showWholeThread } from './lib/earlier';
import { destinationsElsewhere } from './lib/mention';
import {
  saveCurrentLayout, mergeThreadLayouts, syncThreadLayout, forgetThreadInLayouts, rebaseLayoutRoot,
} from './lib/layout';
import { cancelConversationLanding, followConv, nudgeConv, scrollConv, trackConversationScroll } from './lib/dom';
import { duelPhase, duelEffortIndex } from './lib/duel';
import { paneWeight } from './lib/panes';
import { captureAnalytics } from './analytics';
import type { Task, Tab, Pane, RunEvent, ToolEvent, ConnectorAction, ConnectorActivity, TerminalContext, PendingImageAttachment, SteeredPrompt, PingResult, MapCard, MapEdge, MapRef, TabMap } from './types';

export { duelPhase, duelEffortIndex };

const CONNECTOR_ACTIONS = new Set<ConnectorAction>(['listen', 'read', 'search', 'create', 'update', 'draft', 'send', 'schedule', 'connect', 'publish', 'upload', 'delete', 'use']);
const PASTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_PASTED_IMAGES = 6;
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PASTED_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_DROPPED_FILES = 10;
const MAX_DROPPED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DROPPED_FILES_TOTAL_BYTES = 50 * 1024 * 1024;

function modelAnalyticsProperties(modelId?: string | null): Record<string, string> {
  const model = modelId || 'unknown';
  const provider = state.modelById[model]?.provider
    || (model.includes('claude') || model.includes('sonnet') || model.includes('opus') ? 'claude'
      : model.includes('gpt') || model.includes('codex') ? 'codex' : 'unknown');
  return { model, provider };
}

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

export async function addPastedImages(key: string, files: File[], source: 'paste' | 'drop' = 'paste'): Promise<void> {
  const images = files.filter((file) => file && file.type.startsWith('image/'));
  if (!images.length) return;
  const attachments = state.pendingImages[key] || [];
  const current = attachments.filter((attachment) => attachment.kind !== 'file');
  if (current.length + images.length > MAX_PASTED_IMAGES) {
    toast(`Attach up to ${MAX_PASTED_IMAGES} images at a time.`);
    return;
  }
  if (images.some((file) => !PASTED_IMAGE_TYPES.has(file.type.toLowerCase()))) {
    toast('Paste a PNG, JPEG, or WebP image.');
    return;
  }
  if (images.some((file) => file.size > MAX_PASTED_IMAGE_BYTES)) {
    toast('Each pasted image must be 10 MB or smaller.');
    return;
  }
  const total = current.reduce((sum, image) => sum + image.size, 0) + images.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_PASTED_TOTAL_BYTES) {
    toast('Pasted images must total 24 MB or less.');
    return;
  }
  try {
    const added: PendingImageAttachment[] = await Promise.all(images.map(async (file, index) => ({
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
      name: file.name || `Screenshot ${current.length + index + 1}`,
      mimeType: file.type.toLowerCase(),
      size: file.size,
      promptIndex: 0,
      dataUrl: await fileDataUrl(file),
    })));
    state.pendingImages[key] = [...attachments, ...added];
    captureAnalytics('image_attached', {
      attachment_count: added.length,
      attachment_source: source,
      total_bytes_bucket: total < 1_000_000 ? 'under_1mb' : total < 10_000_000 ? '1mb_to_10mb' : 'over_10mb',
    });
    set();
  } catch (error) {
    toast((error as Error).message || 'Could not read that image.');
  }
}

// PNG, JPEG, and WebP use the existing vision path. Every other pasted or
// dropped file is staged into the run worktree for the provider to read.
export async function addDroppedFiles(
  key: string,
  files: File[],
  source: 'paste' | 'drop' = 'drop',
): Promise<void> {
  const all = files.filter(Boolean);
  if (!all.length) return;
  const images = all.filter((file) => file.type.startsWith('image/') && PASTED_IMAGE_TYPES.has(file.type.toLowerCase()));
  const others = all.filter((file) => !images.includes(file));
  if (images.length) await addPastedImages(key, images, source);
  if (!others.length) return;

  const attachments = state.pendingImages[key] || [];
  const current = attachments.filter((attachment) => attachment.kind === 'file');
  if (current.length + others.length > MAX_DROPPED_FILES) {
    toast(`Attach up to ${MAX_DROPPED_FILES} files at a time.`);
    return;
  }
  if (others.some((file) => file.size > MAX_DROPPED_FILE_BYTES)) {
    toast(`Each file must be ${Math.round(MAX_DROPPED_FILE_BYTES / (1024 * 1024))} MB or smaller.`);
    return;
  }
  const total = current.reduce((sum, attachment) => sum + attachment.size, 0)
    + others.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_DROPPED_FILES_TOTAL_BYTES) {
    toast(`Attached files must total ${Math.round(MAX_DROPPED_FILES_TOTAL_BYTES / (1024 * 1024))} MB or less.`);
    return;
  }
  try {
    const added: PendingImageAttachment[] = await Promise.all(others.map(async (file, index) => ({
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
      kind: 'file' as const,
      name: file.name || `Attachment ${current.length + index + 1}`,
      mimeType: (file.type || 'application/octet-stream').toLowerCase(),
      size: file.size,
      promptIndex: 0,
      dataUrl: await fileDataUrl(file),
    })));
    state.pendingImages[key] = [...(state.pendingImages[key] || []), ...added];
    captureAnalytics('file_attached', {
      attachment_count: added.length,
      attachment_source: source,
      total_bytes_bucket: total < 1_000_000 ? 'under_1mb' : total < 10_000_000 ? '1mb_to_10mb' : 'over_10mb',
    });
    set();
  } catch (error) {
    toast((error as Error).message || 'Could not read that file.');
  }
}

export function removePendingImage(key: string, id: string): void {
  const next = (state.pendingImages[key] || []).filter((image) => image.id !== id);
  if (next.length) state.pendingImages[key] = next;
  else delete state.pendingImages[key];
  set();
}

// ---------------------------------------------------------------------------
// settings / prefs

export function saveDefault(patch: Record<string, unknown>): void {
  api('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => {});
}

// The last model you picked anywhere becomes the default for new threads/tabs,
// persisted to the server so it follows you across browsers/refreshes.
export function rememberModel(model: string | undefined): void {
  if (model) { state.homeModel = model; savePrefs(); saveDefault({ defaultModel: model }); }
}

export function defaultModelForProvider(provider: string | undefined | null): string {
  return provider === 'claude' ? 'sonnet' : 'gpt-6-luna';
}

// Per-install identity for the sidebar. Set during onboarding or edited in-app;
// persisted to server settings so it's not tied to one browser.
export function setUserName(name: string): void {
  const clean = (name || '').trim().slice(0, 80);
  state.userName = clean;
  saveDefault({ userName: clean });
  set();
}

// ---------------------------------------------------------------------------
// data loading

export async function boot(): Promise<void> {
  loadPrefs();
  const requestedView = new URLSearchParams(location.search).get('view');
  if (requestedView === 'slack') state.view = 'slack';
  if (requestedView === 'remote') state.view = 'remote';
  if (requestedView === 'onboarding') state.view = 'onboarding';
  if (requestedView === 'context') state.view = 'context';
  if (requestedView === 'plays') state.view = 'plays';
  if (requestedView === 'maps') state.view = 'maps';
  try {
    const [m, r, t, st, status] = await Promise.all([
      api('/api/models'), api('/api/repos'), api('/api/tasks'), api('/api/settings'), api('/api/status'),
    ]);
    state.models = m.models || [];
    state.modelById = Object.fromEntries([RECOMMENDED_MODEL, ...state.models].map((x) => [x.id, x]));
    state.projects = r.repos || [];
    state.threads = t.tasks || [];
    state.status = status;
    state.slackReady = slackUsable(st.slack);
    if (typeof st.userName === 'string') state.userName = st.userName;
    if (st.defaultModel && state.modelById[st.defaultModel]) state.homeModel = st.defaultModel;
    if (st.defaultEffort) state.effort = st.defaultEffort;
    if (PERFORMANCE_STOPS.some((stop) => stop.id === st.performancePolicy)) state.performancePolicy = st.performancePolicy;
    const savedOnboarding = st.onboarding && typeof st.onboarding === 'object' ? st.onboarding : null;
    // A project someone shared with you (Same team) arrives before you have
    // done anything on this Mac; it must not count as an existing workspace,
    // or a brand-new person skips onboarding and never connects a model.
    const sharedPaths = new Set(state.projects.filter((project) => project.shared && project.shared.role !== 'owner').map((project) => project.path));
    const ownProjects = state.projects.filter((project) => !sharedPaths.has(project.path));
    const ownThreads = state.threads.filter((thread) => !sharedPaths.has(thread.repo));
    const existingWorkspace = ownThreads.length > 0 || ownProjects.length > 0;
    const legacyStep = ['tools', 'chrome', 'first-run', 'persona'].includes(savedOnboarding?.step) ? 'linkedin' : savedOnboarding?.step;
    const defaults = defaultOnboarding();
    state.onboarding = {
      ...defaults,
      complete: savedOnboarding?.complete === true || (!savedOnboarding && existingWorkspace),
      signedIn: savedOnboarding?.signedIn === true || (!savedOnboarding && existingWorkspace),
      step: ['signin', 'models', 'linkedin', 'greeting', 'directions', 'complete'].includes(legacyStep) ? legacyStep : existingWorkspace ? 'complete' : 'signin',
      email: typeof savedOnboarding?.email === 'string' ? savedOnboarding.email : '',
      webProviders: Array.isArray(savedOnboarding?.webProviders) ? savedOnboarding.webProviders : [],
      selectedProvider: savedOnboarding?.selectedProvider === 'claude' || savedOnboarding?.selectedProvider === 'codex' ? savedOnboarding.selectedProvider : 'codex',
      verifiedProviders: Array.isArray(savedOnboarding?.verifiedProviders) ? savedOnboarding.verifiedProviders.filter((value: unknown): value is OnboardingProvider => value === 'claude' || value === 'codex') : [],
      chromeSkipped: savedOnboarding?.chromeSkipped === true,
      chromeReady: savedOnboarding?.chromeReady === true,
      chromeError: typeof savedOnboarding?.chromeError === 'string' ? savedOnboarding.chromeError : '',
      linkedinUrl: typeof savedOnboarding?.linkedinUrl === 'string' ? savedOnboarding.linkedinUrl : '',
      profile: savedOnboarding?.profile && typeof savedOnboarding.profile === 'object' ? savedOnboarding.profile : null,
      read: savedOnboarding?.read && typeof savedOnboarding.read === 'object' ? savedOnboarding.read : null,
      answers: { ...defaults.answers, ...(savedOnboarding?.answers && typeof savedOnboarding.answers === 'object' ? savedOnboarding.answers : {}) },
      direction: Number.isInteger(savedOnboarding?.direction) ? savedOnboarding.direction : null,
      firstTaskId: typeof savedOnboarding?.firstTaskId === 'string' ? savedOnboarding.firstTaskId : null,
    };
    loadBlockedPrompts();
    if (state.authConfigured && state.session && state.onboarding.step === 'signin') {
      state.onboarding = { ...state.onboarding, signedIn: true, step: 'models' };
    }
    if (!state.authConfigured && !status.onboardingLab?.enabled && state.onboarding.step === 'signin') {
      state.onboarding = { ...state.onboarding, signedIn: true, step: 'models' };
    }
    if (!requestedView && !state.onboarding.complete) state.view = 'onboarding';
    mergeThreadLayouts(st.threadLayouts);
    api('/api/connectors').then((c) => {
      state.connectors = c.connectors || [];
      state.connectorsLoaded = true;
      set();
    }).catch(() => {});
    const activeProjects = state.projects.filter((p) => !p.archived);
    if ((!state.homeProject || !activeProjects.some((p) => p.path === state.homeProject)) && activeProjects[0]) {
      state.homeProject = activeProjects[0].path;
    }
    captureAnalytics('workspace_loaded', {
      project_count: activeProjects.length,
      workstream_count: state.threads.filter((thread) => !thread.archived).length,
      onboarding_complete: state.onboarding.complete,
    });
    if (!state.onboarding.complete) {
      captureAnalytics('onboarding_started', { onboarding_step: state.onboarding.step });
    }
  } catch (e) { toast('load failed: ' + (e as Error).message); }
  if (state.view === 'remote') await loadRemote({ quiet: true });
  if (state.view === 'context') await loadPlatformContexts({ quiet: true });
  set();
  // A cold-start email link waits until auth and workspace loading finish.
  // Otherwise boot's restored view can replace the requested conversation.
  await window.conductorDesktop?.readyForOpenThread?.().catch(() => {});
}

// ---------------------------------------------------------------------------
// onboarding / model accounts

const PROVIDER_LOGIN: Record<string, string> = {
  claude: 'https://claude.ai/login',
  codex: 'https://chatgpt.com/auth/login',
  grok: 'https://accounts.x.ai/sign-in?redirect=grok-com',
};

function updateOnboarding(patch: Partial<typeof state.onboarding>): void {
  state.onboarding = { ...state.onboarding, ...patch };
  saveDefault({ onboarding: state.onboarding });
  set();
}

export function restartOnboarding(): void {
  const lab = state.status?.onboardingLab?.enabled === true;
  if (lab) {
    void setOnboardingLabScenario(state.status?.onboardingLab?.scenario || 'clean');
    return;
  }
  state.onboarding = {
    ...defaultOnboarding(),
    email: state.onboarding.email,
    signedIn: state.authConfigured ? !!state.session : true,
    step: 'models',
  };
  state.onboardingLinkedInBusy = false;
  captureAnalytics('onboarding_restarted');
  saveDefault({ onboarding: state.onboarding });
  state.view = 'onboarding';
  state.pop = null;
  set();
}

export function completeWorkbenchSignIn(email: string): void {
  const clean = email.trim().slice(0, 160);
  updateOnboarding({ signedIn: true, step: 'models', email: clean });
}

export function selectOnboardingProvider(provider: OnboardingProvider): void {
  captureAnalytics('onboarding_provider_selected', { provider });
  updateOnboarding({ selectedProvider: provider, chromeReady: false, chromeError: '' });
}

export async function installOnboardingProvider(provider: OnboardingProvider): Promise<void> {
  if (state.installingProviders[provider]) return;
  const label = provider === 'claude' ? 'Claude Code' : 'Codex';
  state.installingProviders[provider] = true;
  captureAnalytics('onboarding_provider_install_started', { provider });
  set();
  try {
    const result = await api(`/api/providers/${provider}/install`, { method: 'POST' });
    if (result.status) state.status = result.status;
    if (state.status?.onboardingLab?.enabled) {
      toast(`${label} installed for this fake user`);
      return;
    }
    toast(result.installed ? `${label} is installed.` : `Installing ${label}…`);
    // The official installers drop the binary under ~/.local/bin; poll until the
    // backend detects it. Slow networks can take several minutes, so keep
    // waiting while the server still reports the installer alive, and stop
    // right away when it reports a failure.
    for (let attempt = 0; attempt < 240 && !state.status?.providers[provider]?.installed; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      await refreshStatus();
      const install = state.status?.providers[provider]?.install;
      if (install?.error) break;
      if (attempt >= 80 && !install?.running) break;
    }
    if (state.status?.providers[provider]?.installed) {
      captureAnalytics('onboarding_provider_install_completed', { provider });
      toast(`${label} is installed. Sign in to continue.`);
    } else {
      const failure = state.status?.providers[provider]?.install?.error;
      captureAnalytics('onboarding_provider_install_failed', { provider, failure_stage: failure ? 'installer_error' : 'detection_timeout' });
      toast(failure || `${label} did not finish installing. Try again.`);
    }
  } catch (error) {
    captureAnalytics('onboarding_provider_install_failed', { provider, failure_stage: 'request' });
    toast((error as Error).message || `Could not install ${label}.`);
  } finally {
    state.installingProviders[provider] = false;
    set();
  }
}

export async function verifyOnboardingModel(provider: OnboardingProvider): Promise<void> {
  if (state.onboardingCheckingProvider) return;
  if (state.onboarding.verifiedProviders.includes(provider)) {
    rememberModel(defaultModelForProvider(provider));
    updateOnboarding({ selectedProvider: provider, step: 'linkedin' });
    return;
  }
  state.onboardingCheckingProvider = provider;
  captureAnalytics('onboarding_provider_verification_started', { provider });
  state.onboarding = { ...state.onboarding, selectedProvider: provider };
  set();
  try {
    await api('/api/onboarding/model-check', {
      method: 'POST', body: JSON.stringify({ provider }),
    });
    const verifiedProviders = [...new Set([...state.onboarding.verifiedProviders, provider])] as OnboardingProvider[];
    rememberModel(defaultModelForProvider(provider));
    updateOnboarding({ selectedProvider: provider, verifiedProviders, step: 'linkedin' });
    captureAnalytics('onboarding_provider_verified', { provider });
  } catch (error) {
    captureAnalytics('onboarding_provider_verification_failed', { provider });
    toast((error as Error).message || 'The model did not answer the setup check.');
  }
  state.onboardingCheckingProvider = null;
  set();
}

// Finish onboarding without the Chrome/browser step. Browser control is an
// optional enhancement (and its live-automation check is flaky), so a skip must
// land the user in the app rather than loop back on the collapsed chrome screen.
export function skipOnboarding(): void {
  state.onboarding = { ...state.onboarding, complete: true, step: 'complete', chromeSkipped: true };
  state.view = 'home';
  state.pop = null;
  saveDefault({ onboarding: state.onboarding });
  captureAnalytics('onboarding_completed', { browser_setup: 'skipped', provider: state.onboarding.selectedProvider });
  set();
}

export async function checkOnboardingChrome(): Promise<void> {
  const provider = state.onboarding.selectedProvider;
  if (!provider || state.onboardingChromeChecking) return;
  state.onboardingChromeChecking = true;
  captureAnalytics('onboarding_browser_check_started', { provider });
  state.onboarding = { ...state.onboarding, chromeError: '' };
  set();
  try {
    const result = await api('/api/onboarding/chrome-check', {
      method: 'POST', body: JSON.stringify({ provider }),
    });
    updateOnboarding({ chromeReady: result.ready === true, chromeError: result.ready ? '' : result.message || 'Chrome did not finish the test.' });
    captureAnalytics(result.ready ? 'onboarding_browser_check_completed' : 'onboarding_browser_check_failed', { provider });
  } catch (error) {
    captureAnalytics('onboarding_browser_check_failed', { provider });
    updateOnboarding({ chromeReady: false, chromeError: (error as Error).message || 'Chrome did not finish the test.' });
  }
  state.onboardingChromeChecking = false;
  await refreshStatus();
  set();
}

export async function openConnectorSettings(provider: OnboardingProvider, name?: string): Promise<void> {
  if (state.status?.onboardingLab?.enabled) {
    try {
      const result = await api('/api/onboarding/lab/connect-tool', {
        method: 'POST', body: JSON.stringify({ provider, name }),
      });
      state.status = result.status;
      state.connectors = result.connectors || [];
      toast(result.message || 'A fake tool is ready.');
      set();
    } catch (error) {
      toast((error as Error).message || 'Could not add the fake tool.');
    }
    return;
  }
  const url = provider === 'claude'
    ? 'https://claude.ai/settings/connectors'
    : 'https://chatgpt.com/#settings/Connectors';
  window.open(url, '_blank', 'noopener,noreferrer');
}

// A Codex remote server (Granola, Notion) signs in through `codex mcp login
// <server>`: the service starts it, the browser opens, Codex keeps the token.
export async function signInCodexServer(server: string, name: string): Promise<void> {
  try {
    await api('/api/connectors/login', { method: 'POST', body: JSON.stringify({ provider: 'codex', server }) });
    toast(`Finish signing in to ${name} in your browser, then Refresh.`);
  } catch (error) {
    toast((error as Error).message || `Could not start the ${name} sign-in.`);
  }
}

export async function refreshOnboardingChromeSetup(provider: OnboardingProvider): Promise<void> {
  try {
    if (state.status?.onboardingLab?.enabled) {
      const result = await api('/api/onboarding/lab/fix-chrome', {
        method: 'POST', body: JSON.stringify({ provider }),
      });
      state.status = result.status;
      toast('Chrome fixed for this fake user');
      set();
      return;
    }
    await refreshStatus();
  } catch (error) {
    toast((error as Error).message || 'Could not check Chrome again.');
  }
}

export async function installOnboardingChrome(provider: OnboardingProvider): Promise<void> {
  const extension = state.status?.chrome.providers?.[provider];
  if (!state.status?.onboardingLab?.enabled) {
    const installUrl = extension?.installUrl || state.status?.chrome.installUrl;
    if (installUrl) window.open(installUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const result = await api('/api/onboarding/lab/fix-chrome', {
      method: 'POST', body: JSON.stringify({ provider }),
    });
    state.status = result.status;
    toast('Chrome extension installed for this fake user');
    set();
  } catch (error) {
    toast((error as Error).message || 'Could not simulate the Chrome install.');
  }
}

export async function setOnboardingLabScenario(scenario: string): Promise<void> {
  try {
    const result = await api('/api/onboarding/lab', {
      method: 'POST', body: JSON.stringify({ scenario }),
    });
    state.status = result.status;
    state.connectors = result.connectors || [];
    state.onboarding = defaultOnboarding();
    state.onboardingLinkedInBusy = false;
    state.onboardingCheckingProvider = null;
    state.onboardingChromeChecking = false;
    state.onboardingStarting = false;
    state.view = 'onboarding';
    state.pop = null;
    set();
  } catch (error) {
    toast((error as Error).message || 'Could not reset the fake user.');
  }
}

const providerPolls = new Map<string, ReturnType<typeof setInterval>>();

function pollProvider(provider: string): void {
  const prior = providerPolls.get(provider);
  if (prior) clearInterval(prior);
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    await refreshStatus();
    const connected = provider === 'grok'
      ? !!state.status?.providers.grok?.webConnected
      : !!state.status?.providers[provider]?.ready;
    if (connected || attempts >= 80) {
      clearInterval(timer);
      providerPolls.delete(provider);
      state.connectingProviders[provider] = false;
      if (connected) {
        captureAnalytics('model_connection_completed', { provider });
        toast(`${state.status?.providers[provider]?.label || provider} connected`);
        void refreshModelUsage({ fresh: true });
      } else {
        captureAnalytics('model_connection_failed', { provider, failure_stage: 'detection_timeout' });
        toast(`${state.status?.providers[provider]?.label || provider} sign-in was not completed`);
      }
      set();
    }
  }, 1_500);
  providerPolls.set(provider, timer);
}

export async function connectProvider(provider: 'claude' | 'codex' | 'grok'): Promise<void> {
  const loginUrl = state.status?.providers[provider]?.loginUrl || PROVIDER_LOGIN[provider];
  // Claude and ChatGPT launch their official local OAuth flow from the server.
  // Grok is web-only today, so open its sign-in synchronously to avoid popup
  // blockers before recording the browser account connection.
  if (provider === 'grok' && loginUrl) window.open(loginUrl, '_blank', 'noopener,noreferrer');
  state.connectingProviders[provider] = true;
  captureAnalytics('model_connection_started', { provider });
  set();
  try {
    await api(`/api/providers/${provider}/connect`, { method: 'POST' });
    await refreshStatus();
    if (provider === 'grok') {
      const webProviders = [...new Set([...state.onboarding.webProviders, 'grok'])];
      updateOnboarding({ webProviders });
    }
    pollProvider(provider);
  } catch (e) {
    captureAnalytics('model_connection_failed', { provider });
    state.connectingProviders[provider] = false;
    toast((e as Error).message);
    set();
  }
}

export async function disconnectProvider(provider: 'claude' | 'codex' | 'grok'): Promise<void> {
  state.connectingProviders[provider] = true;
  set();
  try {
    await api(`/api/providers/${provider}/disconnect`, { method: 'POST' });
    if (provider === 'grok') updateOnboarding({ webProviders: state.onboarding.webProviders.filter((item) => item !== 'grok') });
    await refreshStatus();
    await refreshModelUsage({ fresh: true });
    captureAnalytics('model_disconnected', { provider });
    toast(`${state.status?.providers[provider]?.label || provider} signed out`);
  } catch (e) { toast((e as Error).message); }
  state.connectingProviders[provider] = false;
  set();
}

export function setBrowserControl(enabled: boolean): void {
  const byProvider = { claude: enabled, codex: enabled, grok: enabled };
  if (state.status?.chrome) {
    state.status.chrome.enabled = enabled;
    state.status.chrome.byProvider = byProvider;
  }
  saveDefault({ browserControlEnabled: enabled, browserControlByProvider: byProvider });
  set();
}

export function setProviderBrowserControl(provider: 'claude' | 'codex' | 'grok', enabled: boolean): void {
  const current = state.status?.chrome.byProvider || {};
  const byProvider = { ...current, [provider]: enabled };
  if (state.status?.chrome) {
    state.status.chrome.byProvider = byProvider;
    state.status.chrome.enabled = Object.values(byProvider).some(Boolean);
  }
  saveDefault({ browserControlByProvider: byProvider });
  set();
}

export async function refreshModelUsage({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  state.modelUsageLoading = true;
  state.modelUsageError = null;
  set();
  try {
    state.modelUsage = await api(`/api/model-usage${fresh ? '?fresh=1' : ''}`);
  } catch (error) {
    state.modelUsageError = (error as Error).message;
  }
  state.modelUsageLoading = false;
  set();
}

// ---------------------------------------------------------------------------
// Onboarding, Paper section 14: add your LinkedIn, the read, the answers, the
// choice. The read is asynchronous on the server; the greeting shows while it
// is still reading and fills in when it lands.

let onboardingReadPoll: number | null = null;

function stopOnboardingReadPoll(): void {
  if (onboardingReadPoll) window.clearTimeout(onboardingReadPoll);
  onboardingReadPoll = null;
}

export async function pollOnboardingRead(): Promise<void> {
  stopOnboardingReadPoll();
  try {
    const result = await api('/api/onboarding/read');
    state.onboarding = { ...state.onboarding, profile: result.profile ?? state.onboarding.profile, read: result.read ?? null };
    set();
  } catch { /* keep the last read we had */ }
  if (state.onboarding.read?.status === 'reading' && ['greeting', 'linkedin', 'directions'].includes(state.onboarding.step)) {
    onboardingReadPoll = window.setTimeout(() => { void pollOnboardingRead(); }, 1500);
  }
}

export async function submitOnboardingLinkedIn(url: string): Promise<void> {
  if (state.onboardingLinkedInBusy) return;
  state.onboardingLinkedInBusy = true;
  state.onboarding = { ...state.onboarding, linkedinUrl: url, chromeError: '' };
  set();
  try {
    const result = await api('/api/onboarding/linkedin', { method: 'POST', body: JSON.stringify({ url, provider: state.onboarding.selectedProvider || 'codex' }) });
    state.onboarding = { ...state.onboarding, linkedinUrl: url, profile: result.profile, read: result.read || null, chromeError: '' };
    captureAnalytics('onboarding_linkedin_resolved');
  } catch (e) {
    state.onboarding = { ...state.onboarding, chromeError: (e as Error).message || 'I could not read that profile.' };
    captureAnalytics('onboarding_linkedin_failed');
  }
  state.onboardingLinkedInBusy = false;
  set();
}

// The profile is confirmed (or skipped); the greeting opens and the read runs.
export async function continueToGreeting(): Promise<void> {
  updateOnboarding({ step: 'greeting', chromeError: '' });
  captureAnalytics('onboarding_greeting_opened', { has_profile: !!state.onboarding.profile });
  try {
    const result = await api('/api/onboarding/read', { method: 'POST', body: JSON.stringify({}) });
    state.onboarding = { ...state.onboarding, read: result.read || null };
    set();
  } catch { /* the poll will pick it up */ }
  void pollOnboardingRead();
}

export async function answerOnboarding(patch: Partial<typeof state.onboarding.answers>, { reread = false }: { reread?: boolean } = {}): Promise<void> {
  state.onboarding = { ...state.onboarding, answers: { ...state.onboarding.answers, ...patch } };
  set();
  try {
    const result = await api('/api/onboarding/answer', { method: 'POST', body: JSON.stringify({ ...state.onboarding.answers, reread }) });
    state.onboarding = { ...state.onboarding, answers: result.answers, read: result.read || state.onboarding.read };
    set();
    if (reread) void pollOnboardingRead();
  } catch (e) { toast((e as Error).message); }
}

export function continueToDirections(): void {
  captureAnalytics('onboarding_directions_opened', { answered_role: !!state.onboarding.answers.role, areas: state.onboarding.answers.areas.length, voice: state.onboarding.answers.voice || 'silent' });
  updateOnboarding({ step: 'directions' });
  if (state.onboarding.read?.status === 'reading') void pollOnboardingRead();
}

// Picking a direction ends onboarding: the platform opens on the work.
export async function startOnboardingDirection(choice: { direction?: number; custom?: string }): Promise<void> {
  if (state.onboardingStarting) return;
  state.onboardingStarting = true;
  stopOnboardingReadPoll();
  captureAnalytics('onboarding_direction_started', { custom: !!choice.custom, index: choice.direction ?? null });
  set();
  try {
    const result = await api('/api/onboarding/start', { method: 'POST', body: JSON.stringify(choice) });
    state.onboarding = { ...state.onboarding, complete: true, step: 'complete', firstTaskId: result.task.id, direction: choice.direction ?? null };
    state.cache[result.task.id] = result.task;
    await Promise.all([refreshProjects(), refreshThreads()]);
    await openThread(result.task.id);
    const tabId = result.task.activeTab || result.task.tabs?.[0]?.id;
    if (tabId) void runTab(result.task.id, tabId, result.prompt, result.model || defaultModelForProvider(state.onboarding.selectedProvider), { hiddenPrompt: true });
    captureAnalytics('onboarding_completed', { provider: state.onboarding.selectedProvider, custom: !!choice.custom });
  } catch (e) {
    toast((e as Error).message);
  }
  state.onboardingStarting = false;
  set();
}

// Archive as one-off, or make repeatable: the one fork after the first task.
export async function decideSignupFork(threadId: string, choice: 'archived' | 'repeat'): Promise<void> {
  try {
    const { task } = await api('/api/tasks/' + threadId, { method: 'PATCH', body: JSON.stringify(choice === 'repeat' ? { signupFork: choice, pinned: true } : { signupFork: choice }) });
    state.cache[threadId] = task;
    captureAnalytics('onboarding_fork', { choice });
    set();
    if (choice === 'archived') await archiveThread(threadId);
    else toast('Pinned. Press ⚡ on this tab to turn it into a play; for now it stays at the top of the rail.');
  } catch (e) { toast((e as Error).message); }
}

export async function refreshThreads(): Promise<void> {
  try { state.threads = (await api('/api/tasks')).tasks || []; } catch { /* ignore */ }
}

export async function refreshConnectors({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  if (state.connectorsRefreshing) return;
  state.connectorsRefreshing = true;
  set();
  try {
    state.connectors = (await api(`/api/connectors${fresh ? '?refresh=1' : ''}`)).connectors || [];
  } catch { /* ignore */ }
  state.connectorsLoaded = true;
  state.connectorsRefreshing = false;
  set();
}

// ---------------------------------------------------------------------------
// platform Context concierge

// The Connectors page. `fresh` forces a real re-scan of Claude and ChatGPT;
// Refresh on the page always does, and also updates the plain list the
// composer's paperclip and the rail count read from.
export function setMotionDemoLayer(layer: 'road' | 'ground' | 'edges', on: boolean): void {
  if (typeof location === 'undefined' || new URLSearchParams(location.search).get('motiondemo') !== '1') return;
  state.motion = { ...state.motion, [layer]: on };
  set();
}

export async function loadConnectorsOverview({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
  if (state.connectorsOverviewLoading) return;
  state.connectorsOverviewLoading = true;
  set();
  try {
    state.connectorsOverview = fresh
      ? await api('/api/connectors/refresh', { method: 'POST' })
      : await api('/api/connectors/overview');
    if (fresh) {
      state.connectors = (await api('/api/connectors')).connectors || [];
      state.connectorsLoaded = true;
    }
  } catch (e) { toast((e as Error).message); }
  state.connectorsOverviewLoading = false;
  set();
}

export async function refreshConnectorsOverview(): Promise<void> {
  await loadConnectorsOverview({ fresh: true });
  captureAnalytics('connectors_refreshed');
}

export async function loadPlatformContexts({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  if (!quiet) {
    state.contextConcierge.loading = true;
    state.contextConcierge.error = null;
    set();
  }
  try {
    const response = await api('/api/context');
    state.contextConcierge.platforms = response.platforms || [];
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
  }
  state.contextConcierge.loading = false;
  if (state.view === 'context') set();
}

export async function openPlatformContext(key: string): Promise<void> {
  captureAnalytics('context_platform_opened', { platform: key });
  state.view = 'context';
  state.contextConcierge.selected = key;
  state.contextConcierge.detail = null;
  state.contextConcierge.draft = '';
  state.contextConcierge.historyStaged = false;
  state.contextConcierge.justSaved = false;
  state.contextConcierge.showExamples = false;
  state.contextConcierge.error = null;
  state.contextConcierge.loading = true;
  set();
  try {
    const response = await api(`/api/context/${encodeURIComponent(key)}`);
    if (state.contextConcierge.selected === key) state.contextConcierge.detail = response.context || null;
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
  }
  state.contextConcierge.loading = false;
  set();
}

export function closePlatformContext(): void {
  if (state.contextConcierge.stream) return;
  state.contextConcierge.selected = null;
  state.contextConcierge.detail = null;
  state.contextConcierge.draft = '';
  state.contextConcierge.historyStaged = false;
  state.contextConcierge.justSaved = false;
  state.contextConcierge.showExamples = false;
  state.contextConcierge.error = null;
  set();
}

export function updatePlatformContextDraft(value: string): void {
  state.contextConcierge.draft = value;
  state.contextConcierge.error = null;
  set();
}

export function stagePlatformContextHistory(): void {
  const detail = state.contextConcierge.detail;
  if (!detail || state.contextConcierge.stream) return;
  if (!detail.access?.ready) {
    state.contextConcierge.error = detail.access?.detail || `Connect ${detail.name} before pulling examples.`;
    set();
    return;
  }
  state.contextConcierge.historyStaged = true;
  captureAnalytics('context_history_staged', { platform: detail.key || state.contextConcierge.selected || 'unknown' });
  state.contextConcierge.error = null;
  state.contextConcierge.draft = `Pull from my ${detail.name} history. Focus on `;
  set();
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-platform-context-composer]');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

export async function submitPlatformContext(): Promise<void> {
  const key = state.contextConcierge.selected;
  const detail = state.contextConcierge.detail;
  const prompt = state.contextConcierge.draft.trim();
  if (!key || !detail || !prompt || state.contextConcierge.stream) return;
  const mode = state.contextConcierge.historyStaged ? 'history' : 'manual';
  captureAnalytics('context_generation_started', { platform: key, mode });
  const stream: StreamState = {
    threadId: `context:${key}`,
    tabId: key,
    prompt,
    prompts: [prompt],
    hiddenPrompt: false,
    text: '',
    draftText: '',
    workNotes: [],
    tools: [],
    effort: state.effort,
    statusText: '',
    runId: null,
    model: null,
    connectors: [],
    computer: null,
  };
  state.contextConcierge.stream = stream;
  state.contextConcierge.draft = '';
  state.contextConcierge.historyStaged = false;
  state.contextConcierge.justSaved = false;
  state.contextConcierge.error = null;
  set();
  let receivedResult = false;
  try {
    const response = await fetch(`/api/context/${encodeURIComponent(key)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, mode, effort: state.effort }),
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      if (body.context) state.contextConcierge.detail = body.context;
      throw new Error(body.error || `Context run failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = chunk.split('\n').find((candidate) => candidate.startsWith('data: '));
        if (!line) continue;
        let event: any;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (event.type === 'context-result' && event.context) {
          receivedResult = true;
          state.contextConcierge.detail = event.context;
          state.contextConcierge.error = null;
          set();
        } else if (event.type === 'context-stopped') {
          state.contextConcierge.error = 'Context retrieval was interrupted. Your saved Context was not changed.';
          set();
        } else {
          const active = state.contextConcierge.stream;
          if (active) applyRunEvent(active, `context:${key}`, event, false);
        }
      }
    }
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
    if (!receivedResult && !state.contextConcierge.detail?.messages?.some((message) => message.content === prompt)) {
      state.contextConcierge.draft = prompt;
      state.contextConcierge.historyStaged = mode === 'history';
    }
    toast((error as Error).message);
  }
  const runError = state.contextConcierge.stream?.error;
  if (runError && !receivedResult) state.contextConcierge.error = runError;
  captureAnalytics(receivedResult ? 'context_generation_completed' : 'context_generation_failed', { platform: key, mode });
  state.contextConcierge.stream = null;
  await loadPlatformContexts({ quiet: true });
  set();
}

export async function lockPlatformContext(): Promise<void> {
  const key = state.contextConcierge.selected;
  if (!key || state.contextConcierge.stream) return;
  try {
    const response = await api(`/api/context/${encodeURIComponent(key)}/lock`, { method: 'POST' });
    state.contextConcierge.detail = response.context;
    state.contextConcierge.justSaved = true;
    state.contextConcierge.showExamples = false;
    state.contextConcierge.error = null;
    await loadPlatformContexts({ quiet: true });
    captureAnalytics('context_locked', {
      platform: key,
      entry_count: Array.isArray(response.context?.entries) ? response.context.entries.length : 0,
    });
    set();
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
    toast((error as Error).message);
    set();
  }
}

export function togglePlatformContextExamples(): void {
  state.contextConcierge.showExamples = !state.contextConcierge.showExamples;
  set();
}

async function applyPlatformContextSuggestionAction(action: 'stage' | 'clear', event: string): Promise<void> {
  const key = state.contextConcierge.selected;
  if (!key || state.contextConcierge.stream) return;
  try {
    const response = await api(`/api/context/${encodeURIComponent(key)}/suggestions/${action}`, { method: 'POST' });
    state.contextConcierge.detail = response.context;
    state.contextConcierge.justSaved = false;
    state.contextConcierge.error = null;
    captureAnalytics(event, { platform: key });
    await loadPlatformContexts({ quiet: true });
    set();
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
    toast((error as Error).message);
    set();
  }
}

export async function stagePlatformContextSuggestions(): Promise<void> {
  return applyPlatformContextSuggestionAction('stage', 'context_suggestions_staged');
}

export async function dismissPlatformContextSuggestions(): Promise<void> {
  return applyPlatformContextSuggestionAction('clear', 'context_suggestions_dismissed');
}

export async function stopPlatformContextRun(): Promise<void> {
  const key = state.contextConcierge.selected;
  if (!key || !state.contextConcierge.stream) return;
  try {
    await api(`/api/context/${encodeURIComponent(key)}/cancel`, { method: 'POST' });
  } catch (error) {
    state.contextConcierge.error = (error as Error).message;
    set();
  }
}

// Re-probe environment readiness — onboarding polls this after a "connect a
// model" action until the provider flips to connected.
export async function refreshStatus(): Promise<void> {
  try { state.status = await api('/api/status'); set(); } catch { /* ignore */ }
}
export async function refreshProjects(): Promise<void> {
  try { state.projects = (await api('/api/repos')).repos || []; } catch { /* ignore */ }
}
async function patchThread(threadId: string, patch: Record<string, unknown>): Promise<void> {
  const { task } = await api('/api/tasks/' + threadId, { method: 'PATCH', body: JSON.stringify(patch) });
  if (task) state.cache[threadId] = task;
  state.threads = (await api('/api/tasks')).tasks || [];
  set();
}

// Paper 20, tab level: Done is a bookend on the tab. Marking it stamps the
// day for the tray and collapses the tab out of the strip; Bring back
// restores it exactly where it was, unarchived and not done.
export async function setTabDone(threadId: string, tabId: string, done: boolean): Promise<void> {
  try {
    const { task } = await api(`/api/tasks/${threadId}/tabs/${tabId}`, { method: 'PATCH', body: JSON.stringify({ done }) });
    if (task) {
      state.cache[threadId] = task;
      for (const pane of state.panes) {
        if (pane.threadId === threadId && pane.tabId === tabId && task.activeTab !== tabId) pane.tabId = task.activeTab;
      }
    }
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function bringBackTab(threadId: string, tabId: string): Promise<void> {
  try {
    const summary = state.threads.find((t) => t.id === threadId);
    if (summary?.archived) await patchThread(threadId, { archived: false });
    if ((summary?.archivedTabs || []).some((tab) => tab.id === tabId)) {
      await api(`/api/tasks/${threadId}/tabs/${tabId}/restore`, { method: 'POST' });
    }
    const { task } = await api(`/api/tasks/${threadId}/tabs/${tabId}`, { method: 'PATCH', body: JSON.stringify({ done: false }) });
    if (task) state.cache[threadId] = task;
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}

// One parked row files itself: the same rule as Archive all, for one tab.
// A thread whose every live tab is done goes whole; otherwise just this tab.
export async function archiveDoneRow(threadId: string, tabId: string): Promise<void> {
  try {
    const row = state.threads.find((t) => t.id === threadId);
    if (!row || row.archived) return;
    if (row.done) {
      await patchThread(threadId, { archived: true });
    } else if (!(row.archivedTabs || []).some((tab) => tab.id === tabId)) {
      await api(`/api/tasks/${threadId}/tabs/${tabId}`, { method: 'DELETE' });
    }
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}

// A whole workstream parked in the shelf comes back with every live tab
// un-done, so it lands in the rail exactly as it left.
export async function bringBackThread(threadId: string): Promise<void> {
  try {
    const summary = state.threads.find((t) => t.id === threadId);
    if (summary?.archived) await patchThread(threadId, { archived: false });
    const archivedIds = new Set((summary?.archivedTabs || []).map((tab) => tab.id));
    for (const tab of summary?.doneTabs || []) {
      if (archivedIds.has(tab.id)) continue;
      const { task } = await api(`/api/tasks/${threadId}/tabs/${tab.id}`, { method: 'PATCH', body: JSON.stringify({ done: false }) });
      if (task) state.cache[threadId] = task;
    }
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}
export async function archiveDoneThread(threadId: string): Promise<void> {
  try {
    const row = state.threads.find((t) => t.id === threadId);
    if (!row || row.archived) return;
    await patchThread(threadId, { archived: true });
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}

// Archive all in the shelf: a thread whose every live tab is done goes whole;
// otherwise each done tab archives on its own and the live work stays put.
// Scoped to one project when the shelf is (the header names what it sweeps).
export async function archiveDoneToday(repo?: string): Promise<void> {
  const today = new Date().toDateString();
  try {
    for (const t of state.threads) {
      if (repo && t.repo !== repo) continue;
      const doneToday = (t.doneTabs || []).filter((tab) => tab.doneAt && new Date(tab.doneAt).toDateString() === today);
      if (!doneToday.length || t.archived) continue;
      if (t.done) {
        await patchThread(t.id, { archived: true });
        continue;
      }
      const archivedIds = new Set((t.archivedTabs || []).map((tab) => tab.id));
      for (const tab of doneToday) {
        if (archivedIds.has(tab.id)) continue;
        await api(`/api/tasks/${t.id}/tabs/${tab.id}`, { method: 'DELETE' });
      }
    }
    state.threads = (await api('/api/tasks')).tasks || [];
    set();
  } catch (e) { toast((e as Error).message); }
}

// Paper 20.1: macOS notifications, only when you are not looking. A clean
// landing tells you only when Supreme is not the front window (the tab going
// green is the notification when it is); a failure tells you either way, it
// is the only one that needs you; a turn that ends by asking waits, it does
// not celebrate. Clicking opens that thread; nothing else fires one.
function notifyRunOutcome(threadId: string, tabId: string, stream: (typeof state.streams)[string] | null | undefined, runStarted: boolean, durationSeconds: number): void {
  if (!stream) return;
  if (stream.statusText === 'Interrupted' || stream.saved?.stopped) return;
  const failed = !!stream.error || stream.saved?.ok === false || !runStarted;
  if (!failed && stream.saved?.waiting) return;
  // __supremeAssumeBackground is the smoke's stand-in for an unfocused
  // window; headless Chrome's focus semantics differ per version.
  const watching = document.hasFocus() && !(window as unknown as { __supremeAssumeBackground?: boolean }).__supremeAssumeBackground;
  if (!failed && watching) return;
  const task = state.cache[threadId];
  const thread = state.threads.find((t) => t.id === threadId)?.title || task?.title || 'Supreme';
  const tabName = (task?.tabs || []).length > 1 ? (task?.tabs || []).find((t) => t.id === tabId)?.name || '' : '';
  const title = tabName ? `${thread} / ${tabName}` : thread;
  const clean = (text: string) => text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
  const firstSentence = (text: string) => (clean(text).split(/(?<=[.!?])\s/)[0] || '').slice(0, 120);
  const minutes = Math.floor(durationSeconds / 60);
  const took = minutes ? `${minutes}m ${durationSeconds % 60}s` : `${durationSeconds}s`;
  const body = failed
    ? firstSentence(stream.error || '') || 'It stopped before finishing. Nothing sent without you.'
    : [firstSentence(stream.text || ''), `${took}.`].filter(Boolean).join(' ');
  const note = { title: failed ? `${title} stopped` : `${title} is done`, body, threadId, tabId };
  const host = window as unknown as { __supremeNotes?: (typeof note)[] };
  (host.__supremeNotes ||= []).push(note);
  if (host.__supremeNotes.length > 20) host.__supremeNotes.shift();
  const bridge = window.conductorDesktop;
  if (bridge?.notify) { void bridge.notify(note); return; }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const webNote = new Notification(note.title, { body: note.body });
    webNote.onclick = () => { window.focus(); void openThreadAt(threadId, tabId); };
  }
}

function markLandingSeen(threadId: string, tabId: string): void {
  const onScreen = state.view === 'tab' && state.panes.some((pane) => pane.threadId === threadId && (pane.tabId || state.cache[threadId]?.activeTab) === tabId);
  if (onScreen) markSeen(threadId, tabId);
}

// Coming back to the window is looking at whatever is on screen.
export function markOnScreenSeen(): void {
  if (state.view !== 'tab') return;
  for (const pane of state.panes) {
    const tabId = pane.tabId || state.cache[pane.threadId]?.activeTab;
    if (tabId) markSeen(pane.threadId, tabId);
  }
  set();
}

export async function openThreadAt(threadId: string, tabId?: string | null): Promise<void> {
  let paneIdx = state.view === 'tab'
    ? state.panes.findIndex((pane) => pane.threadId === threadId && (!tabId || pane.tabId === tabId))
    : -1;
  if (paneIdx < 0 && state.view === 'tab') paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId);
  if (paneIdx < 0) {
    await openThread(threadId);
    paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId && (!tabId || pane.tabId === tabId));
    if (paneIdx < 0) paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId);
  }
  if (paneIdx >= 0 && tabId) selectTab(paneIdx, tabId);
}

export async function loadTask(id: string): Promise<Task> {
  const d = await api('/api/tasks/' + id);
  state.cache[id] = d.task;
  // The poll's baseline for an idle tab is the copy the window loaded, so
  // a change on the server after this read is read back on the first
  // pulse, and a change this window makes to its own copy (the motion
  // demo's fake states, a send-time marker) is not clobbered by it.
  pulseSig.set(id, localPulseSignature(id, d.task));
  return d.task;
}

// ---------------------------------------------------------------------------
// Connected tabs (Paper page 8-2). The map is the workstream's tabs as
// cards; every write comes back with the whole map, read fresh.

export async function openMap(threadId: string): Promise<void> {
  saveCurrentLayout();
  state.view = 'map';
  state.mapRoot = threadId;
  state.openedFrom = null;
  state.pop = null;
  set();
  try { await loadTask(threadId); } catch (e) { toast((e as Error).message); }
  set();
}

export async function setMapOn(threadId: string, on: boolean): Promise<boolean> {
  try {
    const { task } = await api(`/api/tasks/${threadId}/map`, { method: on ? 'POST' : 'DELETE' });
    if (task) state.cache[threadId] = task;
    await refreshThreads();
    if (!on && state.view === 'map' && state.mapRoot === threadId) { state.view = 'maps'; state.mapRoot = null; }
    set();
    return true;
  } catch (e) { toast((e as Error).message); return false; }
}

// Section 27: a tab's type, Tab or Orchestrator (board 27.1). Setting the
// orchestrator turns the workstream's map on, server side.
export async function setTabType(threadId: string, tabId: string, type: 'tab' | 'orchestrator'): Promise<void> {
  try {
    const { task } = await api(`/api/tasks/${threadId}/tabs/${tabId}`, { method: 'PATCH', body: JSON.stringify({ type }) });
    if (task) state.cache[threadId] = task;
    await refreshThreads();
    set();
  } catch (e) { toast((e as Error).message); }
}

// Section 27: the person undoes one of the orchestrator's roster writes.
export async function undoTraffic(threadId: string, eventId: string): Promise<void> {
  try {
    const { task } = await api(`/api/tasks/${threadId}/traffic/${eventId}/undo`, { method: 'POST' });
    if (task) state.cache[threadId] = task;
    await refreshThreads();
    set();
  } catch (e) { toast((e as Error).message); }
}

// Board 2: the card's arrow opens the tab itself, and the tab says where it
// was opened from.
export async function openTabFromMap(mapThreadId: string, threadId: string, tabId: string): Promise<void> {
  const mapTask = state.cache[mapThreadId];
  await openThreadAt(threadId, tabId);
  state.openedFrom = { threadId, tabId, mapThreadId, title: mapTask?.title || mapTask?.repoName || 'the map' };
  set();
}

// The map on screen, re-read while it is open; applied only when it changed.
let mapRefreshBusy = false;
export async function refreshMap(): Promise<void> {
  const threadId = state.mapRoot;
  const task = threadId ? state.cache[threadId] : null;
  if (!threadId || !task || mapRefreshBusy) return;
  mapRefreshBusy = true;
  try {
    const { map, hiddenTabs } = await api(`/api/tasks/${threadId}/map`);
    if (state.mapRoot === threadId && map && (JSON.stringify(map) !== JSON.stringify(task.map) || JSON.stringify(hiddenTabs || []) !== JSON.stringify(task.mapHiddenTabs || []))) { task.map = map; task.mapHiddenTabs = hiddenTabs || []; set(); }
  } catch { /* the next tick tries again */ } finally { mapRefreshBusy = false; }
}

export function mapCardKey(threadId: string, tabId: string): string {
  return `${threadId}:${tabId}`;
}

function applyMap(mapThreadId: string, map: TabMap | undefined, hiddenTabs?: { id: string; name: string }[]): void {
  const task = state.cache[mapThreadId];
  if (task && map) task.map = map;
  if (task && hiddenTabs) task.mapHiddenTabs = hiddenTabs;
  set();
}

export async function saveMapCard(mapThreadId: string, key: string, patch: Partial<Pick<MapCard, 'x' | 'y' | 'minimized' | 'description' | 'tools' | 'skill'>>): Promise<void> {
  const card = state.cache[mapThreadId]?.map?.cards[key];
  if (card) { Object.assign(card, patch); set(); }
  try {
    const { map, hiddenTabs } = await api(`/api/tasks/${mapThreadId}/map/cards/${key}`, { method: 'PATCH', body: JSON.stringify(patch) });
    applyMap(mapThreadId, map, hiddenTabs);
  } catch (e) { toast((e as Error).message); }
}

export async function addMapCard(mapThreadId: string, threadId: string, tabId: string, x: number, y: number): Promise<MapCard | null> {
  const key = mapCardKey(threadId, tabId);
  try {
    const { map, hiddenTabs } = await api(`/api/tasks/${mapThreadId}/map/cards/${key}`, { method: 'PATCH', body: JSON.stringify({ x, y }) });
    applyMap(mapThreadId, map, hiddenTabs);
    return (map as TabMap).cards[key] || null;
  } catch (e) { toast((e as Error).message); return null; }
}

// Board 10, "Start a new tab here": a tab in this workstream, blank, which
// is a card on its own. Returns its id.
export async function newMapTab(mapThreadId: string): Promise<string | null> {
  const task = state.cache[mapThreadId];
  try {
    const { task: next, tab } = await api(`/api/tasks/${mapThreadId}/tabs`, { method: 'POST', body: JSON.stringify({ model: task?.model || state.homeModel, name: 'New tab' }) });
    state.cache[mapThreadId] = next;
    await refreshThreads();
    set();
    return tab?.id || null;
  } catch (e) { toast((e as Error).message); return null; }
}

export async function removeMapCard(mapThreadId: string, key: string): Promise<void> {
  try {
    const { map, hiddenTabs } = await api(`/api/tasks/${mapThreadId}/map/cards/${key}`, { method: 'DELETE' });
    applyMap(mapThreadId, map, hiddenTabs);
  } catch (e) { toast((e as Error).message); }
}

export async function connectMapTabs(mapThreadId: string, from: MapRef, to: MapRef, words: string): Promise<MapEdge | null> {
  try {
    const { map, edge } = await api(`/api/tasks/${mapThreadId}/map/edges`, { method: 'POST', body: JSON.stringify({ from: { threadId: from.threadId, tabId: from.tabId }, to: { threadId: to.threadId, tabId: to.tabId }, words }) });
    applyMap(mapThreadId, map);
    return edge || null;
  } catch (e) { toast((e as Error).message); return null; }
}

export async function rewordMapEdge(mapThreadId: string, edgeId: string, words: string): Promise<MapEdge | null> {
  try {
    const { map, edge } = await api(`/api/tasks/${mapThreadId}/map/edges/${edgeId}`, { method: 'PATCH', body: JSON.stringify({ words }) });
    applyMap(mapThreadId, map);
    return edge || null;
  } catch (e) { toast((e as Error).message); return null; }
}

export async function removeMapEdge(mapThreadId: string, edgeId: string): Promise<void> {
  try {
    const { map } = await api(`/api/tasks/${mapThreadId}/map/edges/${edgeId}`, { method: 'DELETE' });
    applyMap(mapThreadId, map);
  } catch (e) { toast((e as Error).message); }
}

const idlePolledAt = new Map<string, number>();
const pulseSig = new Map<string, string>();
const IDLE_POLL_MS = 3_000;

interface TabPulse { id: string; type?: string; status: string; messages: number; seq: number; folds: number; duel: string; queue: string[]; typing: string[]; remote: string }

// Section 27: the map, its traffic and a tab's type move without a message
// landing (the orchestrator writes its map mid turn, the person undoes it),
// so the pulse carries a map line beside the tabs.
function mapPulse(task: Task): string {
  const traffic = task.traffic || [];
  return `${Object.keys(task.map?.cards || {}).length}:${(task.map?.edges || []).length}:${traffic.length}:${traffic.filter((row) => row.undone).length}:${task.mapOff ? 1 : 0}`;
}

function pulseSignature(threadId: string, tabs: TabPulse[], map = ''): string {
  // A run streaming into this window is already current here tick by tick;
  // its sequence number is left out so the poll does not chase it.
  return JSON.stringify([map, ...tabs.map((tab) => [tab.id, tab.type || '', tab.status, tab.messages, state.streams[streamKey(threadId, tab.id)] ? 0 : tab.seq, tab.folds, tab.duel, tab.queue, tab.typing, tab.remote])]);
}

// The same shape from what this window holds, so a thread is read again when
// the window disagrees with the server as well as when the server moved: a
// send-time `running` marker outliving its run heals from the server copy.
function localPulseSignature(threadId: string, task: Task): string {
  return pulseSignature(threadId, (task.tabs || []).map((tab) => ({
    id: tab.id,
    type: tab.type || '',
    status: tab.status || 'idle',
    messages: tab.messages?.length || 0,
    seq: tab.activeRun?.seq || 0,
    folds: (tab.folds || []).length,
    duel: tab.duel?.phase || '',
    queue: (tab.queue || []).map((item) => `${item.id}:${item.status}:${item.online}`),
    typing: (tab.typing || []).map((typer) => typer.userId),
    remote: tab.activeRun?.remote?.name || '',
  })), mapPulse(task));
}

export async function refreshVisibleRuns(): Promise<void> {
  if ((state.view !== 'tab' && state.view !== 'landed') || document.hidden) return;
  const idleOnly = new Set<string>();
  const ids = [...new Set(state.panes.map((pane) => pane.threadId).filter((id) => {
    const task = state.cache[id];
    return task && (task.tabs || []).some((tab) => {
      const duelRunning = tab.type === 'duel' && duelPhase(tab) === 'running';
      // A `running` marker with no stream and no activeRun is the local
      // send-time flag outliving its run (the read-back at the end failed).
      // Keep polling such tabs so the cache converges on the server's truth.
      // A shared thread is polled while it is open, our own stream included:
      // the other person's turn, a queued message or their typing can start
      // at any moment (only their queue and typing are taken while we stream).
      const streaming = !!state.streams[streamKey(id, tab.id)];
      // Section 26: an idle tab on screen can receive a message from another
      // tab at any moment, so it is read back too, a little less often.
      const onScreenIdle = !streaming && !tab.activeRun && tab.status !== 'running'
        && state.panes.some((pane) => pane.threadId === id && (pane.tabId || task.activeTab) === tab.id)
        && Date.now() - (idlePolledAt.get(id) || 0) >= IDLE_POLL_MS;
      if (onScreenIdle && !(tab.activeRun || duelRunning || tab.status === 'running' || !!task.shared)) idleOnly.add(id);
      return (tab.activeRun || duelRunning || tab.status === 'running' || !!task.shared || onScreenIdle) && (!streaming || !!task.shared);
    });
  }))];
  if (!ids.length) return;
  let changed = false;
  const queuedReady: Array<{ threadId: string; tabId: string }> = [];
  await Promise.all(ids.map(async (id) => {
    try {
      idlePolledAt.set(id, Date.now());
      const before = state.cache[id];
      const teamSig = (tab: Task['tabs'][number]) => [(tab.queue || []).map((item) => `${item.id}:${item.status}:${item.online}`).join(','), (tab.typing || []).map((typer) => typer.userId).join(','), tab.activeRun?.remote?.name || ''];
      const beforeSig = JSON.stringify([mapPulse(before), ...(before.tabs || []).map((tab) => [tab.id, tab.type || '', tab.status, tab.messages?.length || 0, tab.activeRun?.seq || 0, tab.duel?.phase || '', ...teamSig(tab)])]);
      const pulsed = await api('/api/tasks/' + id + '/pulse');
      const pulse = pulseSignature(id, pulsed.tabs || [], pulsed.map || '');
      const known = pulseSig.get(id);
      if (idleOnly.has(id)) {
        // An idle tab's read-back only replaces what is on screen when the
        // server itself changed since the last read-back (a tab message
        // arrived, a teammate's turn landed); local state is left alone.
        // The baseline is recorded when the window loads the thread
        // (loadTask), so a change that landed on the server before the
        // first pulse (the orchestrator writing its map right after the
        // type was set) is read back, while a thread that reached the
        // cache another way takes its first pulse as the baseline and a
        // local-only change is never clobbered (2026-09-16).
        if (known === undefined) { pulseSig.set(id, pulse); return; }
        if (known === pulse) return;
      } else if (known === pulse && localPulseSignature(id, before) === pulse) return;
      const next = (await api('/api/tasks/' + id)).task;
      pulseSig.set(id, pulse);
      next.tabs = (next.tabs || []).map((tab: Task['tabs'][number]) => {
        if (!state.streams[streamKey(id, tab.id)]) return tab;
        const kept = (before.tabs || []).find((current) => current.id === tab.id);
        if (!kept) return tab;
        return { ...kept, queue: tab.queue, typing: tab.typing };
      });
      const afterSig = JSON.stringify([mapPulse(next), ...(next.tabs || []).map((tab: Task['tabs'][number]) => [tab.id, tab.type || '', tab.status, tab.messages?.length || 0, tab.activeRun?.seq || 0, tab.duel?.phase || '', ...teamSig(tab)])]);
      state.cache[id] = next;
      for (const tab of next.tabs || []) {
        // A turn that landed here from another Mac, with this tab on screen,
        // is looked at the same as one of ours.
        const prior = (before.tabs || []).find((current) => current.id === tab.id);
        if (prior && (tab.messages?.length || 0) > (prior.messages?.length || 0)) markLandingSeen(id, tab.id);
        for (const item of tab.queue || []) {
          if (item.mine && item.status === 'expired') void takeBackQueued(id, tab.id, item);
        }
        if (!tab.activeRun && !(tab.type === 'duel' && duelPhase(tab) === 'running')) {
          const key = streamKey(id, tab.id);
          delete state.stoppingRuns[key];
          if (state.queuedPrompts[key]?.length) queuedReady.push({ threadId: id, tabId: tab.id });
        }
      }
      if (beforeSig !== afterSig) changed = true;
    } catch { /* ignore */ }
  }));
  // Unkeyed on purpose: every open pane of this thread may need the new row.
  // Not forced: a conversation the reader scrolled up must not be yanked back
  // down every 1.2s because a sibling tab is running.
  if (changed) { set(); nudgeConv(); }
  queuedReady.forEach(({ threadId, tabId }) => runQueuedBatch(threadId, tabId));
}

// ---------------------------------------------------------------------------
// remote

export async function loadRemote({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  if (!quiet) { state.remote.loading = true; set(); }
  try {
    const data = await api('/api/remote');
    state.remote.machine = data.machine || null;
    state.remote.mobileApp = data.mobileApp || {
      installed: false, live: false, deviceName: null, appVersion: null, lastSeen: null,
    };
    state.remote.activeCount = data.activeCount || 0;
  } catch (e) {
    if (!quiet) toast((e as Error).message);
  }
  state.remote.loading = false;
  if (state.view === 'remote') set();
}

export type TestFlightInviteResult = {
  url: string | null;
  requested: boolean;
  delivery: 'email' | 'public-link' | 'queued' | 'none';
  status: 'invited' | 'resent' | 'already-invited' | 'connected' | 'link-ready' | 'queued';
  email: string;
  testerState?: string | null;
};

export async function requestTestFlight(email: string): Promise<TestFlightInviteResult> {
  return api('/api/remote/testflight', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// ---------------------------------------------------------------------------
// thread / pane actions

async function restoredPanesFor(rootId: string, rootTask: Task): Promise<Pane[]> {
  const fallback: Pane[] = [{ repo: rootTask.repo, threadId: rootId, tabId: rootTask.activeTab }];
  const saved = state.threadLayouts[rootId];
  const requested = Array.isArray(saved && saved.panes) ? saved.panes : [];
  if (!requested.length || !requested.some((pane) => pane.threadId === rootId)) return fallback;

  const tasks = new Map<string, Task>([[rootId, rootTask]]);
  await Promise.all([...new Set(requested.map((pane) => pane.threadId))].filter((id) => id && id !== rootId).map(async (id) => {
    try { tasks.set(id, await loadTask(id)); } catch { /* ignore */ }
  }));
  const panes = requested.flatMap<Pane>((savedPane) => {
    const task = tasks.get(savedPane.threadId);
    const project = task && state.projects.find((item) => item.path === task.repo);
    if (!task || task.archived || (project && project.archived)) return [];
    const tabs = task.tabs || [];
    const selected = tabs.some((tab) => tab.id === savedPane.tabId) ? savedPane.tabId : task.activeTab || (tabs[0] && tabs[0].id);
    if (!selected) return [];
    const width = Number(savedPane.width);
    return [{
      repo: task.repo,
      threadId: task.id,
      tabId: selected,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    }];
  });
  return panes.length && panes.some((pane) => pane.threadId === rootId) ? panes : fallback;
}

function quickPanesFor(rootId: string): Pane[] {
  const saved = state.threadLayouts[rootId];
  const requested = Array.isArray(saved?.panes) && saved.panes.some((pane) => pane.threadId === rootId) ? saved.panes : [{ threadId: rootId, tabId: null }];
  return adoptPanes(requested.map((pane) => {
    const task = state.cache[pane.threadId];
    const width = Number(pane.width);
    return {
      repo: task?.repo ?? state.threads.find((thread) => thread.id === pane.threadId)?.repo ?? null,
      threadId: pane.threadId,
      tabId: task && (task.tabs || []).some((tab) => tab.id === pane.tabId) ? pane.tabId : task?.activeTab || null,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    };
  }));
}

// A pane is keyed by identity: one already on screen for the same thread
// stays and takes the new tab and width, so it keeps its focus and scroll
// instead of remounting.
function adoptPanes(next: Pane[]): Pane[] {
  const spare = new Set(state.panes);
  return next.map((pane) => {
    const kept = [...spare].find((candidate) => candidate.threadId === pane.threadId && candidate.tabId === pane.tabId)
      || [...spare].find((candidate) => candidate.threadId === pane.threadId);
    if (!kept) return pane;
    spare.delete(kept);
    kept.repo = pane.repo;
    kept.tabId = pane.tabId;
    if (pane.width) kept.width = pane.width; else delete kept.width;
    return kept;
  });
}

export async function openThread(id: string): Promise<void> {
  saveCurrentLayout();
  state.view = 'tab';
  state.openedFrom = null;
  state.duelReview = null;
  state.layoutRoot = id;
  state.panes = quickPanesFor(id);
  state.diff = null;
  set();
  try {
    const task = await loadTask(id);
    touch(id, task.activeTab);
    view(id, task.activeTab);
    const panes = await restoredPanesFor(id, task);
    // The reader moved on while the threads were loading: leave their view alone.
    if (state.layoutRoot !== id || state.view !== 'tab') return;
    state.panes = adoptPanes(panes);
    state.diff = null;
    set();
    scrollConv();
  } catch (e) { toast((e as Error).message); }
}

export async function createThread(repoPath: string, title?: string): Promise<Task | null> {
  try {
    const project = state.projects.find((candidate) => candidate.path === repoPath);
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ repo: repoPath, projectId: project?.id, model: state.homeModel, title: title || 'New Workstream' }),
    });
    state.cache[task.id] = task;
    await refreshThreads();
    captureAnalytics('workstream_created');
    return task;
  } catch (e) { toast((e as Error).message); return null; }
}

export async function createNamedThread(repoPath: string): Promise<void> {
  const task = await createThread(repoPath, 'New Workstream');
  if (!task) return;
  await openThread(task.id);
  state.renaming = { kind: 'thread', id: task.id, paneIdx: 0, required: true };
  set();
}

export async function archiveProject(path: string, archived: boolean): Promise<void> {
  const project = state.projects.find((candidate) => candidate.path === path);
  if (archived) {
    const name = project?.name || 'this project';
    const workstreamCount = state.threads.filter((thread) => thread.repo === path && !thread.archived).length;
    if (!window.confirm(`Archive “${name}” and hide ${workstreamCount} workstream${workstreamCount === 1 ? '' : 's'}?\n\nEverything stays recoverable from Archived.`)) return;
  }
  try {
    saveCurrentLayout();
    await api('/api/repos', { method: 'PATCH', body: JSON.stringify({ path, archived }) });
    await refreshProjects();
    if (archived) {
      removeMatchingPanes((pane) => pane.repo === path);
      rebaseLayoutRoot();
      if (state.panes.length) saveCurrentLayout();
      if (!state.panes.length && state.view === 'tab') state.view = 'home';
      if (state.homeProject === path) state.homeProject = (state.projects.find((p) => !p.archived) || { path: null }).path || null;
    }
    toast(archived ? 'project archived' : 'project restored');
    captureAnalytics(archived ? 'project_archived' : 'project_restored', {
      workstream_count: state.threads.filter((thread) => thread.repo === path).length,
    });
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function deleteArchivedProject(path: string, { confirmed = false }: { confirmed?: boolean } = {}): Promise<void> {
  const project = state.projects.find((candidate) => candidate.path === path);
  if (!project?.archived) return;
  const threadIds = state.threads.filter((thread) => thread.repo === path).map((thread) => thread.id);
  const count = threadIds.length;
  if (!confirmed && !window.confirm(`Permanently delete “${project.name}” and ${count} workstream${count === 1 ? '' : 's'}?\n\nThis removes their tabs, transcripts, and attachments from Supreme and cannot be undone.`)) return;
  try {
    saveCurrentLayout();
    await api(`/api/repos?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    for (const threadId of threadIds) {
      delete state.cache[threadId];
      forgetThreadInLayouts(threadId);
    }
    removeMatchingPanes((pane) => pane.repo === path);
    rebaseLayoutRoot();
    if (state.panes.length) saveCurrentLayout();
    if (!state.panes.length && state.view === 'tab') state.view = 'home';
    if (state.homeProject === path) state.homeProject = null;
    await Promise.all([refreshProjects(), refreshThreads()]);
    if (!state.homeProject) state.homeProject = state.projects.find((candidate) => !candidate.archived)?.path || null;
    toast('project permanently deleted');
    captureAnalytics('project_deleted', { workstream_count: count });
    set();
  } catch (e) { toast((e as Error).message); }
}

// "Delete project" from a live project's right-click menu. The server only
// deletes archived projects, so archive first (one confirm covers both).
export async function deleteProject(path: string): Promise<void> {
  const project = state.projects.find((candidate) => candidate.path === path);
  if (!project) return;
  if (project.archived) return deleteArchivedProject(path);
  const count = state.threads.filter((thread) => thread.repo === path).length;
  if (!window.confirm(`Permanently delete “${project.name}” and ${count} workstream${count === 1 ? '' : 's'}?\n\nThis removes their tabs, transcripts, and attachments from Supreme and cannot be undone.`)) return;
  try {
    saveCurrentLayout();
    await api('/api/repos', { method: 'PATCH', body: JSON.stringify({ path, archived: true }) });
    await refreshProjects();
  } catch (e) { toast((e as Error).message); return; }
  await deleteArchivedProject(path, { confirmed: true });
}

export function beginProjectCreation(): void {
  state.pop = null;
  state.projectCreateOpen = true;
  set();
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-new-project-name]')?.focus());
}

export function cancelProjectCreation(): void {
  state.projectCreateOpen = false;
  set();
}

export async function addProject(name: string): Promise<boolean> {
  try {
    const projectName = String(name || '').trim();
    if (!projectName) return false;
    const payload = { name: projectName };
    const { repo } = await api('/api/repos', { method: 'POST', body: JSON.stringify(payload) });
    await refreshProjects();
    state.homeProject = repo.path;
    state.projectCreateOpen = false;
    savePrefs();
    toast('created ' + repo.name);
    captureAnalytics('project_created');
    set();
    return true;
  } catch (e) { toast((e as Error).message); return false; }
}

export async function newTab(threadId: string, model: string, paneIdx?: number): Promise<void> {
  try {
    const { task } = await api('/api/tasks/' + threadId + '/tabs', { method: 'POST', body: JSON.stringify({ model, name: 'New tab' }) });
    state.cache[threadId] = task;
    const requestedPane = Number.isInteger(paneIdx) ? state.panes[paneIdx as number] : null;
    const pane = requestedPane && requestedPane.threadId === threadId
      ? requestedPane
      : state.panes.find((p) => p.threadId === threadId);
    const targetPaneIdx = pane ? state.panes.indexOf(pane) : -1;
    if (pane) pane.tabId = task.activeTab;
    rememberModel(model);
    state.pop = null;
    captureAnalytics('tab_created', modelAnalyticsProperties(model));
    saveCurrentLayout();
    set();
    scrollConv(streamKey(threadId, task.activeTab));
    if (targetPaneIdx >= 0) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-draft="${targetPaneIdx}"]`)?.focus());
    }
  } catch (e) { toast((e as Error).message); }
}

export async function setTabModel(threadId: string, tabId: string, model: string): Promise<void> {
  try {
    const { task } = await api('/api/tasks/' + threadId + '/tabs/' + tabId, { method: 'PATCH', body: JSON.stringify({ model }) });
    state.cache[threadId] = task;
    rememberModel(model);
    state.pop = null;
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function archiveTab(threadId: string, tabId: string): Promise<void> {
  const current = state.cache[threadId];
  const cachedTab = ((current && current.tabs) || []).find((tab) => tab.id === tabId);
  const tabName = cachedTab?.name || 'this tab';
  // An empty tab just closes (the service deletes it); nothing to confirm.
  if (!emptyTab(cachedTab) && !confirm(`Archive “${tabName}”? You can restore the full conversation from Archived.`)) return;
  try {
    const { task, deletedTabId } = await api('/api/tasks/' + threadId + '/tabs/' + tabId, { method: 'DELETE' });
    state.cache[threadId] = task;
    delete state.queuedPrompts[streamKey(threadId, tabId)];
    if (state.duelReview?.threadId === threadId && state.duelReview.sourceTabId === tabId) state.duelReview = null;
    state.panes.forEach((pane, idx) => {
      if (pane.threadId === threadId && pane.tabId === tabId) {
        pane.tabId = task.activeTab;
        delete state.drafts[draftKey(idx)];
        delete state.contextMention[idx];
      }
    });
    await refreshThreads();
    state.pop = null;
    saveCurrentLayout();
    toast(deletedTabId ? 'empty tab closed' : 'tab archived');
    captureAnalytics(deletedTabId ? 'tab_deleted' : 'tab_archived');
    set();
    scrollConv(streamKey(threadId, task.activeTab));
  } catch (e) { toast((e as Error).message); }
}

// Paper 20.6: read an archived tab without restoring it. It shows in the
// strip dashed, the thread opens read-only at it, and switching away ends
// the peek. "Keep it open" (restore) is what makes it stay.
export async function peekArchivedTab(threadId: string, tabId: string): Promise<void> {
  try {
    if (!state.cache[threadId]) await loadTask(threadId);
    let paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId);
    if (paneIdx < 0) {
      await openThread(threadId);
      paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId);
    }
    if (paneIdx < 0) return;
    state.peeks[threadId] = tabId;
    state.panes[paneIdx].tabId = tabId;
    state.activePane = paneIdx;
    state.view = 'tab';
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function keepPeekedTab(threadId: string, tabId: string): Promise<void> {
  delete state.peeks[threadId];
  await restoreTab(threadId, tabId, null);
}

export async function restoreTab(threadId: string, tabId: string, paneIdx: number | null): Promise<void> {
  saveCurrentLayout();
  // Restoring the tab being peeked (from the rail's hover control) ends the
  // peek; the tab is live now.
  if (state.peeks[threadId] === tabId) delete state.peeks[threadId];
  try {
    const { task } = await api('/api/tasks/' + threadId + '/tabs/' + tabId + '/restore', { method: 'POST' });
    state.cache[threadId] = task;
    await refreshThreads();
    const requested = Number.isInteger(paneIdx) ? state.panes[paneIdx as number] : null;
    const pane = requested && requested.threadId === threadId
      ? requested
      : state.panes.find((candidate) => candidate.threadId === threadId);
    if (pane) {
      pane.tabId = tabId;
    } else {
      state.view = 'tab';
      state.layoutRoot = threadId;
      state.panes = [{ repo: task.repo, threadId, tabId }];
    }
    state.pop = null;
    saveCurrentLayout();
    toast('tab restored');
    set();
    scrollConv(streamKey(threadId, tabId));
  } catch (e) { toast((e as Error).message); }
}

export async function deleteArchivedTab(threadId: string, tabId: string): Promise<void> {
  const summary = state.threads.find((thread) => thread.id === threadId);
  const archived = summary?.archivedTabs?.find((tab) => tab.id === tabId);
  if (!archived) return;
  if (!window.confirm(`Permanently delete the archived tab “${archived.name}”?\n\nIts transcript and attachments cannot be recovered.`)) return;
  try {
    const { task } = await api(`/api/tasks/${threadId}/tabs/${tabId}/permanent`, { method: 'DELETE' });
    state.cache[threadId] = task;
    await refreshThreads();
    toast('tab permanently deleted');
    captureAnalytics('tab_deleted');
    set();
  } catch (e) { toast((e as Error).message); }
}

// Auto-contextualize (Paper 12.2 to 12.4): the tab folds its older turns on
// its own; the unfold is dropping the record. The transcript never changed.
export async function unfoldTab(threadId: string, tabId: string, foldId: string): Promise<void> {
  try {
    const { task, unfolded } = await api(`/api/tasks/${threadId}/tabs/${tabId}/folds/${foldId}`, { method: 'DELETE' });
    state.cache[threadId] = task;
    const count = unfolded?.count || 0;
    toast(count ? `${count} ${count === 1 ? 'message is' : 'messages are'} back in the model's window` : 'Unfolded');
    captureAnalytics('tab_unfolded', { count });
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function toggleConnectors(threadId: string): Promise<void> {
  const task = state.cache[threadId]; if (!task) return;
  try {
    const { task: updated } = await api('/api/tasks/' + threadId, { method: 'PATCH', body: JSON.stringify({ connectors: !task.connectors }) });
    state.cache[threadId] = updated;
    set();
  } catch (e) { toast((e as Error).message); }
}

// Presence v2: tell our service which shared tab this window is looking at.
// Deduped by signature and re-asserted every ~25s so the 5s presence frames
// keep carrying it.
let lastViewingSig = '';
let lastViewingAt = 0;
export async function loadSettings(): Promise<Record<string, unknown>> {
  return api('/api/settings');
}

// Add to Slack: the service mints the consent link (only when the Supreme
// Slack app is configured in its env); the desktop opens it. false means the
// button should not exist on this install.
export async function startSlackConnect(): Promise<boolean> {
  try {
    const res = await api('/api/slack/oauth/start') as { configured: boolean; url?: string };
    if (!res.configured || !res.url) return false;
    const desktop = window.conductorDesktop;
    if (desktop) await desktop.openExternalAuth(res.url);
    else window.open(res.url, '_blank', 'noopener');
    return true;
  } catch (e) { toast((e as Error).message); return true; }
}

// A saved token is not a working one: the service verifies it with Slack
// and only 'ok' (or a check still pending) counts as connected.
export function slackUsable(slack: unknown): boolean {
  const s = (slack || {}) as { botToken?: string; health?: { state?: string } };
  if (!s.botToken) return false;
  const state = s.health?.state || '';
  return state !== 'unset' && state !== 'rejected';
}

export async function saveSlackSettings(slack: Record<string, unknown>): Promise<{ state?: string; team?: string; error?: string } | null> {
  try {
    const res = await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ slack }) }) as { slack?: { health?: { state?: string; team?: string; error?: string } } };
    const health = res.slack?.health || null;
    if (typeof slack.botToken === 'string') { state.slackReady = !!slack.botToken && health?.state !== 'rejected'; set(); }
    if (health?.state === 'rejected') toast('Slack rejected that token. Check it is the Bot User OAuth Token (xoxb-…).');
    else if (health?.state === 'ok') toast(`Slack connected${health.team ? ` to ${health.team}` : ''}`);
    else toast('Slack settings saved');
    return health;
  } catch (e) { toast((e as Error).message); return null; }
}

export function reportViewing(): void {
  const pane = state.panes[state.activePane || 0];
  const task = pane ? state.cache[pane.threadId] : null;
  if (!task?.shared) { lastViewingSig = ''; return; }
  const tabId = pane?.tabId || task.activeTab || '';
  const sig = `${task.id}::${tabId}`;
  if (sig === lastViewingSig && Date.now() - lastViewingAt < 25_000) return;
  lastViewingSig = sig;
  lastViewingAt = Date.now();
  void api(`/api/tasks/${task.id}/tabs/${tabId}/viewing`, { method: 'POST' }).catch(() => {});
}

export function selectTab(paneIdx: number, tabId: string): void {
  const pane = state.panes[paneIdx]; if (!pane) return;
  state.activePane = paneIdx;
  if (state.openedFrom && (state.openedFrom.threadId !== pane.threadId || state.openedFrom.tabId !== tabId)) state.openedFrom = null;
  if (state.duelReview?.paneIdx === paneIdx) state.duelReview = null;
  // Paper 20.6: a peeked archived tab goes when you switch away.
  if (state.peeks[pane.threadId] && state.peeks[pane.threadId] !== tabId) delete state.peeks[pane.threadId];
  pane.tabId = tabId;
  const task = state.cache[pane.threadId]; if (task) task.activeTab = tabId;
  touch(pane.threadId, tabId);
  view(pane.threadId, tabId);
  state.pop = null;
  saveCurrentLayout();
  set(); scrollConv(streamKey(pane.threadId, tabId));
}

// ---------------------------------------------------------------------------
// run (SSE)

export interface TabRunRef {
  key: string;
  threadId: string;
  tabId: string;
  runId: string | null;
  duel: boolean;
}

export function streamKey(threadId: string, tabId: string): string {
  return `${threadId}::${tabId}`;
}

// Lap finish (up to 600ms) + ring lights green (160ms) + hold (700ms) + 900ms
// before the card collapses. Kept in step with the run card's landing timers.
export const LANDING_MS = 2_400;

type LandingGate = {
  stream: StreamState;
  cancel: () => void;
  done: Promise<void>;
  settle: () => void;
};

// A message sent during the visual landing cancels the hold, then waits for
// that finished turn's transcript read-back before starting the next run. This
// keeps the previous turn visible and prevents its late refresh from replacing
// a newer cache snapshot.
const landingGates = new Map<string, LandingGate>();

export function tabRunRef(task: Task, tab: Tab): TabRunRef | null {
  const key = streamKey(task.id, tab.id);
  // A landed stream (Paper 16.6, the card finishing its lap) is a finished
  // turn still on screen, not something to steer: the tab is idle to type into.
  const held = state.streams[key] || null;
  const local = held && !held.landed ? held : null;
  // Same team: a run on another person's Mac is not ours to steer or stop;
  // a message typed under it queues (runTab's 202 path).
  const persisted = held?.landed || tab.activeRun?.remote ? null : tab.activeRun;
  const duelRunning = tab.type === 'duel' && duelPhase(tab) === 'running';
  const run = local || persisted || null;
  if (!run && !duelRunning) return null;
  return {
    key,
    threadId: task.id,
    tabId: tab.id,
    runId: local?.runId || persisted?.id || null,
    duel: duelRunning,
  };
}

function paneRunRef(paneIdx: number): TabRunRef | null {
  const ctx = paneTaskTab(paneIdx);
  return ctx?.tab ? tabRunRef(ctx.task, ctx.tab) : null;
}

function allRunRefs(): TabRunRef[] {
  const refs = new Map<string, TabRunRef>();
  for (const task of Object.values(state.cache)) {
    for (const tab of task.tabs || []) {
      const ref = tabRunRef(task, tab);
      if (ref) refs.set(ref.key, ref);
    }
  }
  return [...refs.values()];
}

export async function stopTabRun(threadId: string, tabId: string): Promise<void> {
  const key = streamKey(threadId, tabId);
  if (state.stoppingRuns[key]) return;
  state.stoppingRuns[key] = true;
  const local = state.streams[key];
  const task = state.cache[threadId];
  const tab = task && (task.tabs || []).find((candidate) => candidate.id === tabId);
  const runId = local?.runId || tab?.activeRun?.id || null;
  if (local) local.statusText = 'Interrupting…';
  set();
  try {
    await api(`/api/tasks/${threadId}/tabs/${tabId}/cancel`, { method: 'POST' });
  } catch (e) {
    // A static frontend can update before the local Node process is restarted.
    // Fall back to the route supported by the previous backend so Stop never
    // becomes a dead control during that rolling update.
    if (runId) {
      try {
        await api(`/api/runs/${runId}/cancel`, { method: 'POST' });
      } catch (fallbackError) {
        delete state.stoppingRuns[key];
        toast((fallbackError as Error).message || (e as Error).message);
        return;
      }
    } else {
      delete state.stoppingRuns[key];
      toast((e as Error).message);
      return;
    }
  }
  captureAnalytics('run_interrupt_requested', {
    interruption_method: 'button_or_escape',
    ...modelAnalyticsProperties(local?.model || tab?.model),
  });
  setTimeout(async () => {
    try { await loadTask(threadId); } catch { /* ignore */ }
    const task = state.cache[threadId];
    const tab = task && (task.tabs || []).find((candidate) => candidate.id === tabId);
    if (!tab || (!tab.activeRun && !(tab.type === 'duel' && duelPhase(tab) === 'running'))) {
      delete state.stoppingRuns[key];
    }
    set();
  }, 800);
}

export function handleGlobalKeyDown(e: KeyboardEvent): void {
  // Command K works in the composer too, without touching its draft. A
  // protected dialog owns its keys; closing search never cancels a run.
  const searchBlocked = !state.authReady || !!(state.authConfigured && !state.session) || state.view === 'onboarding' || !!(state.shareDialog || state.renaming || state.projectCreateOpen || state.drag || state.pop) || !!document.querySelector('[role="dialog"]:not([data-workspace-search]), [role="menu"], .share-scrim');
  if (workspaceSearchShortcut(e, searchBlocked)) {
    e.preventDefault(); state.workspaceSearchOpen = !state.workspaceSearchOpen; set(); return;
  }
  if (state.workspaceSearchOpen) return;
  // A tab's slash is transcript search. Editors keep literal slash input,
  // and closing search must never interrupt a model or confirm an action.
  if (state.view === 'tab' && !e.defaultPrevented) {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    const blocked = !!(state.pop || state.shareDialog || state.renaming || state.projectCreateOpen || state.drag || document.querySelector('[role="dialog"], [role="menu"], .scrim, .share-scrim'));
    if (state.tabSearch && e.key === 'Escape' && !blocked && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      e.preventDefault(); state.tabSearch = null; set(); return;
    }
    if (tabSearchShortcut(e, { typing, blocked })) {
      const pane = state.panes[state.activePane];
      const task = pane ? state.cache[pane.threadId] : null;
      const tabId = pane?.tabId || task?.activeTab;
      const tab = task?.tabs.find((candidate) => candidate.id === tabId) || task?.archivedTabs?.find((candidate) => candidate.id === tabId);
      if (pane && tab && tab.type !== 'duel' && !tab.duel?.choice && !state.contextOpen[state.activePane]) {
        e.preventDefault();
        const key = `${pane.threadId}::${tab.id}`;
        state.tabSearch = state.tabSearch?.key === key ? state.tabSearch : { key, query: '', selected: 0 };
        set();
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-tab-find-input]')?.focus());
        return;
      }
    }
  }
  // Landed is keyboard-first when reading, but editors and overlays own
  // their keys. Completing a result never confirms an external action.
  if (state.view === 'landed' && !e.defaultPrevented) {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    const blocked = !!(state.pop || state.shareDialog || state.renaming || state.projectCreateOpen || state.drag || document.querySelector('[role="dialog"], [role="menu"], .scrim, .share-scrim'));
    const command = landedShortcut(e, { typing, blocked, searchOpen: state.landedSearchOpen });
    if (command) {
      e.preventDefault();
      if (command === 'search') landedSearch(true);
      if (command === 'previous' || command === 'next') landedStep(command === 'next' ? 1 : -1);
      if (command === 'complete') landedComplete();
      if (command === 'exit') landedExit();
      if (command === 'blur') target?.blur();
      if (command === 'up' || command === 'down') {
        const conv = document.querySelector<HTMLElement>('[data-landed] .conv');
        if (conv) {
          cancelConversationLanding(conv);
          conv.scrollBy({ top: command === 'down' ? 100 : -100, behavior: 'instant' });
          trackConversationScroll(conv);
        }
      }
      return;
    }
  }
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (state.pop) {
    e.preventDefault();
    state.pop = null;
    set();
    return;
  }
  if (state.renaming) return;
  if (state.view === 'remote') return;
  if (state.view === 'context') {
    if (!state.contextConcierge.stream) return;
    e.preventDefault();
    void stopPlatformContextRun();
    return;
  }
  if (state.view !== 'tab') return;
  const paneIdx = Math.max(0, Math.min(Number(state.activePane) || 0, state.panes.length - 1));
  let ref = paneRunRef(paneIdx);
  if (!ref) {
    const refs = allRunRefs();
    if (refs.length === 1) ref = refs[0];
  }
  if (!ref) return;
  e.preventDefault();
  stopTabRun(ref.threadId, ref.tabId);
}

function runQueuedBatch(threadId: string, tabId: string, retryBlocked = false): void {
  const key = streamKey(threadId, tabId);
  const queued = state.queuedPrompts[key];
  const task = state.cache[threadId];
  const tab = (task?.tabs || []).find((candidate) => candidate.id === tabId);
  if (!queued?.length || !tab || state.streams[key] || tab.activeRun) return;
  // A failed start is a saved message, not permission to keep resending it
  // whenever a pulse, a sibling turn, or the database comes back.
  if (!retryBlocked && queued.some((item) => !!item.error)) return;
  const batch = queued.splice(0, queued.length);
  delete state.queuedPrompts[key];
  steerQueueFallback.delete(key);
  const model = [...batch].reverse().find((item) => item.model)?.model || tab.model;
  const contextBySource = new Map<string, TerminalContext>();
  batch.forEach((item, index) => (item.terminalContexts || []).forEach((context) => {
    const sourceKey = `${context.sourceTaskId}:${context.sourceTabId}`;
    const direction = `Message ${index + 1}: ${item.prompt}`;
    const prior = contextBySource.get(sourceKey);
    contextBySource.set(sourceKey, prior
      ? { ...prior, guidance: `${prior.guidance || ''}\n${direction}`.trim() }
      : { ...context, guidance: direction });
  }));
  const terminalContexts = [...contextBySource.values()];
  const images = batch.flatMap((item, promptIndex) => (item.attachments || []).map((attachment) => ({ ...attachment, promptIndex })));
  // The chips from every queued message ride the batch, each person once.
  const mentions = [...new Map(batch.flatMap((item) => item.mentions || []).map((row) => [row.email.toLowerCase(), row])).values()];
  const contextMentions = [...new Set(batch.flatMap((item) => item.contextMentions || []))];
  set();
  void runTab(threadId, tabId, batch.map((item) => item.prompt), model, { terminalContexts, images, ...(mentions.length ? { mentions } : {}), ...(contextMentions.length ? { contextMentions } : {}) });
}

export function retryBlockedPrompts(threadId: string, tabId: string): void {
  runQueuedBatch(threadId, tabId, true);
}

export function takeBackBlockedPrompt(threadId: string, tabId: string, id: string): void {
  const key = streamKey(threadId, tabId);
  const item = state.queuedPrompts[key]?.find((candidate) => candidate.id === id && candidate.error);
  if (!item) return;
  // Preserve any newer draft rather than replacing it with the failed send.
  const existing = state.drafts[key] || '';
  state.drafts[key] = existing ? `${existing}\n\n${item.prompt}` : item.prompt;
  state.pendingImages[key] = [...(state.pendingImages[key] || []), ...(item.attachments || [])];
  state.pendingTerminalContexts[key] = [...(state.pendingTerminalContexts[key] || []), ...(item.terminalContexts || [])];
  state.pendingPings[key] = [...new Map([...(state.pendingPings[key] || []), ...(item.mentions || [])].map((person) => [person.email.toLowerCase(), person])).values()];
  state.pendingContextRefs[key] = [...new Set([...(state.pendingContextRefs[key] || []), ...(item.contextMentions || [])])];
  state.queuedPrompts[key] = state.queuedPrompts[key].filter((candidate) => candidate.id !== id);
  if (!state.queuedPrompts[key].length) delete state.queuedPrompts[key];
  saveBlockedPrompts();
  set();
}

export async function runTab(threadId: string, tabId: string, prompt: string | string[], model?: string, options: { hiddenPrompt?: boolean; terminalContexts?: TerminalContext[]; images?: PendingImageAttachment[]; handoffFrom?: { tabId: string; threadId?: string }; redo?: boolean; mentions?: { email: string; name: string }[]; contextMentions?: string[] } = {}): Promise<void> {
  const key = streamKey(threadId, tabId);
  const priorLanding = landingGates.get(key);
  if (priorLanding) {
    priorLanding.cancel();
    await priorLanding.done;
  }
  // A new message cuts a landing short: the finished turn is already saved,
  // its finish path just drops the held stream again and re-reads the tab.
  const interruptedLanding = !!state.streams[key]?.landed;
  if (interruptedLanding) delete state.streams[key];
  if (state.streams[key]) { toast('this tab is already streaming'); return; }
  const task = state.cache[threadId];
  const tab = (task.tabs || []).find((t) => t.id === tabId);
  if (!tab) return;
  // Same team: a run on another person's Mac does not lock this composer;
  // the message queues behind it (the service answers 202).
  if (tab.activeRun && !tab.activeRun.remote && !interruptedLanding) { toast('this tab is already working'); return; }
  const prompts = (Array.isArray(prompt) ? prompt : [prompt]).map((value) => value.trim()).filter(Boolean);
  if (!prompts.length) return;
  const displayPrompt = prompts.length === 1
    ? prompts[0]
    : prompts.map((value, index) => `Message ${index + 1}:\n${value}`).join('\n\n');
  tab.status = 'running'; task.status = 'running';
  // The rail reads the thread list, not the cache, and that list only refreshes
  // when something else happens in the app. Mark the row running now so the
  // rail moves the moment the tab does.
  const row = state.threads.find((thread) => thread.id === threadId);
  if (row) { row.status = 'running'; row.lastActivity = new Date().toISOString(); }
  touch(threadId, tabId);
  const terminalContexts = (options.terminalContexts || []).map((context) => ({ ...context }));
  const images = (options.images || []).map((image) => ({ ...image }));
  state.streams[key] = { threadId, tabId, prompt: displayPrompt, prompts, hiddenPrompt: !!options.hiddenPrompt, terminalContexts, attachments: images, mentions: options.mentions || [], contextRefs: options.contextMentions || [], text: '', draftText: '', workNotes: [], tools: [], effort: state.effort, statusText: '', runId: null, startedAt: new Date().toISOString(), model: model || tab.model };
  const startedAt = Date.now();
  const baseRunProperties = {
    ...modelAnalyticsProperties(model || tab.model),
    effort: state.effort,
    prompt_count: prompts.length,
    attachment_count: images.length,
    has_attachments: images.length > 0,
    has_context: terminalContexts.length > 0,
    hidden_prompt: !!options.hiddenPrompt,
  };
  set();
  scrollConv(key);
  let runStarted = false;
  let admissionAccepted = false;
  let restoreFailure = false;
  try {
    const res = await fetch('/api/tasks/' + threadId + '/tabs/' + tabId + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: displayPrompt, prompts, model, effort: state.effort, hiddenPrompt: !!options.hiddenPrompt, terminalContexts, images, ...(options.handoffFrom ? { handoffFrom: options.handoffFrom } : {}), ...(options.redo ? { redo: true } : {}), ...(options.mentions?.length ? { mentions: options.mentions } : {}), ...(options.contextMentions?.length ? { contextMentions: options.contextMentions } : {}) }),
    });
    admissionAccepted = res.ok;
    if (res.status === 202) {
      // Same team: another Mac holds this thread's turn. The message is a
      // queued row both sides see; it runs here once that turn lands.
      if (state.streams[key]) delete state.streams[key];
      await loadTask(threadId).catch(() => {});
      const current = (state.cache[threadId]?.tabs || []).find((t) => t.id === tabId);
      if (current && !current.activeRun) current.status = 'idle';
      if (row) row.status = current?.status || 'idle';
      saveBlockedPrompts();
      set();
      followConv(key);
      return;
    }
    if (!res.ok || !res.body) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || 'run failed (' + res.status + ')');
    }
    saveBlockedPrompts();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!dl) continue;
        let ev: RunEvent;
        try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
        if (ev.type === 'start' && !runStarted) {
          runStarted = true;
          captureAnalytics('run_started', {
            ...baseRunProperties,
            ...modelAnalyticsProperties(String(ev.model || model || tab.model)),
          });
        }
        onRunEvent(key, ev);
      }
    }
  } catch (e) {
    if (state.streams[key]) state.streams[key].error = (e as Error).message;
    restoreFailure = !admissionAccepted && !runStarted && !options.hiddenPrompt;
    if (restoreFailure) {
      const restored = prompts.map((value, index) => ({
          id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`,
          prompt: value,
          model: model || tab.model,
          queuedAt: new Date().toISOString(),
          error: (e as Error).message,
          terminalContexts: terminalContexts.map((context) => ({ ...context })),
          attachments: images.filter((image) => Number(image.promptIndex || 0) === index).map((image) => ({ ...image, promptIndex: 0 })),
          mentions: options.mentions,
          contextMentions: options.contextMentions,
        }));
      state.queuedPrompts[key] = [...restored, ...(state.queuedPrompts[key] || [])];
      saveBlockedPrompts();
    }
    toast((e as Error).message);
  }
  const finishedStream = state.streams[key];
  const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const completionProperties = {
    ...baseRunProperties,
    ...modelAnalyticsProperties(finishedStream?.model || model || tab.model),
    duration_seconds: durationSeconds,
    tool_count: finishedStream?.tools?.length || 0,
    connector_count: finishedStream?.connectors?.length || 0,
    used_computer: !!finishedStream?.computer,
  };
  if (finishedStream?.statusText === 'Interrupted') captureAnalytics('run_interrupted', completionProperties);
  else if (finishedStream?.error || !runStarted) captureAnalytics('run_failed', { ...completionProperties, failure_stage: runStarted ? 'stream' : 'start' });
  else captureAnalytics('run_completed', completionProperties);
  notifyRunOutcome(threadId, tabId, finishedStream, runStarted, durationSeconds);
  markLandingSeen(threadId, tabId);
  // Paper 16.6: let the turn land before the transcript takes over. The live
  // run card finishes its lap, lights green, settles to a 1px border and
  // collapses to one result line, which takes up to 2.4s. Only a turn that
  // finished cleanly lands; an interrupted or failed one stops dead as before.
  const landing = finishedStream && runStarted && !finishedStream.error
    && finishedStream.saved?.ok !== false && !finishedStream.saved?.stopped
    && finishedStream.statusText !== 'Interrupted';
  let ownedLanding: LandingGate | null = null;
  if (landing && finishedStream) {
    const green = !finishedStream.saved?.waiting;
    finishedStream.landed = { at: Date.now(), green };
    if (finishedStream.computer && finishedStream.computer.state === 'active') finishedStream.computer = { ...finishedStream.computer, state: 'released' };
    finishedStream.connectors = (finishedStream.connectors || []).map((item) => (item.state === 'active' ? { ...item, state: 'done' } : item));
    const hadCard = !!(finishedStream.computer || finishedStream.connectors?.length || finishedStream.tools.length);
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    let cancel = () => {};
    let hold = Promise.resolve();
    if (hadCard && !reduced) {
      hold = new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, LANDING_MS);
        cancel = () => { window.clearTimeout(timer); resolve(); };
      });
    }
    ownedLanding = { stream: finishedStream, cancel, done, settle };
    landingGates.set(key, ownedLanding);
    set();
    await hold;
  }
  // Only drop the stream this run held: a message sent during the landing
  // may already have started the next one under the same key.
  if (state.streams[key] === finishedStream) delete state.streams[key];
  delete state.stoppingRuns[key];
  // The workstream is touched by its run; the tab already was at send time,
  // and its reply's own time keeps it awake. Stamping the tab again here
  // would date "looked at" after the landing, and the rail could never call
  // an off-screen landing new.
  touch(threadId);
  // Read the finished turn back. One failed read here used to leave the tab's
  // send-time `running` marker in place for good, so retry with a short
  // backoff; refreshVisibleRuns keeps polling if every attempt fails.
  for (const delay of [0, 400, 1_500, 4_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try { await loadTask(threadId); await refreshThreads(); break; } catch { /* retry */ }
  }
  if (ownedLanding) {
    if (landingGates.get(key) === ownedLanding) landingGates.delete(key);
    ownedLanding.settle();
  }
  set();
  followConv(key);
  if (!restoreFailure) runQueuedBatch(threadId, tabId);
}

// SSE events are dynamic (no `event:` line; discriminate on `type`). Typed loose,
// matching the vanilla handler.
function applyRunEvent(stream: StreamState, key: string, ev: any, follow = true): void {
  if (ev.type === 'start') {
    stream.runId = ev.runId || null;
    stream.play = ev.play || null;
    stream.model = ev.model || null;
    stream.requestedModel = ev.requestedModel || ev.model || null;
    stream.recommendation = ev.recommendation || null;
    stream.handoff = ev.handoff || null;
    stream.handedFrom = ev.handedFrom || null;
    stream.scheduled = ev.scheduled || null;
    if (ev.effort) stream.effort = ev.effort;
    if (Array.isArray(ev.terminalContexts)) stream.terminalContexts = ev.terminalContexts;
    if (Array.isArray(ev.attachments)) stream.attachments = ev.attachments;
    if (Array.isArray(ev.prompts) && ev.prompts.length) stream.prompts = ev.prompts.map((value: unknown) => String(value));
    if (typeof ev.hiddenPrompt === 'boolean') stream.hiddenPrompt = ev.hiddenPrompt;
    if (Array.isArray(ev.mentions)) stream.mentions = ev.mentions;
    if (Array.isArray(ev.contextRefs)) stream.contextRefs = ev.contextRefs;
    set();
  } else if (ev.type === 'pings') {
    // How each person chip's Slack ping went: on the live card, and said out
    // loud once, so a mention never looks like nothing happened.
    const pinged = Array.isArray(ev.pings) ? ev.pings as { name?: string; email: string; ok: boolean; error?: string }[] : [];
    // A ping that rode a steer lands on that steer's card, not the first turn's.
    const steerId = typeof ev.steerId === 'string' ? ev.steerId : '';
    const steer = steerId ? (stream.steers || []).find((item) => item.id === steerId) : null;
    if (steer) steer.pings = pinged;
    else if (!steerId) stream.pings = pinged;
    for (const ping of pinged) {
      toast(ping.ok ? `Sent to ${ping.name || ping.email} in Slack` : `Could not ping ${ping.name || ping.email}: ${ping.error || 'Slack refused it'}`);
    }
    setStream(undefined, key);
  } else if (ev.type === 'candidate-reset') {
    stream.draftText = '';
    setStream(undefined, key);
  } else if (ev.type === 'candidate-delta') {
    stream.draftText += ev.text || '';
    setStream(undefined, key);
    if (follow) followConv(key);
  } else if (ev.type === 'progress') {
    const note = String(ev.text || '').trim();
    if (note) stream.workNotes.push(note);
    if (stream.workNotes.length > 50) stream.workNotes.splice(0, stream.workNotes.length - 50);
    stream.draftText = '';
    setStream(undefined, key);
    if (follow) followConv(key);
  } else if (ev.type === 'interim') {
    // The answer to the earlier message, split off when a follow-up landed.
    const interims = stream.interims || (stream.interims = []);
    interims.push({ id: ev.steerId || null, text: String(ev.text || ''), at: ev.at });
    stream.draftText = '';
    setStream(undefined, key);
    if (follow) followConv(key);
  } else if (ev.type === 'steer') {
    const next = ev as SteeredPrompt;
    const steers = stream.steers || (stream.steers = []);
    const index = steers.findIndex((item) => item.id === next.id);
    if (index >= 0) steers[index] = { ...next, delivery: 'accepted' };
    else steers.push({ ...next, delivery: 'accepted' });
    setStream(undefined, key);
    if (follow) followConv(key);
  } else if (ev.type === 'delta') {
    stream.text += ev.text || '';
    stream.draftText = '';
    setStream(undefined, key);
    if (follow) followConv(key);
  } else if (ev.type === 'tool') {
    const activity: ToolEvent = { name: toolLabel(ev), kind: ev.kind };
    const previous = stream.tools[stream.tools.length - 1];
    const previousName = typeof previous === 'string' ? previous : previous?.name;
    const previousKind = typeof previous === 'string' ? undefined : previous?.kind;
    if (previousName !== activity.name || previousKind !== activity.kind) stream.tools.push(activity);
    if (stream.tools.length > 3) stream.tools.splice(0, stream.tools.length - 3);
    setStream(undefined, key);
  } else if (ev.type === 'computer') {
    const previous = stream.computer || null;
    const phase = ['paused', 'resumed', 'released', 'blocked', 'recovering', 'connected'].includes(ev.phase) ? ev.phase : 'step';
    const connection = ['unavailable', 'recovering', 'connected'].includes(ev.connection) ? ev.connection : previous?.connection;
    const step = String(ev.step || 'Working in the browser').slice(0, 120);
    const incomingApp = String(ev.app || 'Chrome').slice(0, 48);
    const last = previous?.steps?.[previous.steps.length - 1];
    const steps = [...(previous?.steps || [])];
    if (!last || last.step !== step || last.phase !== phase) steps.push({ at: ev.at, step, phase });
    stream.computer = {
      runId: stream.runId || previous?.runId || '',
      state: connection === 'unavailable' ? 'error' : phase === 'paused' ? 'paused' : phase === 'released' ? 'released' : 'active',
      ...(connection ? { connection } : {}),
      surface: ev.surface === 'Chrome' ? 'Chrome' : 'browser',
      app: incomingApp === 'Chrome' && previous?.app && previous.app !== 'Chrome' ? previous.app : incomingApp,
      startedAt: previous?.startedAt || ev.at || new Date().toISOString(),
      updatedAt: ev.at || new Date().toISOString(),
      currentStep: phase === 'paused' ? 'Waiting for you' : connection && connection !== 'connected' && !ev.connection ? previous?.currentStep || step : step,
      steps: steps.slice(-12),
      hasPreview: (!connection || connection === 'connected') && !!(ev.hasPreview || previous?.hasPreview),
      previewSeq: ev.hasPreview ? ev.seq || previous?.previewSeq || null : previous?.previewSeq || null,
    };
    setStream(undefined, key);
  } else if (ev.type === 'connector') {
    const id = String(ev.id || `connector-${ev.seq || 0}`).slice(0, 96);
    const phase = ['complete', 'error', 'stopped'].includes(ev.phase) ? ev.phase : 'start';
    const nextState: ConnectorActivity['state'] = phase === 'complete' ? 'done' : phase === 'error' ? 'error' : phase === 'stopped' ? 'stopped' : 'active';
    const activities = [...(stream.connectors || [])];
    const index = activities.findIndex((activity) => activity.id === id);
    const previous = index >= 0 ? activities[index] : null;
    const incomingAction = String(ev.action || 'use') as ConnectorAction;
    const activity: ConnectorActivity = {
      id,
      connector: String(ev.connector || previous?.connector || 'Connected tool').slice(0, 40),
      action: CONNECTOR_ACTIONS.has(incomingAction) ? incomingAction : previous?.action || 'use',
      state: nextState,
      detail: String(ev.detail || previous?.detail || '').slice(0, 72),
      account: String(ev.account || previous?.account || '').slice(0, 64),
      outcome: String(ev.outcome || previous?.outcome || '').slice(0, 64),
      count: Number.isFinite(Number(ev.count)) && Number(ev.count) >= 0 ? Number(ev.count) : previous?.count ?? null,
      unit: String(ev.unit || previous?.unit || '').slice(0, 20),
      url: String(ev.url || previous?.url || '').slice(0, 2_000),
      startedAt: previous?.startedAt || ev.at || new Date().toISOString(),
      updatedAt: ev.at || new Date().toISOString(),
    };
    if (index >= 0) activities[index] = activity;
    else activities.push(activity);
    stream.connectors = activities.slice(-12);
    setStream(undefined, key);
  } else if (ev.type === 'saved') {
    stream.saved = { ok: ev.ok !== false, stopped: !!ev.stopped, waiting: !!ev.waiting };
  } else if (ev.type === 'status') {
    stream.statusText = userStatusText(ev.text);
    setStream(undefined, key);
  } else if (ev.type === 'stopped') {
    stream.statusText = 'Interrupted';
    setStream(undefined, key);
  } else if (ev.type === 'error') {
    stream.error = ev.message;
    set();
  }
}

function onRunEvent(key: string, ev: any): void {
  const stream = state.streams[key];
  if (stream) applyRunEvent(stream, key, ev);
}

export async function setComputerPaused(runRef: TabRunRef, paused: boolean): Promise<boolean> {
  try {
    const response = await api(`/api/tasks/${runRef.threadId}/tabs/${runRef.tabId}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
    const activity = response.run?.computer || null;
    const local = state.streams[runRef.key];
    if (local && activity) local.computer = activity;
    const task = state.cache[runRef.threadId];
    const tab = task && (task.tabs || []).find((candidate) => candidate.id === runRef.tabId);
    if (tab?.activeRun && activity) {
      tab.activeRun.computer = activity;
      tab.activeRun.paused = paused;
    }
    set();
    return true;
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// duel

export function paneTaskTab(paneIdx: number) {
  const pane = state.panes[paneIdx]; if (!pane) return undefined;
  const task = state.cache[pane.threadId]; if (!task) return undefined;
  const tabId = pane.tabId || task.activeTab;
  const tab = (task.tabs || []).find((t) => t.id === tabId);
  return { pane, task, tab, tabId };
}

function duelRequestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `duel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function postDuelIdempotently(path: string, body: Record<string, unknown>): Promise<any> {
  try {
    return await api(path, { method: 'POST', body: JSON.stringify(body) });
  } catch {
    // If Electron lost only the response, the server returns the already-saved
    // setup/run for this requestId. If the first call never arrived, this one
    // safely performs it once.
    return api(path, { method: 'POST', body: JSON.stringify(body) });
  }
}

export async function createDuel(paneIdx: number): Promise<void> {
  const ctx = paneTaskTab(paneIdx); if (!ctx || !ctx.tab) return;
  state.pop = null;
  try {
    const r = await postDuelIdempotently('/api/tasks/' + ctx.task.id + '/duel', {
      setup: true,
      sourceTabId: ctx.tab.id,
      requestId: duelRequestId(),
    });
    state.cache[ctx.task.id] = r.task;
    const pane = state.panes[paneIdx];
    if (pane) pane.tabId = r.duelTabId;
    state.duelEffort[r.duelTabId] = 2;
    captureAnalytics('duel_created');
    await refreshThreads();
    saveCurrentLayout();
    set(); scrollConv(streamKey(ctx.task.id, r.duelTabId));
  } catch (e) { toast((e as Error).message); }
}

export function lockDuel(paneIdx: number): void {
  const ctx = paneTaskTab(paneIdx); if (!ctx || !ctx.tab || !ctx.tab.duel) return;
  if (state.duelLocks[ctx.tab.id]) return;
  const tabId = ctx.tab.id;
  const duelId = ctx.tab.duel.duelId;
  const effort = EFFORT_NAMES[duelEffortIndex(ctx.tab)] || 'High';
  state.duelLocks[tabId] = { rampA: false, rampB: false };
  set();

  setTimeout(() => {
    if (!state.duelLocks[tabId]) return;
    state.duelLocks[tabId].rampA = true;
    set();
  }, 1000);

  setTimeout(async () => {
    if (!state.duelLocks[tabId]) return;
    state.duelLocks[tabId].rampB = true;
    set();
    try {
      const r = await api('/api/tasks/' + ctx.task.id + '/duel/' + duelId + '/lock', {
        method: 'POST', body: JSON.stringify({ effort }),
      });
      state.cache[ctx.task.id] = r.task;
      delete state.duelLocks[tabId];
      set();
    } catch (e) {
      delete state.duelLocks[tabId];
      toast((e as Error).message);
    }
  }, 2050);
}

export async function runDuel(paneIdx: number): Promise<void> {
  const ctx = paneTaskTab(paneIdx); if (!ctx || !ctx.tab || !ctx.tab.duel) return;
  state.activePane = paneIdx;
  if (duelPhase(ctx.tab) !== 'ready') { toast('Lock it in before giving the contenders a task.'); return; }
  const prompt = (state.drafts[draftKey(paneIdx)] || '').trim();
  if (!prompt) return;
  state.drafts[draftKey(paneIdx)] = '';
  ctx.tab.duel.phase = 'running';
  ctx.tab.duel.prompt = prompt;
  state.duel = { paneIdx, threadId: ctx.task.id, tabId: ctx.tab.id };
  captureAnalytics('duel_started', { effort: ctx.tab.duel.effort || 'High' });
  set(); scrollConv(streamKey(ctx.task.id, ctx.tab.id));
  const requestId = duelRequestId();
  try {
    const r = await postDuelIdempotently('/api/tasks/' + ctx.task.id + '/duel', {
      prompt,
      tabId: ctx.tab.id,
      effort: ctx.tab.duel.effort || 'High',
      requestId,
    });
    state.cache[ctx.task.id] = r.task;
    state.duel = null;
    const p = state.panes[paneIdx];
    // Finishing both contenders must not pull the user out of whatever tab
    // they opened while the Duel was running. The source-tab progress row is
    // the deliberate way back into the comparison.
    if (p && p.tabId === ctx.tab.id) p.tabId = r.duelTabId;
    if (r.stopped) state.drafts[draftKey(paneIdx)] = prompt;
    captureAnalytics(r.stopped ? 'duel_interrupted' : 'duel_completed', { effort: ctx.tab.duel.effort || 'High' });
  } catch (e) {
    state.duel = null;
    let durablePhase: ReturnType<typeof duelPhase> = null;
    try {
      // The long-running server request may have survived a renderer-side
      // fetch failure. Trust its durable state instead of painting the Duel as
      // failed or making the user submit it again.
      const latest = await api('/api/tasks/' + ctx.task.id);
      state.cache[ctx.task.id] = latest.task;
      durablePhase = duelPhase((latest.task.tabs || []).find((t: Tab) => t.id === ctx.tab!.id));
    } catch { /* keep the optimistic running state; polling will reconcile */ }
    if (durablePhase !== 'running' && durablePhase !== 'results') {
      const fresh = state.cache[ctx.task.id];
      const tab = fresh && (fresh.tabs || []).find((t) => t.id === ctx.tab!.id);
      if (tab && tab.duel) tab.duel.phase = 'ready';
      state.drafts[draftKey(paneIdx)] = prompt;
      toast((e as Error).message);
      captureAnalytics('duel_failed', { effort: ctx.tab.duel.effort || 'High' });
    }
  }
  await refreshThreads();
  saveCurrentLayout();
  set(); followConv(streamKey(ctx.task.id, ctx.tab.id));
}

// A finished, undecided Duel (typically both contenders failed) goes back to
// ready with a fresh availability-checked pair; the prompt returns to the
// composer so running it again is one click.
export async function retryDuel(paneIdx: number): Promise<void> {
  const ctx = paneTaskTab(paneIdx); if (!ctx || !ctx.tab || !ctx.tab.duel) return;
  try {
    const r = await api('/api/tasks/' + ctx.task.id + '/duel/' + ctx.tab.duel.duelId + '/retry', { method: 'POST' });
    state.cache[ctx.task.id] = r.task;
    if (r.lastPrompt) state.drafts[draftKey(paneIdx)] = r.lastPrompt;
    captureAnalytics('duel_retried');
    await refreshThreads();
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function pickDuel(threadId: string, duelId: string, choice: 'a' | 'b'): Promise<void> {
  try {
    const previous = state.cache[threadId];
    const duelTabId = (previous?.tabs || []).find((tab) => tab.duel?.duelId === duelId)?.id;
    const r = await api('/api/tasks/' + threadId + '/duel/' + duelId + '/pick', { method: 'POST', body: JSON.stringify({ choice }) });
    state.cache[threadId] = r.task;
    const sourceTabId = r.sourceTabId
      || (r.task.tabs || []).find((tab: Task['tabs'][number]) => (tab.duels || []).some((duel) => duel.duelId === duelId))?.id
      || r.task.activeTab;
    const settledTabId = r.duelTabId
      || (r.task.tabs || []).find((tab: Task['tabs'][number]) => tab.duel?.duelId === duelId)?.id
      || sourceTabId;
    state.panes.forEach((pane) => {
      if (pane.threadId === threadId && (!duelTabId || pane.tabId === duelTabId)) pane.tabId = settledTabId;
    });
    r.task.activeTab = settledTabId;
    state.duelReview = null;
    state.duelAltOpen[duelId] = false;
    captureAnalytics('duel_winner_selected', { winner: choice });
    await refreshThreads();
    saveCurrentLayout();
    set(); scrollConv(streamKey(threadId, settledTabId));
  } catch (e) { toast((e as Error).message); }
}

export function openDecidedDuel(paneIdx: number, threadId: string, sourceTabId: string, duelId: string): void {
  const pane = state.panes[paneIdx];
  const task = state.cache[threadId];
  const source = (task?.tabs || []).find((tab) => tab.id === sourceTabId);
  const record = (source?.duels || []).find((duel) => duel.duelId === duelId);
  if (!pane || pane.threadId !== threadId || !record) return;
  const settled = (task?.tabs || []).find((tab) => tab.id === record.duelTabId || tab.duel?.duelId === duelId);
  if (settled) {
    pane.tabId = settled.id;
    task!.activeTab = settled.id;
    state.activePane = paneIdx;
    state.duelReview = null;
    state.duelAltOpen[duelId] = false;
    state.pop = null;
    saveCurrentLayout();
    set(); scrollConv(streamKey(threadId, settled.id));
    return;
  }
  pane.tabId = sourceTabId;
  task.activeTab = sourceTabId;
  state.activePane = paneIdx;
  state.duelReview = { paneIdx, threadId, sourceTabId, duelId };
  state.duelAltOpen[duelId] = false;
  state.pop = null;
  set();
}

export function closeDecidedDuel(paneIdx: number): void {
  const review = state.duelReview;
  if (!review || review.paneIdx !== paneIdx) return;
  const pane = state.panes[paneIdx];
  if (pane && pane.threadId === review.threadId) pane.tabId = review.sourceTabId;
  state.duelReview = null;
  saveCurrentLayout();
  set(); scrollConv(streamKey(review.threadId, review.sourceTabId));
}

// ---------------------------------------------------------------------------
// diff / merge / archive / discard

export async function showDiff(threadId: string): Promise<void> {
  state.diff = { threadId, loading: true };
  set();
  try {
    const d = await api('/api/tasks/' + threadId + '/diff');
    state.diff = { threadId, files: d.files || [], patch: d.patch || '', dirty: d.dirty };
  } catch (e) { state.diff = { threadId, error: (e as Error).message }; }
  set();
}

export async function mergeThread(threadId: string, mode: 'merge' | 'pr'): Promise<void> {
  const verb = mode === 'pr' ? 'open a PR for' : 'merge';
  if (!confirm('Really ' + verb + ' this workstream’s changes?')) return;
  try {
    const r = await api('/api/tasks/' + threadId + '/merge', { method: 'POST', body: JSON.stringify({ mode }) });
    if (r.prUrl) toast('PR: ' + r.prUrl); else toast('merged');
    await afterThreadGone(threadId, !r.merged);
  } catch (e) { toast((e as Error).message); }
}

function applyPinnedState(threadId: string, pinned: boolean): void {
  const summary = state.threads.find((thread) => thread.id === threadId);
  if (summary) summary.pinned = pinned;
  const task = state.cache[threadId];
  if (task) task.pinned = pinned;
}

export async function toggleThreadPinned(threadId: string): Promise<void> {
  const summary = state.threads.find((thread) => thread.id === threadId);
  const previous = !!(summary?.pinned ?? state.cache[threadId]?.pinned);
  const pinned = !previous;
  applyPinnedState(threadId, pinned);
  set();
  try {
    const { task } = await api('/api/tasks/' + threadId, {
      method: 'PATCH', body: JSON.stringify({ pinned }),
    });
    state.cache[threadId] = task;
    await refreshThreads();
    set();
  } catch (e) {
    applyPinnedState(threadId, previous);
    toast((e as Error).message);
    set();
  }
}

export async function archiveThread(threadId: string): Promise<void> {
  try {
    await api('/api/tasks/' + threadId, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    delete state.cache[threadId];
    removeMatchingPanes((pane) => pane.threadId === threadId);
    forgetThreadInLayouts(threadId);
    rebaseLayoutRoot();
    if (state.panes.length) saveCurrentLayout();
    await refreshThreads();
    if (!state.panes.length) state.view = 'home';
    toast('archived');
    captureAnalytics('workstream_archived');
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function unarchiveThread(threadId: string): Promise<void> {
  try {
    const { task } = await api('/api/tasks/' + threadId, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
    if (task) state.cache[threadId] = task;
    await refreshThreads();
    toast('restored');
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function deleteArchivedThread(threadId: string): Promise<void> {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread?.archived) return;
  if (!window.confirm(`Permanently delete the archived workstream “${thread.title}”?\n\nAll of its tabs, transcripts, and attachments will be deleted and cannot be recovered.`)) return;
  try {
    await api(`/api/tasks/${threadId}`, { method: 'DELETE' });
    toast('workstream permanently deleted');
    captureAnalytics('workstream_deleted');
    await afterThreadGone(threadId, true);
  } catch (e) { toast((e as Error).message); }
}

// Right-click delete on a live workstream (Paper 13.1 rail menu, mirrored for
// rows): one confirmation, then archive and remove in one go, the same way a
// live project is deleted.
export async function deleteThread(threadId: string): Promise<void> {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) return;
  if (thread.archived) return deleteArchivedThread(threadId);
  if (!window.confirm(`Permanently delete the workstream “${thread.title}”?\n\nAll of its tabs, transcripts, and attachments will be deleted and cannot be recovered.`)) return;
  try {
    saveCurrentLayout();
    await api(`/api/tasks/${threadId}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    await api(`/api/tasks/${threadId}`, { method: 'DELETE' });
    toast('workstream permanently deleted');
    captureAnalytics('workstream_deleted');
    await afterThreadGone(threadId, true);
  } catch (e) { toast((e as Error).message); }
}

export async function discardThread(threadId: string): Promise<void> {
  if (!confirm('Discard this workstream? Its associated work is deleted.')) return;
  try { await api('/api/tasks/' + threadId + '/discard', { method: 'POST' }); toast('discarded'); await afterThreadGone(threadId, true); }
  catch (e) { toast((e as Error).message); }
}

type PaneIndexMode = 'insert' | 'remove';

function reindexPaneRecord<T>(record: Record<string, T>, paneIdx: number, mode: PaneIndexMode): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const index = Number(key);
    if (!Number.isInteger(index) || String(index) !== key) {
      next[key] = value;
      continue;
    }
    if (mode === 'remove' && index === paneIdx) continue;
    const shifted = mode === 'insert'
      ? (index >= paneIdx ? index + 1 : index)
      : (index > paneIdx ? index - 1 : index);
    next[String(shifted)] = value;
  }
  return next;
}

function reindexPaneState(paneIdx: number, mode: PaneIndexMode): void {
  state.drafts = reindexPaneRecord(state.drafts, paneIdx, mode);
  state.contextOpen = reindexPaneRecord(state.contextOpen, paneIdx, mode);
  state.contextQuery = reindexPaneRecord(state.contextQuery, paneIdx, mode);
  state.contextMention = reindexPaneRecord(state.contextMention, paneIdx, mode);

  const shiftedIndex = (index: number): number | null => {
    if (mode === 'insert') return index >= paneIdx ? index + 1 : index;
    if (index === paneIdx) return null;
    return index > paneIdx ? index - 1 : index;
  };

  if (mode === 'insert') {
    if (state.activePane >= paneIdx) state.activePane += 1;
  } else if (state.activePane === paneIdx) {
    state.activePane = Math.max(0, Math.min(paneIdx, state.panes.length - 2));
  } else if (state.activePane > paneIdx) {
    state.activePane -= 1;
  }

  if (state.duel) {
    const next = shiftedIndex(state.duel.paneIdx);
    state.duel = next == null ? null : { ...state.duel, paneIdx: next };
  }
  if (state.duelReview) {
    const next = shiftedIndex(state.duelReview.paneIdx);
    state.duelReview = next == null ? null : { ...state.duelReview, paneIdx: next };
  }
  if (state.renaming?.paneIdx != null) {
    const next = shiftedIndex(state.renaming.paneIdx);
    state.renaming = next == null ? null : { ...state.renaming, paneIdx: next };
  }
  if (state.pop?.pane != null) {
    const next = shiftedIndex(state.pop.pane);
    state.pop = next == null ? null : { ...state.pop, pane: next };
  }
}

function removeMatchingPanes(predicate: (pane: Pane) => boolean): void {
  for (let index = state.panes.length - 1; index >= 0; index -= 1) {
    if (!predicate(state.panes[index])) continue;
    reindexPaneState(index, 'remove');
    state.panes.splice(index, 1);
  }
}

async function afterThreadGone(threadId: string, remove: boolean): Promise<void> {
  if (state.duelReview?.threadId === threadId) state.duelReview = null;
  if (remove) {
    delete state.cache[threadId];
    removeMatchingPanes((pane) => pane.threadId === threadId);
    forgetThreadInLayouts(threadId);
    rebaseLayoutRoot();
    if (state.panes.length) saveCurrentLayout();
  } else {
    try { await loadTask(threadId); } catch { /* ignore */ }
  }
  state.diff = null;
  await refreshThreads();
  if (!state.panes.length) state.view = 'home';
  set();
}

export function closePane(idx: number): void {
  const closed = state.panes[idx];
  if (!closed) return;
  const root = state.layoutRoot;
  reindexPaneState(idx, 'remove');
  state.panes.splice(idx, 1);
  if (root && closed && closed.threadId === root && !state.panes.some((pane) => pane.threadId === root)) {
    const updatedAt = Date.now();
    delete state.threadLayouts[root];
    persistThreadLayouts();
    syncThreadLayout(root, null, updatedAt);
    state.layoutRoot = state.panes[0] ? state.panes[0].threadId : null;
  }
  if (!state.panes.length) state.view = 'home';
  else saveCurrentLayout();
  captureAnalytics('split_pane_closed', { pane_count: state.panes.length });
  set();
}

// ---------------------------------------------------------------------------
// navigation

export function navigate(view: View): void {
  if (view === 'landed') { void openLanded(); return; }
  const previousView = state.view;
  saveCurrentLayout();
  state.view = view;
  if (view !== 'tab') state.slackReturnThread = null;
  state.duelReview = null;
  state.pop = null;
  state.landedSearchOpen = false;
  if (view === 'tab' && !state.panes.length) state.view = 'home';
  if (view === 'routing') loadStats();
  if (view === 'plays') void loadPlays();
  if (view === 'maps') void refreshThreads();
  if (view === 'scheduled') { state.scheduledOpen = null; void refreshThreads(); void loadSchedules(); }
  if (view === 'duels') loadDuelHistory();
  if (view === 'performance') loadPerformance();
  if (view === 'remote') loadRemote();
  if (view === 'context') {
    if (previousView !== 'context') state.contextConcierge.justSaved = false;
    loadPlatformContexts();
  }
  if (view === 'connectors') void loadConnectorsOverview();
  if (view === 'models' || view === 'onboarding') refreshStatus();
  captureAnalytics('view_opened', { view: state.view, pane_count: state.panes.length });
  set();
}

// ---------------------------------------------------------------------------
// Section 30, Landed (boards 30.1 to 30.5): the tabs that answered while you
// were away, one at a time, each the plain tab on the whole page. Showing
// a tab here never marks its landing seen (the list would empty itself as
// you paged through it); Complete, the tab's Done, or a reply take a row
// out. The pane is the ordinary pane on the ordinary tab, so the strip,
// the thread, the composer and the confirmation's own buttons are as they
// are anywhere; the layout root is left empty so nothing here overwrites
// a workstream's saved split.

let landedReturn: { view: View; panes: Pane[]; activePane: number; layoutRoot: string | null } | null = null;

export function landedSearch(open: boolean): void {
  if (state.view !== 'landed') return;
  state.landedSearchOpen = open;
  set();
}

export function landedExit(): void {
  if (state.view !== 'landed') return;
  const back = landedReturn;
  // Navigate before restoring the layout so a Landed card can never save
  // itself over the split the user left behind.
  navigate(back?.view || 'home');
  state.panes = back?.panes || [];
  state.activePane = back?.activePane || 0;
  state.layoutRoot = back?.layoutRoot || null;
  state.view = back?.view || 'home';
  if (state.view === 'tab' && !state.panes.length) state.view = 'home';
  set();
}

export async function openLanded(): Promise<void> {
  if (state.view !== 'landed') {
    landedReturn = { view: state.view, panes: state.panes.map((pane) => ({ ...pane })), activePane: state.activePane, layoutRoot: state.layoutRoot };
  }
  saveCurrentLayout();
  state.view = 'landed';
  state.landedSearchOpen = false;
  state.layoutRoot = null;
  state.openedFrom = null;
  state.duelReview = null;
  state.pop = null;
  set();
  await refreshThreads();
  if (state.view !== 'landed') return;
  // The waiting rows, oldest first; with none, the recents, newest first.
  const { rows, recent } = landedDeck();
  const kept = state.landedCurrent && rows.some((row) => landedKey(row) === state.landedCurrent) ? state.landedCurrent : null;
  await landedShow(kept || (rows[0] ? landedKey(rows[0]) : null));
  captureAnalytics('view_opened', { view: 'landed', pane_count: recent ? 0 : rows.length, recent_count: recent ? rows.length : 0 });
}

export async function landedShow(key: string | null): Promise<void> {
  // An animation or a slow load may finish after X returned to the split.
  if (state.view !== 'landed') return;
  state.landedSearchOpen = false;
  state.landedCurrent = key;
  if (!key) {
    state.landedCurrentAt = 0;
    state.panes = [];
    set();
    return;
  }
  const [threadId, tabId] = key.split(':');
  const deck = landedDeck();
  const row = deck.rows.find((candidate) => landedKey(candidate) === key);
  state.landedCurrentAt = row?.landedAt || state.landedCurrentAt || Date.now();
  if (!state.cache[threadId]) {
    set();
    try { await loadTask(threadId); } catch { /* the row stays; the pane says loading */ }
    if (state.view !== 'landed' || state.landedCurrent !== key) return;
  }
  // What is shown is read fresh: a landing the list knows of may not be
  // in this window's copy yet.
  void loadTask(threadId).then(() => { if (state.view === 'landed') set(); }).catch(() => {});
  const task = state.cache[threadId];
  if (task && (task.tabs || []).some((tab) => tab.id === tabId)) task.activeTab = tabId;
  state.panes = [{ repo: task?.repo ?? state.threads.find((thread) => thread.id === threadId)?.repo ?? null, threadId, tabId }];
  state.activePane = 0;
  // Being on it, for the rule that a turn you sat through is not news; not
  // a look, which would take it out of the list.
  view(threadId, tabId);
  // A recent was read already. Saying so here keeps this look, stamped
  // after its landing, from dating that landing new again.
  if (deck.recent && row) markSeen(threadId, tabId);
  set();
  scrollConv(streamKey(threadId, tabId));
  // The page opens with nothing focused, so the arrows step.
  const focused = document.activeElement as HTMLElement | null;
  if (focused && focused !== document.body) focused.blur();
}

// Board 30.7: a card moving is choreography, never a decision. While one
// is on its way, further presses wait for it. Under reduced motion the
// cards just swap.
let landedMoving = false;
const landedCalm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const landedCard = () => document.querySelector<HTMLElement>('[data-landed-card]');

// The card that came in slides from the side it was waiting on.
function landedEnter(from: 'left' | 'right'): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const card = landedCard();
    if (!card) return;
    card.classList.add(`enter-${from}`);
    card.addEventListener('animationend', () => card.classList.remove(`enter-${from}`), { once: true });
  }));
}

export function landedStep(delta: number): void {
  if (state.view !== 'landed' || landedMoving) return;
  const place = landedPlace();
  const target = delta > 0 ? place.next : place.prev;
  // Stepping on from a row that has left the list, with nothing after it,
  // reaches the end (board 30.5).
  if (!target) { if (delta > 0 && place.at < 0) void landedShow(null); return; }
  const card = landedCard();
  if (landedCalm() || !card) { void landedShow(landedKey(target)); return; }
  // Sideways, no stamp and no tilt: stepping past a card never looks like
  // finishing it. Right sends this one out left and the next in from the
  // right; left the reverse.
  landedMoving = true;
  card.classList.add(delta > 0 ? 'out-left' : 'out-right');
  window.setTimeout(() => {
    landedMoving = false;
    void landedShow(landedKey(target));
    landedEnter(delta > 0 ? 'right' : 'left');
  }, 180);
}

// The row on screen was shelved (the strip's Done) or its workstream
// archived: it has nothing waiting on you, so the page moves on.
export function landedMoveOn(): void {
  if (state.view !== 'landed') return;
  const place = landedPlace();
  const target = place.next || place.prev;
  void landedShow(target ? landedKey(target) : null);
}

// Complete is not Done: the landing is read, and the tab stays where it
// is, reachable as ever. The page moves to the row that was after it. In
// the recents nothing leaves: the card goes and the next older one comes
// up, and at the oldest there is nowhere to go.
export function landedComplete(): void {
  if (state.view !== 'landed' || landedMoving) return;
  const key = state.landedCurrent;
  if (!key) return;
  const start = landedPlace();
  if (start.recent && start.at >= 0 && !start.next) return;
  const finish = (animated: boolean) => {
    const before = landedPlace();
    const [threadId, tabId] = key.split(':');
    markSeen(threadId, tabId);
    captureAnalytics('landed_completed', { left: Math.max(0, before.left - (before.at >= 0 ? 1 : 0)), recent: before.recent });
    const after = landedPlace();
    let target: LandedRow | null;
    if (after.recent && !before.recent) {
      // The last waiting row is read: on to the newest of what came back,
      // this one aside.
      target = after.rows.find((row) => landedKey(row) !== key) || null;
    } else if (after.recent) {
      target = before.next;
    } else {
      target = before.at >= 0 ? (after.rows[before.at] || after.rows[before.at - 1] || null) : (after.next || after.prev);
    }
    void landedShow(target ? landedKey(target) : null);
    // One soft tick at the catch, never the press (the Done gesture's rule).
    if (animated) softTick();
    landedMoving = false;
  };
  const card = landedCard();
  if (landedCalm() || !card) { finish(false); return; }
  // Board 30.7: the press flashes green, a check stamps the card, the card
  // flies off to the right with a tilt while the one behind rises into its
  // place, and the counts roll down at the catch.
  landedMoving = true;
  document.querySelector('[data-landed-complete]')?.classList.add('flash');
  card.classList.add('stamping');
  window.setTimeout(() => {
    card.classList.add('fly');
    document.querySelector('[data-landed-peek]')?.classList.add('rise');
  }, 120);
  window.setTimeout(() => {
    document.querySelector('[data-landed-complete]')?.classList.remove('flash');
    finish(true);
  }, 420);
}

// ---------------------------------------------------------------------------
// Section 29: scheduled tasks by tab. They live on this Mac's service; the
// window keeps a copy for the page, the rail's count and a tab's chip.

export async function loadSchedules(): Promise<void> {
  try {
    const rows: Schedule[] = (await api('/api/scheduled')).schedules || [];
    if (JSON.stringify(rows) === JSON.stringify(state.schedules)) return;
    state.schedules = rows;
    set();
  } catch { /* the next look brings it */ }
}

function keepSchedule(schedule: Schedule | undefined): void {
  if (!schedule) return;
  const at = state.schedules.findIndex((row) => row.id === schedule.id);
  state.schedules = at < 0 ? [...state.schedules, schedule] : state.schedules.map((row) => (row.id === schedule.id ? schedule : row));
  set();
}

export function openScheduled(id: string | null): void {
  if (state.view !== 'scheduled') navigate('scheduled');
  state.scheduledOpen = id;
  set();
  void loadSchedules();
}

export type ScheduleInput = Pick<Schedule, 'name' | 'instructions' | 'threadId' | 'tabId' | 'repeat'>;

// Both return the server's own sentence on a refusal, for the sheet to show.
export async function createSchedule(input: ScheduleInput): Promise<string | null> {
  try {
    keepSchedule((await api('/api/scheduled', { method: 'POST', body: JSON.stringify(input) })).schedule);
    captureAnalytics('schedule_created', { repeat: input.repeat.kind });
    return null;
  } catch (error) {
    return (error as Error).message || 'That did not save.';
  }
}

export async function updateSchedule(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): Promise<string | null> {
  try {
    keepSchedule((await api(`/api/scheduled/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).schedule);
    return null;
  } catch (error) {
    return (error as Error).message || 'That did not save.';
  }
}

export async function deleteSchedule(id: string): Promise<void> {
  try {
    await api(`/api/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.schedules = state.schedules.filter((row) => row.id !== id);
    if (state.scheduledOpen === id) state.scheduledOpen = null;
    set();
  } catch (error) {
    toast((error as Error).message || 'That did not delete.');
  }
}

export async function runScheduleNow(id: string): Promise<void> {
  try {
    keepSchedule((await api(`/api/scheduled/${encodeURIComponent(id)}/run`, { method: 'POST' })).schedule);
    captureAnalytics('schedule_run_now', {});
  } catch (error) {
    toast((error as Error).message || 'That did not start.');
    void loadSchedules();
  }
}

// A grant names the answer that asked, never the app or the action: the
// service wrote that pair on the answer after checking it, and that is the
// only thing it will allow (board 29.8).
// Section 32, board 32.3a: Hand to <Tab> on the orchestrator's card.
export async function confirmEmailHandoff(threadId: string, id: string): Promise<boolean> {
  try {
    await api(`/api/email/handoffs/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' });
    await loadTask(threadId).then(() => set()).catch(() => {});
    return true;
  } catch (error) {
    toast((error as Error).message || 'That did not go.');
    return false;
  }
}

export async function allowForSchedule(id: string, asked: { threadId: string; messageId: string }): Promise<void> {
  try {
    keepSchedule((await api(`/api/scheduled/${encodeURIComponent(id)}/allow`, { method: 'POST', body: JSON.stringify(asked) })).schedule);
  } catch (error) {
    toast((error as Error).message || 'That did not save.');
  }
}

export async function disallowForSchedule(id: string, row: { app: string; action: string }): Promise<void> {
  try {
    keepSchedule((await api(`/api/scheduled/${encodeURIComponent(id)}/allow`, { method: 'DELETE', body: JSON.stringify(row) })).schedule);
  } catch (error) {
    toast((error as Error).message || 'That did not save.');
  }
}

// A History row is a turn in the tab: open the tab and bring that turn up.
export async function openScheduledFire(schedule: Schedule, fireId: string): Promise<void> {
  await openThreadAt(schedule.threadId, schedule.tabId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    const turn = document.querySelector(`[data-scheduled-fire="${CSS.escape(fireId)}"]`);
    // An old run sits behind Show earlier; the thread is drawn whole for it.
    if (!turn && attempt === 1) showWholeThread(streamKey(schedule.threadId, schedule.tabId));
    if (!turn) continue;
    // The tab opened at its newest turn and is still settling there; this
    // is the reader choosing a place, so the follow lets go of it.
    const conv = turn.closest<HTMLElement>('.conv');
    if (conv) cancelConversationLanding(conv);
    turn.scrollIntoView({ block: 'start', behavior: 'auto' });
    // The newest turn may already fit at the bottom and raise no scroll
    // event. In that case live following should stay available.
    if (conv) trackConversationScroll(conv);
    return;
  }
}

// ---------------------------------------------------------------------------
// stats / performance

export async function loadStats(): Promise<void> {
  try { state.stats = await api('/api/stats'); set(); } catch (e) { toast((e as Error).message); }
}
export async function loadPerformance(): Promise<void> {
  try { state.performance = await api('/api/performance'); set(); }
  catch (e) { toast((e as Error).message); }
}
export async function loadDuelHistory(): Promise<void> {
  try { state.duelHistory = await api('/api/duels'); set(); }
  catch (e) { toast((e as Error).message); }
}

// ---------------------------------------------------------------------------
// split / move / context

function unopenedTab(task: Task, requestedTabId?: string | null): string | null {
  const tabs = task.tabs || [];
  if (!tabs.length) return null;
  const requested = requestedTabId && tabs.some((tab) => tab.id === requestedTabId) ? requestedTabId : null;
  if (requested) return requested;
  const alreadyOpen = new Set(state.panes.filter((pane) => pane.threadId === task.id).map((pane) => pane.tabId));
  const preferred = tabs.find((tab) => tab.id === task.activeTab && !alreadyOpen.has(tab.id));
  return preferred?.id || tabs.find((tab) => !alreadyOpen.has(tab.id))?.id || null;
}

export function commitPaneResize(leftIdx: number, leftWidth: number, rightWidth: number): void {
  const left = state.panes[leftIdx];
  const right = state.panes[leftIdx + 1];
  if (!left || !right || !Number.isFinite(leftWidth) || !Number.isFinite(rightWidth) || leftWidth <= 0 || rightWidth <= 0) return;
  left.width = Math.max(0.001, leftWidth);
  right.width = Math.max(0.001, rightWidth);
  saveCurrentLayout();
  captureAnalytics('split_pane_resized', { pane_count: state.panes.length });
  set();
}

function insertSplitPane(task: Task, tabId: string, afterPaneIdx?: number): boolean {
  const existing = state.panes.findIndex((pane) => pane.threadId === task.id && pane.tabId === tabId);
  if (existing >= 0) {
    state.activePane = existing;
    state.pop = null;
    toast('Already open. Took you to it.');
    set();
    // The pane may sit off-screen when the track overflows.
    requestAnimationFrame(() => {
      document.querySelector(`[data-pane-index="${existing}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return false;
  }
  const fallbackAnchor = Math.max(0, Math.min(Number(state.activePane) || 0, Math.max(0, state.panes.length - 1)));
  const anchor = Number.isInteger(afterPaneIdx)
    ? Math.max(0, Math.min(afterPaneIdx as number, Math.max(0, state.panes.length - 1)))
    : fallbackAnchor;
  const insertAt = state.panes.length ? anchor + 1 : 0;
  task.activeTab = tabId;
  state.cache[task.id] = task;
  state.view = 'tab';
  if (!state.layoutRoot || !state.panes.some((pane) => pane.threadId === state.layoutRoot)) {
    state.layoutRoot = state.panes[0]?.threadId || task.id;
  }
  let insertedWidth: number | undefined;
  if (state.panes.some((pane) => Number.isFinite(Number(pane.width)) && Number(pane.width) > 0)) {
    state.panes.forEach((pane) => { pane.width = paneWeight(pane); });
    const anchorPane = state.panes[anchor];
    if (anchorPane) {
      insertedWidth = Math.max(0.001, paneWeight(anchorPane) / 2);
      anchorPane.width = insertedWidth;
    }
  }
  reindexPaneState(insertAt, 'insert');
  state.panes.splice(insertAt, 0, {
    repo: task.repo,
    threadId: task.id,
    tabId,
    ...(insertedWidth ? { width: insertedWidth } : {}),
  });
  state.activePane = insertAt;
  state.duelReview = null;
  state.pop = null;
  saveCurrentLayout();
  captureAnalytics('split_pane_opened', {
    pane_count: state.panes.length,
    cross_project: new Set(state.panes.map((pane) => pane.repo)).size > 1,
    cross_workstream: new Set(state.panes.map((pane) => pane.threadId)).size > 1,
  });
  set();
  scrollConv(streamKey(task.id, tabId));
  return true;
}

export async function openThreadSplit(threadId: string, tabId?: string | null, afterPaneIdx?: number): Promise<void> {
  try {
    const task = state.cache[threadId] || await loadTask(threadId);
    const selected = unopenedTab(task, tabId);
    if (!selected) {
      const exact = tabId && (task.tabs || []).some((tab) => tab.id === tabId);
      if (exact) insertSplitPane(task, tabId, afterPaneIdx);
      else toast('Every tab in that workstream is already open.');
      return;
    }
    insertSplitPane(task, selected, afterPaneIdx);
  } catch (e) { toast((e as Error).message); }
}

export async function openProjectSplit(repo: string, afterPaneIdx?: number): Promise<void> {
  state.pop = null;
  try {
    const summaries = threadsForRepo(repo);
    if (!summaries.length) {
      const created = await createThread(repo, 'New Workstream');
      if (created) insertSplitPane(created, created.activeTab, afterPaneIdx);
      return;
    }
    for (const summary of summaries) {
      const task = state.cache[summary.id] || await loadTask(summary.id);
      const selected = unopenedTab(task);
      if (selected) {
        insertSplitPane(task, selected, afterPaneIdx);
        return;
      }
    }
    toast('Every tab in that project is already open.');
  } catch (e) { toast((e as Error).message); }
}

export async function newContextBlock(idx: number): Promise<void> {
  const pane = state.panes[idx];
  const task = pane && state.cache[pane.threadId];
  if (!task) return;
  const content = window.prompt('Add a reusable context block for this project:');
  if (!content || !content.trim()) return;
  const clean = content.trim();
  const firstLine = clean.split('\n')[0].replace(/^#+\s*/, '').trim();
  const block = { id: String(Date.now()), name: firstLine.slice(0, 56) || 'Context block', content: clean };
  let project = state.projects.find((p) => p.path === task.repo);
  if (!project) {
    // Never PATCH from an unloaded projects list — it would replace the
    // project's existing blocks with just this one.
    try { state.projects = (await api('/api/repos')).repos || []; } catch { /* ignore */ }
    project = state.projects.find((p) => p.path === task.repo);
  }
  try {
    const r = await api('/api/repos', { method: 'PATCH', body: JSON.stringify({ path: task.repo, contextBlocks: [...(project?.contextBlocks || []), block] }) });
    state.projects = state.projects.map((p) => (p.path === r.repo.path ? r.repo : p));
    set();
  } catch (e) { toast((e as Error).message); }
}

export async function moveTab(dragKey: string, target: { toThread?: string; toRepo?: string }): Promise<void> {
  const [threadId, tabId] = dragKey.split('::');
  if (target.toThread && target.toThread === threadId) { toast('already in this workstream'); return; }
  try {
    saveCurrentLayout();
    const r = await api('/api/tasks/' + threadId + '/tabs/' + tabId + '/move', { method: 'POST', body: JSON.stringify(target) });
    delete state.cache[threadId];
    state.cache[r.task.id] = r.task;
    await refreshThreads();
    state.view = 'tab';
    state.layoutRoot = r.task.id;
    state.panes = [{ repo: r.task.repo, threadId: r.task.id, tabId: r.tabId || r.task.activeTab }];
    saveCurrentLayout();
    toast(target.toThread ? 'moved into ' + r.task.title : 'moved to ' + r.task.repoName);
    set();
    scrollConv(streamKey(r.task.id, r.tabId || r.task.activeTab));
  } catch (e) { toast((e as Error).message); }
}

export async function moveThread(threadId: string, repoPath: string): Promise<void> {
  const thread = state.threads.find((row) => row.id === threadId);
  const project = state.projects.find((row) => row.path === repoPath);
  if (!thread || !project) return;
  const already = thread.projectId && project.id ? thread.projectId === project.id : thread.repo === project.path;
  if (already) { toast(`${thread.title} is already in ${project.name}`); return; }
  const others = (project.shared?.members || []).filter((member) => !member.me && member.accepted).map((member) => member.name.split(' ')[0]);
  if (project.shared) {
    const who = others.length ? `${andList(others)} will` : `Everyone you invite to ${project.name} will`;
    if (!window.confirm(`Move “${thread.title}” into ${project.name}?\n\n${who} see it, tabs and transcripts included, and can work in it too.`)) return;
  }
  try {
    const r = await api(`/api/tasks/${threadId}/move`, { method: 'POST', body: JSON.stringify({ toRepo: project.path }) });
    state.cache[threadId] = r.task;
    for (const pane of state.panes) if (pane.threadId === threadId) pane.repo = r.task.repo;
    await refreshThreads();
    if (r.warning) toast(r.warning);
    else if (r.shared && others.length) toast(`${thread.title} is in ${project.name} now, shared with ${andList(others)}`);
    else toast(`${thread.title} is in ${project.name} now`);
    set();
  } catch (e) { toast((e as Error).message); }
}

export function splitFromDrag(dragKey: string, paneIdx: number, targetThreadId: string, targetTabId: string): void {
  const [dThread, dTab] = dragKey.split('::');
  if (dThread === targetThreadId && dTab === targetTabId) return;
  const pane = state.panes[paneIdx];
  if (pane) { pane.tabId = targetTabId; if (state.cache[pane.threadId]) state.cache[pane.threadId].activeTab = targetTabId; }
  void openThreadSplit(dThread, dTab, paneIdx);
}

// Paper 21.2: picking from the one @ menu, routed by what the type changes.
// A tab is a destination (chip + hand on send); a play wraps the message in
// the existing /plays machinery; context inserts its token as before.
export function pickMention(idx: number, item: { type: 'tab' | 'person' | 'play' | 'context'; id: string; name: string; threadId?: string }, task: Task, tabId: string): void {
  const draft = state.drafts[draftKey(idx)] || '';
  const mention = state.contextMention[idx];
  const stripped = mention ? draft.slice(0, mention.start) + draft.slice(mention.end) : draft;
  const key = streamKey(task.id, tabId);
  // Paper 21.2b: person and context picks become chips above the textarea,
  // never text in it — the typed @query is stripped from the draft.
  if (item.type === 'person') {
    const pings = state.pendingPings[key] || [];
    if (!pings.some((ping) => ping.email === item.id)) {
      state.pendingPings[key] = [...pings, { email: item.id, name: item.name }];
    }
    state.drafts[draftKey(idx)] = stripped;
    delete state.contextMention[idx];
    if (state.slackReady === false) {
      const first = item.name.split(' ')[0];
      toast(`Slack isn't connected yet, so ${first} won't get this. Connect it on the Connectors page.`);
    }
    set();
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
      if (ta) { ta.focus(); const end = stripped.length; ta.setSelectionRange(end, end); }
    });
    return;
  }
  if (item.type === 'context') {
    const refs = state.pendingContextRefs[key] || [];
    if (!refs.includes(item.name)) state.pendingContextRefs[key] = [...refs, item.name];
    state.drafts[draftKey(idx)] = stripped;
    delete state.contextMention[idx];
    set();
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
      if (ta) { ta.focus(); const end = stripped.length; ta.setSelectionRange(end, end); }
    });
    return;
  }
  if (item.type === 'tab') {
    state.pendingHandoff[streamKey(task.id, tabId)] = { tabId: item.id, name: item.name, ...(item.threadId ? { threadId: item.threadId } : {}) };
    state.drafts[draftKey(idx)] = stripped;
  } else {
    state.drafts[draftKey(idx)] = `/plays ${item.name} ${stripped.trimStart()}`;
  }
  delete state.contextMention[idx];
  set();
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
    if (ta) { ta.focus(); const end = state.drafts[draftKey(idx)].length; ta.setSelectionRange(end, end); }
  });
}

export async function sendNote(threadId: string, tabId: string, text: string, mentions: { email: string; name: string }[]): Promise<void> {
  try {
    const r = await api(`/api/tasks/${threadId}/tabs/${tabId}/note`, { method: 'POST', body: JSON.stringify({ prompt: text, mentions }) });
    state.cache[threadId] = r.task;
    for (const ping of (r.pings || []) as PingResult[]) {
      toast(ping.ok ? `Sent to ${ping.name || ping.email} in Slack` : `Could not send to ${ping.name || ping.email}: ${ping.error || 'Slack refused it'}`);
    }
    set();
    scrollConv(streamKey(threadId, tabId));
  } catch (e) { toast((e as Error).message); }
}

// Paper 21.3: the handed message runs where it was sent, a sibling tab or a
// tab in another workstream. That workstream may never have been opened
// here, so it is read before its tab runs; the stamp names the sender's
// workstream only when it differs from the receiver's.
async function handMessage(fromThreadId: string, fromTabId: string, toThreadId: string, toTabId: string, text: string, tokens: { mentions?: { email: string; name: string }[]; contextMentions?: string[] }): Promise<void> {
  if (!state.cache[toThreadId]) {
    try { await loadTask(toThreadId); } catch (e) { toast((e as Error).message); return; }
  }
  const handoffFrom = toThreadId === fromThreadId ? { tabId: fromTabId } : { tabId: fromTabId, threadId: fromThreadId };
  const run = runTab(toThreadId, toTabId, text, undefined, { handoffFrom, ...tokens });
  if (toThreadId !== fromThreadId) {
    // The sender's hairline row lands on its own task at the send, and the
    // receiver's stream refreshes only the receiver, so the sender is read
    // back once the run has started there.
    const toKey = streamKey(toThreadId, toTabId);
    for (let waited = 0; waited < 6000 && state.streams[toKey] && !state.streams[toKey].runId; waited += 150) await new Promise((resolve) => setTimeout(resolve, 150));
    await loadTask(fromThreadId).then(() => set()).catch(() => {});
  }
  await run;
}

// Section 26: the explicit wake for messages waiting from other tabs. The
// turn's own prompt is hidden; the messages enter it on the server.
export function readTabMessagesNow(threadId: string, tabId: string): void {
  void runTab(threadId, tabId, 'Read the messages from other tabs above and act on them.', undefined, { hiddenPrompt: true });
}

export function clearPendingHandoff(key: string): void {
  delete state.pendingHandoff[key];
  set();
}

export function removePendingPing(key: string, email: string): void {
  const kept = (state.pendingPings[key] || []).filter((ping) => ping.email !== email);
  if (kept.length) state.pendingPings[key] = kept; else delete state.pendingPings[key];
  set();
}

export function removePendingContextRef(key: string, name: string): void {
  const kept = (state.pendingContextRefs[key] || []).filter((ref) => ref !== name);
  if (kept.length) state.pendingContextRefs[key] = kept; else delete state.pendingContextRefs[key];
  set();
}

// Paper 21.2b: a context pick is a chip, not an @[token] in the text. The
// typed @query (if the panel was reached through one) is stripped from the
// draft; the send carries the block name and the server injects it exactly
// as a typed token. Hand-typed @[Name] tokens still work as before.
export function insertContextMention(idx: number, name: string): void {
  const pane = state.panes[idx];
  const task = pane && state.cache[pane.threadId];
  if (!pane || !task) return;
  const key = streamKey(task.id, pane.tabId || task.activeTab);
  const refs = state.pendingContextRefs[key] || [];
  if (!refs.includes(name)) state.pendingContextRefs[key] = [...refs, name];
  const draft = state.drafts[draftKey(idx)] || '';
  const mention = state.contextMention[idx];
  if (mention) state.drafts[draftKey(idx)] = draft.slice(0, mention.start) + draft.slice(mention.end);
  delete state.contextMention[idx];
  state.contextOpen[idx] = false;
  set();
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
    if (ta) { ta.focus(); const end = ta.value.length; ta.setSelectionRange(end, end); }
  });
}

export function attachTerminalContext(targetPaneIdx: number, sourceTaskId: string, sourceTabId: string): void {
  const targetPane = state.panes[targetPaneIdx];
  const targetTask = targetPane && state.cache[targetPane.threadId];
  const targetTabId = targetPane && (targetPane.tabId || targetTask?.activeTab);
  const sourceTask = state.cache[sourceTaskId];
  const sourceTab = sourceTask && [...(sourceTask.tabs || []), ...(sourceTask.archivedTabs || [])]
    .find((tab) => tab.id === sourceTabId);
  if (!targetPane || !targetTask || !targetTabId || !sourceTask || !sourceTab) {
    toast('That terminal is no longer available.');
    return;
  }
  if (targetTask.id === sourceTaskId && targetTabId === sourceTabId) {
    toast('This tab already has its own context.');
    return;
  }
  const key = streamKey(targetTask.id, targetTabId);
  const pending = state.pendingTerminalContexts[key] || (state.pendingTerminalContexts[key] = []);
  if (!pending.some((context) => context.sourceTaskId === sourceTaskId && context.sourceTabId === sourceTabId)) {
    pending.push({
      sourceTaskId,
      sourceTabId,
      sourceProject: sourceTask.repoName || sourceTask.repo || 'Project',
      sourceThread: sourceTask.title || 'Workstream',
      sourceTab: sourceTab.name || 'Tab',
    });
  }
  state.activePane = targetPaneIdx;
  state.pop = null;
  set();
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-draft="${targetPaneIdx}"]`)?.focus());
}

export function removeTerminalContext(threadId: string, tabId: string, sourceTaskId: string, sourceTabId: string): void {
  const key = streamKey(threadId, tabId);
  const next = (state.pendingTerminalContexts[key] || [])
    .filter((context) => context.sourceTaskId !== sourceTaskId || context.sourceTabId !== sourceTabId);
  if (next.length) state.pendingTerminalContexts[key] = next;
  else delete state.pendingTerminalContexts[key];
  set();
}

export async function keepThreadInCloud(threadId: string): Promise<void> {
  if (state.cloudHandoffBusy[threadId]) return;
  state.cloudHandoffBusy[threadId] = true;
  set();
  try {
    const result = await api('/api/handoff/cloud', {
      method: 'POST', body: JSON.stringify({ taskId: threadId }),
    });
    if (result.task) state.cache[threadId] = result.task;
    else if (state.cache[threadId]) state.cache[threadId].cloudHandoff = { machineId: result.machineId, state: 'running', startedAt: new Date().toISOString() };
    toast('Running in the cloud.');
  } catch (error) {
    toast((error as Error).message);
  }
  delete state.cloudHandoffBusy[threadId];
  set();
}

export async function bringThreadBack(threadId: string): Promise<void> {
  const task = state.cache[threadId];
  const machineId = task?.cloudHandoff?.machineId;
  if (!machineId || state.cloudHandoffBusy[threadId]) return;
  state.cloudHandoffBusy[threadId] = true;
  set();
  try {
    const result = await api('/api/handoff/local', {
      method: 'POST', body: JSON.stringify({ machineId }),
    });
    if (result.task) state.cache[threadId] = result.task;
    else if (state.cache[threadId]) delete state.cache[threadId].cloudHandoff;
    toast('Back on this Mac.');
  } catch (error) {
    toast((error as Error).message);
  }
  delete state.cloudHandoffBusy[threadId];
  set();
}

// ---------------------------------------------------------------------------
// rename

export async function commitRename(val: string, input?: HTMLInputElement): Promise<void> {
  const r = state.renaming;
  if (!r) return;
  const name = (val || '').trim();
  if (r.required && (!name || /^new (?:thread|workstream)$/i.test(name))) {
    state.renaming = r;
    if (input) {
      input.setCustomValidity('Name this workstream to continue');
      try { input.reportValidity(); input.focus(); input.select(); } catch { /* ignore */ }
    }
    return;
  }
  state.renaming = null;
  try {
    if (name && r.kind === 'tab') {
      const { task } = await api('/api/tasks/' + r.threadId + '/tabs/' + r.id, { method: 'PATCH', body: JSON.stringify({ name }) });
      state.cache[r.threadId!] = task;
      await refreshThreads();
    } else if (name && r.kind === 'thread') {
      const { task } = await api('/api/tasks/' + r.id, { method: 'PATCH', body: JSON.stringify({ title: name }) });
      state.cache[r.id] = task;
      await refreshThreads();
    } else if (name && r.kind === 'project') {
      await api('/api/repos', { method: 'PATCH', body: JSON.stringify({ path: r.id, name }) });
      await refreshProjects();
    }
  } catch (e) { toast((e as Error).message); }
  set();
}

// ---------------------------------------------------------------------------
// send

const steerDeliveryChains = new Map<string, Promise<void>>();
const steerQueueFallback = new Set<string>();

function queueForNextBatch(key: string, queued: QueuedPrompt): void {
  const waiting = state.queuedPrompts[key] || (state.queuedPrompts[key] = []);
  if (!waiting.some((item) => item.id === queued.id)) waiting.push(queued);
  const stream = state.streams[key];
  if (stream?.steers) stream.steers = stream.steers.filter((item) => item.id !== queued.id);
  for (const task of Object.values(state.cache)) {
    const tab = (task.tabs || []).find((candidate) => streamKey(task.id, candidate.id) === key);
    if (tab?.activeRun?.steers) tab.activeRun.steers = tab.activeRun.steers.filter((item) => item.id !== queued.id);
  }
  set();
}

function updateLocalSteer(threadId: string, tabId: string, steer: SteeredPrompt): void {
  const key = streamKey(threadId, tabId);
  const stream = state.streams[key];
  if (stream) {
    const steers = stream.steers || (stream.steers = []);
    const index = steers.findIndex((item) => item.id === steer.id);
    if (index >= 0) steers[index] = steer;
    else steers.push(steer);
  }
  const task = state.cache[threadId];
  const tab = (task?.tabs || []).find((candidate) => candidate.id === tabId);
  if (tab?.activeRun) {
    const steers = tab.activeRun.steers || (tab.activeRun.steers = []);
    const index = steers.findIndex((item) => item.id === steer.id);
    if (index >= 0) steers[index] = steer;
    else steers.push(steer);
  }
}

async function postSteer(
  threadId: string,
  tabId: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; steer?: SteeredPrompt; queue?: boolean; error?: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/tasks/${threadId}/tabs/${tabId}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return { ok: true, steer: payload.steer };
      return { ok: false, queue: payload.queue === true, error: payload.error || `steering failed (${response.status})` };
    } catch (error) {
      if (attempt === 1) return { ok: false, queue: true, error: (error as Error).message };
    }
  }
  return { ok: false, queue: true, error: 'could not reach the active response' };
}

function deliverSteer(
  threadId: string,
  tabId: string,
  item: QueuedPrompt,
  terminalContexts: TerminalContext[],
  images: PendingImageAttachment[],
  tokens: { mentions?: { email: string; name: string }[]; contextMentions?: string[] } = {},
): void {
  const key = streamKey(threadId, tabId);
  const previous = steerDeliveryChains.get(key) || Promise.resolve();
  const delivery = previous.then(async () => {
    if (steerQueueFallback.has(key)) {
      queueForNextBatch(key, item);
      return;
    }
    const result = await postSteer(threadId, tabId, {
      requestId: item.id,
      prompt: item.prompt,
      terminalContexts,
      images,
      ...(tokens.mentions?.length ? { mentions: tokens.mentions } : {}),
      ...(tokens.contextMentions?.length ? { contextMentions: tokens.contextMentions } : {}),
    });
    if (result.ok && result.steer) {
      updateLocalSteer(threadId, tabId, { ...result.steer, delivery: 'accepted' });
      set();
      followConv(key);
      return;
    }
    steerQueueFallback.add(key);
    queueForNextBatch(key, item);
    toast(result.queue ? 'The run just finished — your message is next.' : result.error || 'Message queued for the next response.');
  });
  steerDeliveryChains.set(key, delivery);
  void delivery.finally(() => {
    if (steerDeliveryChains.get(key) === delivery) steerDeliveryChains.delete(key);
  });
}

export function triggerSend(key: string): void {
  if (key === 'home') { homeSend(); return; }
  const idx = Number(key);
  const p = state.panes[idx]; if (!p) return;
  state.activePane = idx;
  const task = state.cache[p.threadId]; const tabId = p.tabId || task.activeTab;
  const attachmentKey = streamKey(task.id, tabId);
  const images = state.pendingImages[attachmentKey] || [];
  // Paper 21.2b: the chips staged above the textarea ride the send — pings
  // as body.mentions, context picks as body.contextMentions.
  const pings = state.pendingPings[attachmentKey] || [];
  const contextRefs = state.pendingContextRefs[attachmentKey] || [];
  const clearTokens = () => { delete state.pendingPings[attachmentKey]; delete state.pendingContextRefs[attachmentKey]; };
  const typedText = (state.drafts[draftKey(idx)] || '').trim();
  if (!typedText && !images.length) return;
  const text = typedText || (images.length === 1 ? 'Please review the attached image.' : 'Please review the attached images.');
  // "/plays <name> <what to apply it to>" starts a play run instead of a turn (Paper 17.4).
  const command = typedText ? resolvePlayCommand(typedText) : null;
  if (command === 'unknown') { toast('No play by that name. Type /plays to pick one.'); return; }
  if (command) {
    state.drafts[draftKey(idx)] = '';
    delete state.playPick[idx];
    set();
    void startPlayRun(idx, command.play.id, command.instruction);
    return;
  }
  // "/hand <tab>: <message>" — Paper 21.3. Runs there; you stay put.
  const handCommand = typedText ? resolveHandCommand(typedText, task, tabId) : null;
  if (handCommand === 'unknown') { toast('Say /hand <tab>: <message> for a tab here, or /hand <workstream> / <tab>: <message> for one elsewhere.'); return; }
  if (handCommand) {
    state.drafts[draftKey(idx)] = '';
    clearTokens();
    set();
    toast(`Handed to ${handCommand.targetName}`);
    void handMessage(task.id, tabId, handCommand.targetThreadId, handCommand.targetTabId, handCommand.instruction, { mentions: pings, contextMentions: contextRefs });
    return;
  }
  // Paper 21.3: the @-picked destination chip hands the message on send.
  const handoffTarget = state.pendingHandoff[attachmentKey];
  if (handoffTarget) {
    state.drafts[draftKey(idx)] = '';
    delete state.pendingHandoff[attachmentKey];
    clearTokens();
    set();
    toast(`Handed to ${handoffTarget.name}`);
    void handMessage(task.id, tabId, handoffTarget.threadId || task.id, handoffTarget.tabId, text, { mentions: pings, contextMentions: contextRefs });
    return;
  }
  if (pings.length && !images.length) {
    state.drafts[draftKey(idx)] = '';
    delete state.contextMention[idx];
    clearTokens();
    set();
    void sendNote(task.id, tabId, text, pings);
    return;
  }
  const tab = (task.tabs || []).find((t) => t.id === tabId);
  if (tab && tab.type === 'duel') {
    const phase = duelPhase(tab);
    if (images.length && phase !== 'picked') { toast('Choose a Duel winner before adding images to this tab.'); return; }
    if (phase === 'ready') { runDuel(idx); return; }
    if (phase !== 'picked') { toast(phase === 'setup' ? 'Choose effort and lock in the contenders first.' : 'Finish this Duel before continuing.'); return; }
  }
  const terminalContextKey = streamKey(task.id, tabId);
  const terminalContexts = (state.pendingTerminalContexts[terminalContextKey] || [])
    .map((context) => ({ ...context, guidance: text }));
  const active = tab && tabRunRef(task, tab);
  captureAnalytics('message_sent', {
    ...modelAnalyticsProperties(tab?.model),
    is_steer: !!active,
    attachment_count: images.length,
    has_attachments: images.length > 0,
    has_context: terminalContexts.length > 0,
  });
  if (active) {
    const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `steer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const queued: QueuedPrompt = {
      id: requestId,
      prompt: text,
      model: tab?.model,
      queuedAt: new Date().toISOString(),
      ...(terminalContexts.length ? { terminalContexts } : {}),
      ...(images.length ? { attachments: images.map((image) => ({ ...image })) } : {}),
      // If the run cannot take it and it waits for the next turn, the chips
      // wait with it (they used to be dropped on that path).
      ...(pings.length ? { mentions: pings } : {}),
      ...(contextRefs.length ? { contextMentions: contextRefs } : {}),
    };
    updateLocalSteer(task.id, tabId, {
      id: requestId,
      prompt: text,
      prompts: [text],
      sentAt: queued.queuedAt,
      terminalContexts,
      attachments: images,
      ...(pings.length ? { mentions: pings } : {}),
      ...(contextRefs.length ? { contextRefs } : {}),
      delivery: 'sending',
    });
    state.drafts[draftKey(idx)] = '';
    delete state.contextMention[idx];
    delete state.pendingTerminalContexts[terminalContextKey];
    delete state.pendingImages[attachmentKey];
    clearTokens();
    set();
    followConv(active.key);
    deliverSteer(task.id, tabId, queued, terminalContexts, images, { mentions: pings, contextMentions: contextRefs });
    return;
  }
  state.drafts[draftKey(idx)] = '';
  delete state.contextMention[idx];
  delete state.pendingTerminalContexts[terminalContextKey];
  delete state.pendingImages[attachmentKey];
  clearTokens();
  runTab(task.id, tabId, text, tab ? tab.model : undefined, { terminalContexts, images, mentions: pings, contextMentions: contextRefs });
}

export async function homeSend(): Promise<void> {
  const images = state.pendingImages.home || [];
  const typedText = (state.drafts.home || '').trim();
  if (!typedText && !images.length) return;
  const text = typedText || (images.length === 1 ? 'Please review the attached image.' : 'Please review the attached images.');
  if (!state.homeProject) {
    if (state.projects[0]) state.homeProject = state.projects[0].path;
    else { toast('add a project first'); return; }
  }
  captureAnalytics('message_sent', {
    ...modelAnalyticsProperties(state.homeModel),
    is_steer: false,
    attachment_count: images.length,
    has_attachments: images.length > 0,
    has_context: false,
    message_origin: 'home',
  });
  state.drafts.home = '';
  const task = await createThread(state.homeProject, text.split('\n')[0].slice(0, 60));
  if (task) {
    delete state.pendingImages.home;
    state.view = 'tab';
    state.layoutRoot = task.id;
    state.panes = [{ repo: task.repo, threadId: task.id, tabId: task.activeTab }];
    set();
    runTab(task.id, task.activeTab, text, state.homeModel, { images });
  }
}

// ---------------------------------------------------------------------------
// Plays (Paper 17). The panel is the one editor; it hangs off a pane (Find a
// Play, or a run in progress) or off the Plays page, keyed by pane index or
// 'page'. A run is an agent that types through the server, so this client is
// never on the turn's stream: the run poll re-reads the tab each tick.

const PLAY_POLL_MS = 1_200;
const playPolls = new Map<string, number>();

export function playPanel(key: string): PlayPanelState {
  if (!state.playPanels[key]) state.playPanels[key] = defaultPlayPanel();
  return state.playPanels[key];
}

export async function loadPlays(): Promise<void> {
  try {
    state.plays = (await api('/api/plays')).plays || [];
    state.playsLoaded = true;
    set();
  } catch (e) { toast((e as Error).message); }
}

function stopPlayPoll(key: string): void {
  const timer = playPolls.get(key);
  if (timer) window.clearTimeout(timer);
  playPolls.delete(key);
}

function paneTab(idx: number): { task: Task; tab: Tab } | null {
  const pane = state.panes[idx]; if (!pane) return null;
  const task = state.cache[pane.threadId]; if (!task) return null;
  const tab = (task.tabs || []).find((t) => t.id === (pane.tabId || task.activeTab)) || task.tabs?.[0];
  return tab ? { task, tab } : null;
}

function draftFrom(play: Play): PlayDraft {
  return {
    name: play.name, useWhen: play.useWhen, rules: play.rules, projectId: play.projectId, repo: play.repo,
    repoName: play.repoName, sourceTaskId: play.sourceTaskId, sourceTabId: play.sourceTabId,
  };
}

export function closePlayPanel(key: string): void {
  playPanel(key).open = false;
  set();
}

// The ⚡ at the end of the tab strip. A run in progress on this tab opens on
// the run; a result that landed opens on it; otherwise Find a Play starts.
export async function togglePlayPanel(idx: number): Promise<void> {
  const key = paneTabKey(idx);
  const panel = playPanel(key);
  if (panel.open) { panel.open = false; set(); return; }
  panel.open = true;
  panel.landed = false;
  set();
  const ctx = paneTab(idx);
  if (ctx) {
    let running = Object.values(state.playRuns).find((run) => run.taskId === ctx.task.id && run.tabId === ctx.tab.id && !run.finishedAt) || null;
    if (!running) {
      try {
        const { runs } = await api(`/api/plays/runs?taskId=${encodeURIComponent(ctx.task.id)}&tabId=${encodeURIComponent(ctx.tab.id)}`);
        running = (runs as PlayRun[]).find((run) => !run.finishedAt) || null;
      } catch { /* offline: fall through */ }
    }
    if (running) {
      state.playRuns[running.id] = running;
      panel.mode = 'run'; panel.runId = running.id; panel.playId = running.playId;
      set();
      void pollPlayRun(key, running.id);
      return;
    }
  }
  if (panel.mode === 'run' && panel.runId) { set(); return; }
  if (panel.draft || (panel.jobId && state.playFindJobs[panel.jobId]?.status === 'reading')) { set(); return; }
  await findPlay(idx);
}

export async function findPlay(idx: number): Promise<void> {
  const key = paneTabKey(idx);
  const panel = playPanel(key);
  const ctx = paneTab(idx);
  if (!ctx) return;
  panel.mode = 'find'; panel.error = null; panel.draft = null; panel.dirty = false; panel.playId = null; panel.runId = null; panel.editing = false; panel.busy = true;
  set();
  try {
    const { job } = await api('/api/plays/find', { method: 'POST', body: JSON.stringify({ taskId: ctx.task.id, tabId: ctx.tab.id, model: ctx.tab.model }) });
    state.playFindJobs[job.id] = job;
    panel.jobId = job.id;
    panel.busy = false;
    set();
    captureAnalytics('play_find_started');
    void pollPlayFind(key, job.id);
  } catch (e) {
    panel.busy = false; panel.error = (e as Error).message; set();
  }
}

async function pollPlayFind(key: string, jobId: string): Promise<void> {
  stopPlayPoll(key);
  let job: PlayFindJob | null = null;
  try { job = (await api(`/api/plays/find/${jobId}`)).job; } catch { /* keep polling */ }
  const panel = playPanel(key);
  if (job) {
    state.playFindJobs[job.id] = job;
    if (panel.jobId === jobId) {
      if (job.status === 'ready' && job.result) {
        panel.mode = 'edit'; panel.draft = { ...job.result }; panel.dirty = false; panel.playId = null;
        // Landed while the panel was closed: the ⚡ goes green (Paper 16 tokens).
        if (!panel.open) panel.landed = true;
        captureAnalytics('play_found');
      } else if (job.status === 'failed' || job.status === 'stopped') {
        panel.error = job.error || 'Could not read this thread.';
      }
    }
    set();
    if (job.status !== 'reading') return;
  }
  if (panel.jobId === jobId) playPolls.set(key, window.setTimeout(() => { void pollPlayFind(key, jobId); }, PLAY_POLL_MS));
}

export function editPlayDraft(key: string, patch: Partial<PlayDraft>): void {
  const panel = playPanel(key);
  if (!panel.draft) return;
  panel.draft = { ...panel.draft, ...patch };
  panel.dirty = true;
  set();
}

export function setPlayEditing(key: string, editing: boolean): void {
  playPanel(key).editing = editing;
  set();
}

// The change input: describe the edit, the composer's model rewrites the play.
export async function revisePlayDraft(key: string, instruction: string, modelId?: string | null): Promise<void> {
  const panel = playPanel(key);
  const text = instruction.trim();
  if (!panel.draft || !text || panel.busy) return;
  panel.busy = true; panel.error = null; set();
  try {
    const { play } = await api('/api/plays/revise', { method: 'POST', body: JSON.stringify({ play: panel.draft, instruction: text, model: modelId || null }) });
    panel.draft = { ...panel.draft, ...play };
    panel.dirty = true;
    captureAnalytics('play_revised');
  } catch (e) { panel.error = (e as Error).message; }
  panel.busy = false;
  set();
}

export async function savePlayDraft(key: string): Promise<Play | null> {
  const panel = playPanel(key);
  if (!panel.draft || panel.busy) return null;
  if (!panel.draft.name.trim()) { toast('Name the play first.'); return null; }
  panel.busy = true; panel.error = null; set();
  try {
    const saved: Play = panel.playId
      ? (await api(`/api/plays/${panel.playId}`, { method: 'PATCH', body: JSON.stringify({ name: panel.draft.name, useWhen: panel.draft.useWhen, rules: panel.draft.rules }) })).play
      : (await api('/api/plays', { method: 'POST', body: JSON.stringify(panel.draft) })).play;
    panel.playId = saved.id;
    panel.draft = draftFrom(saved);
    panel.dirty = false; panel.editing = false; panel.busy = false;
    toast('Play saved');
    captureAnalytics('play_saved', { rules: saved.steps?.length || 0 });
    await loadPlays();
    return saved;
  } catch (e) {
    panel.busy = false; panel.error = (e as Error).message; set();
    return null;
  }
}

export function openPlay(key: string, playId: string): void {
  const play = state.plays.find((candidate) => candidate.id === playId);
  if (!play) return;
  const panel = playPanel(key);
  panel.open = true; panel.mode = 'edit'; panel.playId = play.id; panel.jobId = null; panel.runId = null;
  panel.error = null; panel.editing = false; panel.dirty = false; panel.landed = false;
  panel.draft = draftFrom(play);
  set();
}

export async function deletePlayById(id: string): Promise<void> {
  const play = state.plays.find((candidate) => candidate.id === id);
  if (!play) return;
  if (!window.confirm(`Delete the play “${play.name}”?\n\nThreads it ran in keep their transcripts.`)) return;
  try {
    await api(`/api/plays/${id}`, { method: 'DELETE' });
    for (const panel of Object.values(state.playPanels)) {
      if (panel.playId === id) { panel.open = false; panel.draft = null; panel.playId = null; }
    }
    await loadPlays();
    toast('Play deleted');
  } catch (e) { toast((e as Error).message); }
}

// /plays in the composer (Paper 17.4). The picker shows while the command is
// being typed; once a play's full name is in, the rest is what to apply it to.
export function playPickerQuery(text: string): string | null {
  const value = String(text || '');
  if (!value.startsWith('/')) return null;
  const match = /^\/([a-z]*)(?:\s+([^\n]*))?$/i.exec(value);
  if (!match) return null;
  const word = match[1].toLowerCase();
  if (match[2] === undefined) return 'plays'.startsWith(word) ? '' : null;
  if (word !== 'plays' && word !== 'play') return null;
  return match[2];
}

export function playsMatching(query: string): Play[] {
  const q = query.trim().toLowerCase();
  return state.plays.filter((play) => !q || play.name.toLowerCase().includes(q) || play.useWhen.toLowerCase().includes(q));
}

// Paper 21.3, the interim entry point until the composer's @ token lands:
// "/hand <tab name>: <message>" runs the message in that sibling tab, handed
// over from this one. You stay put (21.5b).
export function resolveHandCommand(text: string, task: Task | null, currentTabId: string): { targetThreadId: string; targetTabId: string; targetName: string; instruction: string } | 'unknown' | null {
  const match = /^\/hand\s+(.+)$/is.exec(String(text || '').trim());
  if (!match || !task) return match ? 'unknown' : null;
  const rest = match[1].trim();
  const lower = rest.toLowerCase();
  // A sibling by its name, or a tab elsewhere as Workstream / Tab. The
  // longest name that starts the text wins, so Main never eats Main desk.
  const siblings = (task.tabs || [])
    .filter((candidate) => candidate.id !== currentTabId && candidate.name)
    .map((candidate) => ({ threadId: task.id, tabId: candidate.id, name: candidate.name }));
  const target = [...siblings, ...destinationsElsewhere(task)]
    .filter((candidate) => lower.startsWith(candidate.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!target) return 'unknown';
  const instruction = rest.slice(target.name.length).replace(/^[:,\s]+/, '').trim();
  if (!instruction) return 'unknown';
  return { targetThreadId: target.threadId, targetTabId: target.tabId, targetName: target.name, instruction };
}

export function resolvePlayCommand(text: string): { play: Play; instruction: string } | 'unknown' | null {
  const match = /^\/plays?\s+(.+)$/is.exec(String(text || '').trim());
  if (!match) return null;
  const rest = match[1].trim();
  const lower = rest.toLowerCase();
  const play = state.plays
    .filter((candidate) => candidate.name && lower.startsWith(candidate.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!play) return 'unknown';
  return { play, instruction: rest.slice(play.name.length).trim() };
}

export function insertPlayPick(idx: number, play: Play): void {
  state.drafts[draftKey(idx)] = `/plays ${play.name} `;
  delete state.playPick[idx];
  set();
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`[data-draft="${idx}"]`);
    if (ta) { ta.focus(); const end = state.drafts[draftKey(idx)].length; ta.setSelectionRange(end, end); }
  });
}

export async function startPlayRun(idx: number, playId: string, instruction: string): Promise<void> {
  const ctx = paneTab(idx);
  if (!ctx) return;
  const key = paneTabKey(idx);
  const panel = playPanel(key);
  panel.open = true; panel.mode = 'run'; panel.error = null; panel.landed = false; panel.busy = true;
  set();
  try {
    const { run } = await api(`/api/plays/${playId}/run`, {
      method: 'POST',
      body: JSON.stringify({ taskId: ctx.task.id, tabId: ctx.tab.id, instruction, model: ctx.tab.model, effort: state.effort }),
    });
    state.playRuns[run.id] = run;
    panel.runId = run.id; panel.playId = playId; panel.busy = false;
    set();
    captureAnalytics('play_run_started', { steps: run.steps?.length || 0 });
    touch(ctx.task.id, ctx.tab.id);
    void pollPlayRun(key, run.id);
  } catch (e) {
    panel.busy = false; panel.error = (e as Error).message; set();
    toast((e as Error).message);
  }
}

async function pollPlayRun(key: string, runId: string): Promise<void> {
  stopPlayPoll(key);
  let run: PlayRun | null = null;
  try { run = (await api(`/api/plays/runs/${runId}`)).run; } catch { /* keep polling */ }
  const panel = playPanel(key);
  if (run) {
    state.playRuns[run.id] = run;
    // The turns are typed server-side, so re-read the tab each tick: the
    // transcript, the live turn and the tab dot follow along. Skip while this
    // client has its own stream in that thread (a cut-in reply).
    try {
      if (state.cache[run.taskId] && !Object.values(state.streams).some((stream) => stream.threadId === run.taskId)) await loadTask(run.taskId);
    } catch { /* ignore */ }
    if (run.finishedAt) {
      try { await refreshThreads(); } catch { /* ignore */ }
      set();
      return;
    }
    set();
  }
  if (panel.runId === runId) playPolls.set(key, window.setTimeout(() => { void pollPlayRun(key, runId); }, PLAY_POLL_MS));
}

export async function stopPlayRun(key: string): Promise<void> {
  const panel = playPanel(key);
  if (!panel.runId) return;
  try {
    const { run } = await api(`/api/plays/runs/${panel.runId}/stop`, { method: 'POST' });
    state.playRuns[run.id] = run;
    set();
    captureAnalytics('play_run_stopped');
  } catch (e) { toast((e as Error).message); }
}

// re-exports for convenience
export { savePrefs, saveCurrentLayout, persistThreadLayouts, syncThreadLayout };

// ---------------------------------------------------------------------------
// Same team (Paper section 19)

// The rail's shared projects change under you (someone accepts, comes
// online, gets removed); re-read them while any project is shared.
let projectsRefreshing = false;
export async function refreshSharedProjects(): Promise<void> {
  // Signed-in installs poll even with nothing shared yet: the first project
  // someone shares with you has to show up without a reload.
  if (projectsRefreshing || document.hidden) return;
  if (!state.authConfigured && !state.projects.some((project) => project.shared)) return;
  projectsRefreshing = true;
  try {
    const signature = (projects: Project[]) => JSON.stringify(projects.map((project) => [project.id || project.path, project.name, project.archived || false, project.shared || null]));
    const before = signature(state.projects);
    const repos = (await api('/api/repos')).repos || [];
    if (signature(repos) !== before) {
      state.projects = repos;
      await refreshThreads();
      set();
    }
  } catch { /* next tick */ } finally { projectsRefreshing = false; }
}

const typingSent = new Map<string, number>();
// A throttled "I am typing" for the other people in a shared thread.
export function noteTyping(task: Task, tab: Tab): void {
  if (!task.shared) return;
  const key = streamKey(task.id, tab.id);
  const last = typingSent.get(key) || 0;
  if (Date.now() - last < 2_500) return;
  typingSent.set(key, Date.now());
  void api(`/api/tasks/${task.id}/tabs/${tab.id}/typing`, { method: 'POST', body: JSON.stringify({ active: true }) }).catch(() => {});
}

export function openShareDialog(path: string): void {
  state.shareDialog = { path };
  set();
}

export function closeShareDialog(): void {
  state.shareDialog = null;
  set();
}

function applyShared(path: string, shared: SharedInfo | null): void {
  state.projects = state.projects.map((project) => (project.path === path ? { ...project, shared } : project));
  for (const task of Object.values(state.cache)) if (task.repo === path) task.shared = shared;
  set();
}

export async function shareProjectWith(path: string, email: string): Promise<boolean> {
  try {
    const result = await api('/api/repos/share', { method: 'POST', body: JSON.stringify({ path, email }) });
    applyShared(path, result.shared || null);
    captureAnalytics('project_shared');
    return true;
  } catch (error) {
    toast((error as Error).message);
    return false;
  }
}

export async function removeSharedMember(path: string, memberId: string): Promise<void> {
  try {
    const result = await api(`/api/repos/share?path=${encodeURIComponent(path)}&memberId=${encodeURIComponent(memberId)}`, { method: 'DELETE' });
    applyShared(path, result.shared || null);
  } catch (error) {
    toast((error as Error).message);
  }
}

const ackedQueue = new Set<string>();
// A queued message of mine that expired while my Mac was away comes back
// into the composer; it never fires on its own into a thread that moved on.
async function takeBackQueued(threadId: string, tabId: string, item: QueuedMessage): Promise<void> {
  if (ackedQueue.has(item.id)) return;
  ackedQueue.add(item.id);
  let prompt = item.prompt;
  try {
    const result = await api(`/api/team/queue/${encodeURIComponent(item.id)}/ack`, { method: 'POST' });
    const body = result.body || {};
    prompt = Array.isArray(body.prompts) && body.prompts.length ? body.prompts.join('\n\n') : (body.prompt || item.prompt);
  } catch { /* the text below still comes back */ }
  restoreToComposer(threadId, tabId, prompt);
  toast('Did not go, your Mac was away. It is back in the composer.');
}

function restoreToComposer(threadId: string, tabId: string, prompt: string): void {
  const paneIdx = state.panes.findIndex((pane) => pane.threadId === threadId && (pane.tabId || state.cache[threadId]?.activeTab) === tabId);
  if (paneIdx < 0) return;
  const current = state.drafts[draftKey(paneIdx)] || '';
  state.drafts[draftKey(paneIdx)] = current.trim() ? `${current}\n${prompt}` : prompt;
  set();
}

export async function withdrawQueued(threadId: string, tabId: string, id: string): Promise<void> {
  try {
    const result = await api(`/api/team/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = result.body || {};
    const prompt = Array.isArray(body.prompts) && body.prompts.length ? body.prompts.join('\n\n') : (body.prompt || '');
    if (prompt) restoreToComposer(threadId, tabId, prompt);
    await loadTask(threadId).catch(() => {});
    set();
  } catch (error) {
    toast((error as Error).message);
  }
}
