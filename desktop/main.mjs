import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  session,
  shell,
  Tray,
} from 'electron';
import updater from 'electron-updater';
import { createOpenThreadLinks } from './open-thread-links.mjs';
import {
  scheduledUpdateDelay,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FOCUS_DELAY_MS,
  UPDATE_WAKE_DELAY_MS,
} from './update-schedule.mjs';

const { autoUpdater } = updater;

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4757;
const START_TIMEOUT_MS = 30_000;
const UPDATE_IDLE_POLL_MS = 2_000;
const UPDATE_IDLE_STABILITY_MS = 8_000;
const SERVICE_HEALTH_POLL_MS = 2_500;
// Ten misses, about 40s: longer than the service's own 30s loop watchdog,
// which samples what the loop is doing before it kills. At three misses
// (~10s) a service busy saving a large workstream was SIGKILLed from here
// first, with no diagnostic and every run in flight lost.
const SERVICE_HEALTH_FAILURE_LIMIT = 10;
const LOCAL_SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const IS_SMOKE_TEST = process.argv.includes('--smoke-test') || process.env.CONDUCTOR_DESKTOP_SMOKE === '1';
const IS_DEEP_LINK_SMOKE = IS_SMOKE_TEST && process.argv.includes('--deep-link-smoke');
const AUTH_CALLBACK_PREFIX = 'conductor://auth/callback';

// A smoke build may run while the real desktop is open. Give it a separate
// Chromium profile so Electron's single-instance lock cannot make the test
// silently exit by handing focus to the production app.
if (IS_SMOKE_TEST && process.env.CONDUCTOR_DESKTOP_USER_DATA) {
  const smokeUserData = path.resolve(process.env.CONDUCTOR_DESKTOP_USER_DATA);
  fs.mkdirSync(smokeUserData, { recursive: true });
  app.setPath('userData', smokeUserData);
}

// Separate Chromium storage and single-instance lock from the official app.
if (!IS_SMOKE_TEST) {
  const communityProfile = path.join(os.homedir(), '.supreme-community', 'desktop-profile');
  fs.mkdirSync(communityProfile, { recursive: true, mode: 0o700 });
  app.setPath('userData', communityProfile);
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let ownsServer = false;
let quitting = false;
let serverOrigin = '';
let pendingAuthCallback = null;
let smokeExternalAuthVerified = false;
let updatesEnabled = false;
let manualUpdateCheck = false;
let updateIdleTimer = null;
let updateIdleSince = 0;
let periodicUpdateTimer = null;
let backgroundUpdateTimer = null;
let lastUpdateCheckAt = 0;
let serviceHealthTimer = null;
let serviceHealthFailures = 0;
let serviceRecovering = false;
let serviceRecoveryNoticeShown = false;
let serviceRestartCount = 0;
const openThreadLinks = createOpenThreadLinks((ref) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  mainWindow.webContents.send('supreme:open-thread', ref);
  showMainWindow();
  return true;
});
const updateState = {
  phase: 'starting',
  currentVersion: '',
  availableVersion: null,
  progress: null,
  reason: null,
  activeRuns: null,
  installWhenIdle: false,
};

function updateStateSnapshot() {
  return { ...updateState, serviceRestarts: serviceRestartCount };
}

function broadcastUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send('supreme:update-status-changed', updateStateSnapshot());
}

function setUpdateState(patch, rebuildMenu = true) {
  Object.assign(updateState, patch);
  if (rebuildMenu && app.isReady()) buildApplicationMenu();
  broadcastUpdateState();
}

function hasDeveloperIdSignature() {
  if (process.platform !== 'darwin' || !app.isPackaged) return false;
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', process.execPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const details = `${result.stdout || ''}\n${result.stderr || ''}`;
  return result.status === 0 && /Authority=Developer ID Application:/i.test(details);
}

function showUpdateDialog(options) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options);
  return dialog.showMessageBox(options);
}

async function activeRunCount() {
  if (!serverOrigin) return null;
  // A service busy driving Chrome can miss a tight deadline; one retry and a
  // longer window before the updater concludes it cannot tell.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${serverOrigin}/api/remote`, {
        signal: AbortSignal.timeout(4_000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;
      const snapshot = await response.json();
      const count = Number(snapshot?.activeCount);
      if (Number.isFinite(count) && count >= 0) return count;
    } catch { /* retry once */ }
  }
  return null;
}

function updateIsReady() {
  return updateState.phase === 'ready' || updateState.phase === 'waiting';
}

function stopUpdateIdleMonitor() {
  if (updateIdleTimer) clearTimeout(updateIdleTimer);
  updateIdleTimer = null;
  updateIdleSince = 0;
}

async function installReadyUpdate({ explain = true } = {}) {
  if (!updateIsReady()) return updateStateSnapshot();
  const active = await activeRunCount();
  if (active !== 0) {
    // Update now with agents still working (or a service too busy to answer)
    // is not a dead end: it becomes the waiting schedule, the card explains,
    // and the install fires the moment the runs land. The old dialog here
    // read as "Update now does not work".
    setUpdateState({ activeRuns: active, reason: active === null ? 'service-unavailable' : 'agents-active' }, false);
    return scheduleUpdateWhenIdle();
  }
  stopUpdateIdleMonitor();
  setUpdateState({ phase: 'installing', activeRuns: 0, installWhenIdle: false, reason: null });
  quitting = true;
  autoUpdater.quitAndInstall(false, true);
  return updateStateSnapshot();
}

function scheduleUpdateWhenIdle() {
  if (!updateIsReady()) return updateStateSnapshot();
  stopUpdateIdleMonitor();
  setUpdateState({ phase: 'waiting', installWhenIdle: true, reason: null });
  if (IS_SMOKE_TEST) {
    setUpdateState({ activeRuns: 2 }, false);
    return updateStateSnapshot();
  }

  const poll = async () => {
    if (!updateState.installWhenIdle || updateState.phase !== 'waiting' || quitting) return;
    const active = await activeRunCount();
    if (active === 0) {
      if (!updateIdleSince) updateIdleSince = Date.now();
      setUpdateState({ activeRuns: 0, reason: null }, false);
      if (Date.now() - updateIdleSince >= UPDATE_IDLE_STABILITY_MS) {
        await installReadyUpdate({ explain: false });
        return;
      }
    } else {
      updateIdleSince = 0;
      setUpdateState({
        activeRuns: active,
        reason: active === null ? 'service-unavailable' : null,
      }, false);
    }
    updateIdleTimer = setTimeout(poll, UPDATE_IDLE_POLL_MS);
    updateIdleTimer.unref();
  };
  void poll();
  return updateStateSnapshot();
}

function cancelScheduledUpdate() {
  if (updateState.phase !== 'waiting') return updateStateSnapshot();
  stopUpdateIdleMonitor();
  setUpdateState({ phase: 'ready', installWhenIdle: false, reason: null });
  return updateStateSnapshot();
}

function updaterError(error) {
  const shouldExplain = manualUpdateCheck;
  manualUpdateCheck = false;
  console.warn('[desktop] Update check failed:', error instanceof Error ? error.message : String(error));
  setUpdateState({ phase: 'error', progress: null, reason: 'check-failed' });
  if (shouldExplain) {
    void showUpdateDialog({
      type: 'warning',
      title: 'Could not check for updates',
      message: 'Supreme could not reach the update service.',
      detail: 'Your current version will keep working. Try again later.',
      buttons: ['OK'],
    });
  }
}

function stopBackgroundUpdateChecks() {
  if (periodicUpdateTimer) clearInterval(periodicUpdateTimer);
  if (backgroundUpdateTimer) clearTimeout(backgroundUpdateTimer);
  periodicUpdateTimer = null;
  backgroundUpdateTimer = null;
}

function scheduleBackgroundUpdateCheck(delay = 0, { respectRecentCheck = false } = {}) {
  if (!updatesEnabled || quitting || updateIsReady()) return;
  if (backgroundUpdateTimer) clearTimeout(backgroundUpdateTimer);
  const wait = scheduledUpdateDelay({
    delay,
    lastCheckAt: lastUpdateCheckAt,
    respectRecentCheck,
  });
  backgroundUpdateTimer = setTimeout(() => {
    backgroundUpdateTimer = null;
    void checkForUpdates();
  }, wait);
  backgroundUpdateTimer.unref();
}

async function checkForUpdates({ manual = false } = {}) {
  if (!updatesEnabled) {
    if (manual) {
      await showUpdateDialog({
        type: 'info',
        title: 'Updates are not enabled in this build',
        message: `Supreme ${app.getVersion()} is an internal unsigned build.`,
        detail: 'Install a signed Supreme release once to enable automatic updates.',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (updateIsReady() && manual) {
    await installReadyUpdate();
    return;
  }
  if (updateState.phase === 'checking' || updateState.phase === 'downloading') return;
  lastUpdateCheckAt = Date.now();
  manualUpdateCheck = manual;
  // A downloaded update waiting for a quiet moment must not stop the app from
  // learning about the releases after it (a Mac sat on 0.1.24 with 0.1.25
  // pending while 0.1.26 to 0.1.29 shipped). Check quietly: the ready state
  // stays on screen unless something newer turns up.
  quietUpdateCheck = updateIsReady();
  if (!quietUpdateCheck) setUpdateState({ phase: 'checking', progress: null, reason: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (updateState.phase !== 'error') updaterError(error);
  } finally {
    quietUpdateCheck = false;
  }
}

let quietUpdateCheck = false;
function newerThanReady(version) {
  const ready = String(updateState.availableVersion || '');
  if (!ready) return true;
  const parse = (value) => String(value).split('.').map((part) => Number(part) || 0);
  const a = parse(version);
  const b = parse(ready);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return false;
}

// electron-updater re-announces the cached update on every later check. The
// user already answered this card: a waiting schedule (After agents finish)
// must survive the re-announce, and the card must not pop again for the same
// version. Only a genuinely newer release resets the decision.
function updateDownloaded(info) {
  if (updateIsReady() && !newerThanReady(info.version)) {
    setUpdateState({ progress: 100 }, false);
    return;
  }
  setUpdateState({ phase: 'ready', availableVersion: info.version, progress: 100, reason: null, activeRuns: null, installWhenIdle: false });
  void activeRunCount().then((activeRuns) => setUpdateState({ activeRuns }, false));
}

function configureAutoUpdates() {
  updateState.currentVersion = app.getVersion();
  if (IS_SMOKE_TEST) {
    setUpdateState({
      phase: 'ready',
      availableVersion: '0.1.6',
      progress: 100,
      reason: null,
      activeRuns: 2,
      installWhenIdle: false,
    });
    return;
  }
  if (process.env.SUPREME_ENABLE_UPDATES !== '1') {
    setUpdateState({ phase: 'disabled', reason: 'community' });
    return;
  }
  if (!app.isPackaged) {
    setUpdateState({ phase: 'disabled', reason: 'development' });
    return;
  }
  if (!hasDeveloperIdSignature()) {
    setUpdateState({ phase: 'disabled', reason: 'unsigned' });
    return;
  }

  updatesEnabled = true;
  autoUpdater.autoDownload = true;
  // A downloaded update the user never clicked must still land: quitting the
  // app (or shutting the Mac down) installs it on the way out, so the next
  // launch is the new version. Quitting kills the owned service and every run
  // with it, so the "agents are active" guard has nothing left to protect.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    if (quietUpdateCheck) return;
    setUpdateState({ phase: 'checking', progress: null, reason: null });
  });
  autoUpdater.on('update-not-available', () => {
    if (quietUpdateCheck) return;
    const shouldConfirm = manualUpdateCheck;
    manualUpdateCheck = false;
    setUpdateState({ phase: 'idle', availableVersion: null, progress: null, reason: null, activeRuns: null, installWhenIdle: false });
    if (shouldConfirm) {
      void showUpdateDialog({
        type: 'info',
        title: 'Supreme is up to date',
        message: `You have the latest version of Supreme (${app.getVersion()}).`,
        buttons: ['OK'],
      });
    }
  });
  autoUpdater.on('update-available', (info) => {
    manualUpdateCheck = false;
    // The one already downloaded is still the latest: nothing changes.
    if (quietUpdateCheck && updateIsReady() && !newerThanReady(info.version)) return;
    setUpdateState({ phase: 'downloading', availableVersion: info.version, progress: 0, reason: null, activeRuns: null, installWhenIdle: false });
  });
  autoUpdater.on('download-progress', (progress) => {
    // A quiet re-check while an update is already ready or scheduled must not
    // drag the phase back to downloading.
    if (quietUpdateCheck && updateIsReady()) return;
    setUpdateState({ phase: 'downloading', progress: Math.max(0, Math.min(100, progress.percent || 0)) }, false);
  });
  autoUpdater.on('update-downloaded', updateDownloaded);
  autoUpdater.on('error', updaterError);
  setUpdateState({ phase: 'idle', reason: null });
  scheduleBackgroundUpdateCheck(15_000);
  periodicUpdateTimer = setInterval(() => { void checkForUpdates(); }, UPDATE_CHECK_INTERVAL_MS);
  periodicUpdateTimer.unref();
}

function desktopPort() {
  const requested = Number(process.env.CONDUCTOR_DESKTOP_PORT || DEFAULT_PORT);
  return Number.isInteger(requested) && requested > 0 && requested <= 65_535 ? requested : DEFAULT_PORT;
}

function serverRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-server')
    : path.resolve(DESKTOP_DIR, '..');
}

function serverEntry() {
  return path.join(serverRoot(), 'server.mjs');
}

function registerDesktopProtocol() {
  // Open OG Slack/email links without taking over another Supreme edition.
  if (IS_SMOKE_TEST) return;
  for (const scheme of ['supreme-community']) {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}

function trustedRenderer(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL() || '';
  try { return !!serverOrigin && new URL(senderUrl).origin === serverOrigin; }
  catch { return false; }
}

function validAuthCallback(value) {
  try {
    const url = new URL(value);
    // conductor://auth/callback (account sign-in) and conductor://slack/callback
    // (Add to Slack) ride the same pipe; the renderer routes by host.
    return url.protocol === 'conductor:' && (url.hostname === 'auth' || url.hostname === 'slack') && url.pathname === '/callback';
  } catch {
    return false;
  }
}

function queueAuthCallback(value) {
  if (!validAuthCallback(value)) return false;
  pendingAuthCallback = value;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('conductor:auth-callback', value);
    showMainWindow();
  }
  return true;
}

function queueDesktopUrl(value) {
  return queueAuthCallback(value) || openThreadLinks.queue(value);
}

// The home directory from the account database, not from $HOME: a launcher
// can hand the app another user's HOME and PATH (seen on a Mac with two
// accounts), and the service must never run as anyone but the signed-in user.
function realHomeDir() {
  // Explicit test mode must keep all provider-account reads in the scratch home.
  if (IS_SMOKE_TEST && process.env.HOME) return path.resolve(process.env.HOME);
  try {
    const home = os.userInfo().homedir;
    if (home && fs.existsSync(home)) return home;
  } catch { /* fall through */ }
  return os.homedir();
}

function commandPath() {
  const home = realHomeDir();
  const inherited = String(process.env.PATH || '').split(path.delimiter)
    // Another account's directories never win over this user's own binaries.
    .filter((entry) => entry && !(/^\/Users\/[^/]+/.test(entry) && !entry.startsWith(`${home}/`) && entry !== home));
  const candidates = [
    path.join(home, '.local', 'bin'),
    ...inherited,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(candidates.flatMap((value) => String(value || '').split(path.delimiter)).filter(Boolean))]
    .join(path.delimiter);
}

function canListen(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: HOST, port }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function serverIsReady(origin, timeoutMs = 1_200) {
  try {
    const response = await fetch(`${origin}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const status = await response.json();
    // `ready` and `ok` describe connected model providers, not whether the
    // local HTTP service is alive. New installs intentionally start with zero
    // providers so onboarding can connect the first one. Keep the legacy
    // fields as a rolling-update fallback for an older healthy 4747 process.
    return status?.serviceReady === true || status?.ready === true || status?.ok === true;
  } catch {
    return false;
  }
}

async function waitForServer(origin) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await serverIsReady(origin)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Supreme did not become ready at ${origin}`);
}

function pipeServerLogs(stream, method) {
  let pending = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = `[local service] ${line}`;
      method(message);
      appendLocalServiceLog(method === console.error ? 'error' : 'info', message);
    }
  });
}

function appendLocalServiceLog(level, message) {
  try {
    const directory = app.getPath('logs');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'local-service.log');
    try {
      if (fs.statSync(file).size >= LOCAL_SERVICE_LOG_MAX_BYTES) fs.truncateSync(file, 0);
    } catch {}
    const safeLine = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 4_000);
    fs.appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${safeLine}\n`, { mode: 0o600 });
  } catch {}
}

function spawnOwnedLocalService(port) {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) throw new Error(`Missing local service: ${entry}`);

  serverProcess = spawn(process.execPath, [entry], {
    cwd: serverRoot(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CONDUCTOR_DESKTOP: '1',
      CONDUCTOR_DESKTOP_PPID: String(process.pid),
      HOME: realHomeDir(),
      PATH: commandPath(),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Give the local service a private process group. Its normal SIGTERM path
    // drains active providers; the group is only a last-resort net for a
    // service crash or a helper that ignores its parent exiting.
    detached: process.platform !== 'win32',
  });
  const ownedProcess = serverProcess;
  ownsServer = true;
  pipeServerLogs(serverProcess.stdout, console.info);
  pipeServerLogs(serverProcess.stderr, console.error);
  serverProcess.once('exit', (code, signal) => {
    if (process.platform !== 'win32' && ownedProcess.pid > 1) {
      try { process.kill(-ownedProcess.pid, 'SIGTERM'); } catch {}
      const forceTree = setTimeout(() => {
        try { process.kill(-ownedProcess.pid, 'SIGKILL'); } catch {}
      }, 1_000);
      forceTree.unref();
    }
    console.info(`[desktop] Local service exited (${signal || code || 0})`);
    if (!quitting) {
      serviceRestartCount += 1;
      console.warn(`[desktop] Local service has restarted ${serviceRestartCount} time${serviceRestartCount === 1 ? '' : 's'} this app session`);
    }
    serverProcess = null;
    ownsServer = false;
    if (!quitting) setTimeout(() => { void recoverLocalService(port); }, 350);
  });
}

// The port's occupant may be Supreme's own service from a previous launch
// that wedged and never died (a hung child ignores SIGTERM, and the old
// force-kill timer died with its parent). Reclaim only what is provably ours
// — the command line must point at our app-server entry — anything else
// still gets the honest dialog.
function killOrphanedOwnService(port) {
  try {
    const pids = spawnSync('/usr/sbin/lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const command = spawnSync('/bin/ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
      if (!command.includes(path.join('app-server', 'server.mjs')) && !command.includes(serverEntry())) continue;
      console.warn(`[desktop] Killing an orphaned Supreme service (pid ${pid}) holding port ${port}`);
      process.kill(Number(pid), 'SIGKILL');
      return true;
    }
  } catch { /* fall through to the dialog */ }
  return false;
}

async function portFreedAfterReclaim(port) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await canListen(port)) return true;
  }
  return false;
}

async function startLocalService(port) {
  const origin = `http://${HOST}:${port}`;
  if (await serverIsReady(origin)) {
    console.info(`[desktop] Reusing an existing Supreme service at ${origin}`);
    return origin;
  }

  if (!(await canListen(port))) {
    if (!killOrphanedOwnService(port) || !(await portFreedAfterReclaim(port))) {
      throw new Error(`Port ${port} is occupied by another application.`);
    }
  }

  spawnOwnedLocalService(port);

  await waitForServer(origin);
  return origin;
}

async function recoverLocalService(port = desktopPort()) {
  if (quitting || serviceRecovering) return false;
  serviceRecovering = true;
  const origin = `http://${HOST}:${port}`;
  try {
    if (await serverIsReady(origin)) {
      serviceHealthFailures = 0;
      return true;
    }
    // Never kill an unknown process on 4747; Supreme's own orphaned service
    // is reclaimed, anything else keeps the port and the health loop waits.
    if (!(await canListen(port))) {
      if (!killOrphanedOwnService(port) || !(await portFreedAfterReclaim(port))) return false;
    }
    console.warn(`[desktop] Recovering the local service at ${origin}`);
    spawnOwnedLocalService(port);
    await waitForServer(origin);
    serverOrigin = origin;
    serviceHealthFailures = 0;
    serviceRecoveryNoticeShown = false;
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(origin);
    return true;
  } catch (error) {
    console.error('[desktop] Local service recovery failed:', error);
    if (!serviceRecoveryNoticeShown && mainWindow && !mainWindow.isDestroyed()) {
      serviceRecoveryNoticeShown = true;
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Supreme is reconnecting',
        message: 'The local service stopped, and Supreme could not restart it yet.',
        detail: 'Your threads are preserved. Supreme will keep retrying automatically.',
        buttons: ['Keep working'],
      });
    }
    return false;
  } finally {
    serviceRecovering = false;
  }
}

function stopServiceHealthMonitor() {
  if (serviceHealthTimer) clearTimeout(serviceHealthTimer);
  serviceHealthTimer = null;
  serviceHealthFailures = 0;
}

function startServiceHealthMonitor() {
  stopServiceHealthMonitor();
  const poll = async () => {
    if (quitting) return;
    if (serverOrigin && await serverIsReady(serverOrigin, 1_500)) {
      serviceHealthFailures = 0;
    } else {
      serviceHealthFailures += 1;
      if (serviceHealthFailures >= SERVICE_HEALTH_FAILURE_LIMIT) await recoverLocalService();
    }
    serviceHealthTimer = setTimeout(poll, SERVICE_HEALTH_POLL_MS);
    serviceHealthTimer.unref();
  };
  serviceHealthTimer = setTimeout(poll, SERVICE_HEALTH_POLL_MS);
  serviceHealthTimer.unref();
}

async function openExternalAuth(event, value) {
  if (!trustedRenderer(event)) throw new Error('Untrusted authentication request.');
  let target;
  try { target = new URL(value); } catch { throw new Error('Invalid authentication URL.'); }
  if (target.protocol !== 'https:') throw new Error('Authentication must use HTTPS.');
  // Add to Slack: the one other consent page this bridge will open.
  const slackConsent = target.origin === 'https://slack.com' && target.pathname === '/oauth/v2/authorize';
  if (slackConsent) {
    if (IS_SMOKE_TEST) { smokeExternalAuthVerified = true; return; }
    await shell.openExternal(target.toString());
    return;
  }

  const response = await fetch(`${serverOrigin}/api/auth/config`, {
    signal: AbortSignal.timeout(2_000),
    headers: { Accept: 'application/json' },
  });
  const config = await response.json().catch(() => ({}));
  if (!response.ok || !config.configured || !config.url) throw new Error('Account sign-in is not configured.');
  const configuredOrigin = new URL(config.url).origin;
  if (target.origin !== configuredOrigin || !target.pathname.startsWith('/auth/')) {
    throw new Error('Authentication URL does not match the configured account provider.');
  }
  if (IS_SMOKE_TEST) {
    smokeExternalAuthVerified = true;
    console.info('CONDUCTOR_DESKTOP_EXTERNAL_AUTH_READY');
    return;
  }
  await shell.openExternal(target.toString());
}

async function chooseProjectFolder(event) {
  if (!trustedRenderer(event)) throw new Error('Untrusted folder request.');
  if (IS_SMOKE_TEST) {
    return { path: '/tmp/conductor-desktop-smoke-project' };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Git project folder',
    buttonLabel: 'Add Project',
    properties: ['openDirectory'],
    message: 'Choose an existing project that uses Git.',
  });
  if (result.canceled || result.filePaths.length !== 1) return null;
  const selectedPath = path.resolve(result.filePaths[0]);
  return { path: selectedPath };
}

function registerIpcHandlers() {
  ipcMain.handle('supreme:open-thread:ready', (event) => {
    if (!trustedRenderer(event)) return false;
    openThreadLinks.setReady(true);
    return true;
  });
  ipcMain.handle('conductor:open-external-auth', openExternalAuth);
  ipcMain.handle('conductor:choose-project-folder', chooseProjectFolder);
  ipcMain.handle('conductor:auth-callback:take', (event) => {
    if (!trustedRenderer(event)) return null;
    const value = pendingAuthCallback;
    // The renderer's real auth bootstrap and the smoke verifier both inspect
    // the callback. Keep the fake callback available only during smoke; a
    // production one-time code is still cleared immediately after the read.
    if (!IS_SMOKE_TEST) pendingAuthCallback = null;
    return value;
  });
  ipcMain.on('conductor:auth-callback:ack', (event, value) => {
    if (!IS_SMOKE_TEST && trustedRenderer(event) && pendingAuthCallback === value) pendingAuthCallback = null;
  });
  ipcMain.handle('supreme:update-status', (event) => {
    if (!trustedRenderer(event)) return null;
    return updateStateSnapshot();
  });
  ipcMain.handle('supreme:check-for-updates', async (event, manual = true) => {
    if (!trustedRenderer(event)) return null;
    await checkForUpdates({ manual: manual !== false });
    return updateStateSnapshot();
  });
  ipcMain.handle('supreme:install-update', async (event, mode) => {
    if (!trustedRenderer(event)) return null;
    if (mode === 'idle') return scheduleUpdateWhenIdle();
    if (mode === 'cancel') return cancelScheduledUpdate();
    if (mode === 'now') return installReadyUpdate({ explain: false });
    throw new Error('Invalid update action.');
  });

  // Paper 20.1: a macOS notification for a landing you were not watching, or
  // a failure that needs you. Clicking it brings Supreme forward on that
  // thread; nothing else is clickable, so there is no wrong place to land.
  ipcMain.handle('supreme:notify', (event, payload) => {
    if (!trustedRenderer(event)) return false;
    if (!Notification.isSupported()) return false;
    const { title, body, threadId, tabId } = payload || {};
    const note = new Notification({
      title: String(title || 'Supreme').slice(0, 120),
      body: String(body || '').slice(0, 240),
    });
    note.on('click', () => {
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && threadId) {
        mainWindow.webContents.send('supreme:open-thread', { taskId: String(threadId), tabId: tabId ? String(tabId) : null });
      }
    });
    note.show();
    return true;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildApplicationMenu() {
  const updateItem = updateIsReady()
    ? { label: `Restart to Install Supreme ${updateState.availableVersion || ''}`.trim(), click: () => { void installReadyUpdate(); } }
    : {
        label: updateState.phase === 'checking' ? 'Checking for Updates…' : 'Check for Updates…',
        enabled: updateState.phase !== 'checking' && updateState.phase !== 'downloading',
        click: () => { void checkForUpdates({ manual: true }); },
      };
  const template = [
    {
      label: 'Supreme',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Open Supreme', accelerator: 'CommandOrControl+Shift+O', click: showMainWindow },
        updateItem,
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const trayAsset = path.join(DESKTOP_DIR, 'assets', 'trayTemplate.svg');
  const image = nativeImage.createFromPath(trayAsset).resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('Supreme');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Supreme', click: showMainWindow },
    { label: `Local service · ${serverOrigin.replace('http://', '')}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit Supreme', click: () => app.quit() },
  ]));
  tray.on('double-click', showMainWindow);
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'Supreme',
    backgroundColor: '#FAF9F6',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(DESKTOP_DIR, 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Right-click in any field gets the standard edit menu (a first-time user
  // could not paste a LinkedIn link at sign up). The renderer draws its own
  // menus for rail rows; this one only appears for editable targets and
  // selected text, so the two never overlap.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      );
    } else if (String(params.selectionText || '').trim()) {
      items.push({ role: 'copy' });
    }
    if (items.length && mainWindow) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin === serverOrigin) return; } catch { /* block malformed navigation */ }
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('focus', () => {
    scheduleBackgroundUpdateCheck(UPDATE_FOCUS_DELAY_MS, { respectRecentCheck: true });
  });
  mainWindow.on('closed', () => { mainWindow = null; openThreadLinks.setReady(false); });
  mainWindow.webContents.on('did-start-loading', () => openThreadLinks.setReady(false));
  // did-finish-load can precede isLoading() becoming false. Retain a queued
  // cold-start/reload link until both workspace boot and loading have finished.
  mainWindow.webContents.on('did-stop-loading', () => openThreadLinks.flush());
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    console.info('CONDUCTOR_DESKTOP_READY');
    broadcastUpdateState();
    if (pendingAuthCallback) mainWindow.webContents.send('conductor:auth-callback', pendingAuthCallback);
    openThreadLinks.flush();
    if (IS_SMOKE_TEST) {
      void (IS_DEEP_LINK_SMOKE ? verifyDeepLinkSmoke(mainWindow) : verifySmokeRenderer(mainWindow)).then(
        () => app.quit(),
        (error) => {
          console.error('[desktop] Renderer smoke failed:', error);
          app.exit(1);
        },
      );
    }
  });

  // The renderer used to install the PWA service worker on the desktop origin.
  // That cache survives app upgrades and can resurrect an older hashed UI bundle
  // if the local service is briefly unavailable during a reload. The desktop
  // always waits for the local service before loading, so cached shell assets are
  // neither needed nor safe here. Keep cookies/localStorage/IndexedDB intact so
  // account sessions and workspace preferences are unaffected.
  await session.defaultSession.clearStorageData({
    origin: serverOrigin,
    storages: ['serviceworkers', 'cachestorage'],
  });
  await mainWindow.loadURL(serverOrigin);
}


// These fixtures run only in the explicitly isolated deep-link smoke process.
let deepLinkSmokeRefs = null;
async function seedDeepLinkSmoke() {
  const scratch = path.resolve(process.env.WORKBENCH_HOME || '');
  const prefix = path.join(os.tmpdir(), 'supreme-deep-link-smoke-');
  if (!scratch.startsWith(prefix) || !process.env.CONDUCTOR_DESKTOP_USER_DATA?.startsWith(scratch + path.sep)
    || desktopPort() !== 4791 || process.env.WB_MODEL_USAGE_FIXTURE !== '1'
    || process.env.SUPABASE_URL !== '' || process.env.SUPABASE_ANON_KEY !== '') {
    throw new Error('Deep-link smoke requires an isolated scratch home, profile, disabled accounts and port 4791.');
  }
  const call = async (route, body) => {
    const response = await fetch(serverOrigin + route, { method: route === '/api/settings' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Could not seed deep-link fixture: ' + route);
    return response.json();
  };
  await call('/api/settings', { defaultModel: 'sonnet', onboarding: { complete: true, signedIn: true, step: 'complete', email: 'deep-link@example.invalid' } });
  const { repo } = await call('/api/repos', { name: 'Deep link test' });
  const { task: first } = await call('/api/tasks', { repo: repo.path, model: 'sonnet', title: 'Email target' });
  const { tab: secondTab } = await call('/api/tasks/' + first.id + '/tabs', { model: 'sonnet', name: 'Specific email tab' });
  const { task: other } = await call('/api/tasks', { repo: repo.path, model: 'sonnet', title: 'Other email target' });
  deepLinkSmokeRefs = { first, secondTab, other };
  const cold = 'supreme://open?thread=' + first.id + '&tab=' + secondTab.id;
  app.emit('open-url', { preventDefault() {} }, cold);
}

async function verifyDeepLinkSmoke(window) {
  const { first, secondTab, other } = deepLinkSmokeRefs;
  let checks = 0;
  const check = (condition, label) => {
    if (!condition) throw new Error('Deep-link smoke failed: ' + label);
    checks += 1;
    console.info('PASS ' + label);
  };
  const selected = async () => window.webContents.executeJavaScript(
    "({tabId:document.querySelector('.tabs .tab.sel')?.getAttribute('data-tab-id'),header:document.querySelector('.pane .paneh')?.textContent||'',body:document.body.innerText.slice(0,800),bridge:typeof window.conductorDesktop?.readyForOpenThread})"
  );
  const waitSelection = async (task, tab) => {
    const end = Date.now() + 12_000;
    let last;
    while (Date.now() < end) {
      const value = await selected().catch(() => null);
      last = value;
      if (value?.tabId === tab.id && value.header.includes(task.title)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.error('DEEP LINK EXPECTED', JSON.stringify({ thread: task.title, tab: tab.id, actual: last }));
    return false;
  };
  const link = (task, tab) => 'supreme://open?thread=' + task.id + '&tab=' + tab.id;
  check(await waitSelection(first, secondTab), 'cold email link opens the exact non-primary tab after workspace boot');
  app.emit('open-url', { preventDefault() {} }, link(other, other.tabs[0]));
  check(await waitSelection(other, other.tabs[0]), 'hot macOS open-url opens the requested other workstream');
  app.emit('second-instance', {}, ['Supreme', link(first, first.tabs[0])]);
  check(await waitSelection(first, first.tabs[0]), 'second-instance arguments select the requested tab');
  app.emit('open-url', { preventDefault() {} }, link(other, other.tabs[0]) + '&prompt=send');
  await new Promise(resolve => setTimeout(resolve, 250));
  check((await selected()).tabId === first.tabs[0].id, 'an unsupported link cannot navigate or submit a prompt');
  const started = new Promise(resolve => window.webContents.once('did-start-loading', resolve));
  window.webContents.reload();
  await started;
  app.emit('open-url', { preventDefault() {} }, link(first, secondTab));
  check(await waitSelection(first, secondTab), 'a link received during reload survives the new renderer boot');
  const remote = await fetch(serverOrigin + '/api/remote').then(response => response.json());
  check(remote.activeCount === 0, 'opening links starts no model runs');
  const tasks = await Promise.all([first, other].map(task => fetch(serverOrigin + '/api/tasks/' + task.id).then(response => response.json())));
  check(tasks.every(({ task }) => task.tabs.every(tab => !tab.messages?.length)), 'opening links creates no messages or sends');
  console.info('SUPREME DEEP LINK SMOKE: PASS (' + checks + ' checks)');
}

async function verifySmokeRenderer(window) {
  const deadline = Date.now() + 10_000;
  let callbackVerified = false;
  let folderVerified = false;
  let updateReadyNoticeVerified = false;
  let updateDeferredNoticeVerified = false;
  let updateRedeliveryVerified = false;
  let lastCheck = {};
  while (Date.now() < deadline) {
    const snapshot = await window.webContents.executeJavaScript(`(async () => {
      const bridge = window.conductorDesktop;
      const callback = bridge ? await bridge.takeAuthCallback() : null;
      const folder = bridge ? await bridge.chooseProjectFolder() : null;
      const updateStatus = bridge ? await bridge.getUpdateStatus() : null;
      const authConfig = await fetch('/api/auth/config').then((response) => response.json()).catch(() => ({}));
      const appRoot = document.getElementById('app');
      const dragRegion = appRoot ? getComputedStyle(appRoot, '::before').webkitAppRegion : '';
      const updateNotice = document.querySelector('.desktop-update-card')?.textContent || '';
      const readyUpdateActionLabels = [...document.querySelectorAll('.desktop-update-actions button')]
        .map((button) => (button.textContent || '').trim());
      const readyUpdateNoticeVisible = /an update is ready/i.test(updateNotice)
        && /update now/i.test(updateNotice)
        && /update after agents finish/i.test(updateNotice);
      const deferredUpdateStatus = updateStatus?.phase === 'ready' && readyUpdateNoticeVisible && bridge
        ? await bridge.installUpdate('idle')
        : updateStatus;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deferredUpdateControl = document.querySelector('.desktop-update-waiting');
      const deferredUpdateControlText = deferredUpdateControl?.textContent || '';
      if (deferredUpdateControl instanceof HTMLButtonElement) deferredUpdateControl.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reopenedUpdateNotice = document.querySelector('.desktop-update-card')?.textContent || '';
      const serviceWorkerRegistrations = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistrations().then((items) => items.length).catch(() => -1)
        : 0;
      const cacheKeys = 'caches' in window
        ? await caches.keys().catch(() => ['unavailable'])
        : [];
      const googleButton = [...document.querySelectorAll('button')]
        .find((button) => /continue with google/i.test(button.textContent || ''));
      if (googleButton && !googleButton.disabled) googleButton.click();
      return {
        bodyText: document.body?.innerText || '',
        desktopBridge: bridge?.isDesktop === true,
        folderPicker: typeof bridge?.chooseProjectFolder === 'function',
        updaterBridge: typeof bridge?.getUpdateStatus === 'function'
          && typeof bridge?.checkForUpdates === 'function'
          && typeof bridge?.installUpdate === 'function'
          && typeof bridge?.onUpdateStatus === 'function',
        authCallbackUrl: bridge?.authCallbackUrl || '',
        authConfigured: authConfig?.configured === true,
        googleButtonPresent: !!googleButton,
        desktopClass: document.documentElement.classList.contains('desktop-shell'),
        dragRegion,
        callback,
        folder,
        updateStatus,
        updateNotice,
        readyUpdateActionLabels,
        deferredUpdateStatus,
        deferredUpdateControlText,
        reopenedUpdateNotice,
        serviceWorkerRegistrations,
        cacheKeys,
      };
    })()`, true);
    const normalized = String(snapshot.bodyText).replace(/\s+/g, ' ').trim();
    if (snapshot.callback === 'conductor://auth/callback?code=desktop-smoke') callbackVerified = true;
    if (snapshot.folder?.path === '/tmp/conductor-desktop-smoke-project') folderVerified = true;
    if (snapshot.updateStatus?.phase === 'ready'
      && /an update is ready/i.test(snapshot.updateNotice || '')
      && /update now/i.test(snapshot.updateNotice || '')
      && /update after agents finish/i.test(snapshot.updateNotice || '')
      && snapshot.readyUpdateActionLabels?.join('|') === 'Update after agents finish|Update now') updateReadyNoticeVerified = true;
    if (snapshot.deferredUpdateStatus?.phase === 'waiting'
      && snapshot.deferredUpdateStatus?.installWhenIdle === true
      && /update waiting/i.test(snapshot.deferredUpdateControlText || '')
      && /an update is ready/i.test(snapshot.reopenedUpdateNotice || '')
      && /update after agents finish/i.test(snapshot.reopenedUpdateNotice || '')
      && /update now/i.test(snapshot.reopenedUpdateNotice || '')) updateDeferredNoticeVerified = true;
    if (updateDeferredNoticeVerified && !updateRedeliveryVerified) {
      // The updater re-announcing the same version must not undo the user's
      // After-agents-finish choice or pop the card again.
      updateDownloaded({ version: updateState.availableVersion });
      if (updateState.phase === 'waiting' && updateState.installWhenIdle === true) updateRedeliveryVerified = true;
    }
    const bridgeReady = snapshot.desktopBridge === true
      && snapshot.folderPicker === true
      && snapshot.updaterBridge === true
      && snapshot.authCallbackUrl === AUTH_CALLBACK_PREFIX
      && snapshot.authConfigured === false
      && snapshot.googleButtonPresent === false
      && snapshot.desktopClass === true
      && snapshot.dragRegion === 'drag'
      && snapshot.serviceWorkerRegistrations === 0
      && snapshot.cacheKeys?.length === 0
      && ['ready', 'waiting'].includes(snapshot.updateStatus?.phase)
      && snapshot.updateStatus?.currentVersion === app.getVersion()
      && snapshot.updateStatus?.availableVersion === '0.1.6'
      && updateReadyNoticeVerified
      && updateDeferredNoticeVerified
      && updateRedeliveryVerified
      && callbackVerified
      && folderVerified
      ;
    lastCheck = {
      desktopBridge: snapshot.desktopBridge,
      folderPicker: snapshot.folderPicker,
      updaterBridge: snapshot.updaterBridge,
      authCallbackUrl: snapshot.authCallbackUrl,
      authConfigured: snapshot.authConfigured,
      desktopClass: snapshot.desktopClass,
      dragRegion: snapshot.dragRegion,
      serviceWorkerRegistrations: snapshot.serviceWorkerRegistrations,
      cacheKeys: snapshot.cacheKeys,
      updatePhase: snapshot.updateStatus?.phase,
      updateVersion: snapshot.updateStatus?.currentVersion,
      updateNotice: String(snapshot.updateNotice || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      readyUpdateActionLabels: snapshot.readyUpdateActionLabels,
      deferredUpdatePhase: snapshot.deferredUpdateStatus?.phase,
      deferredUpdateControl: String(snapshot.deferredUpdateControlText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      reopenedUpdateNotice: String(snapshot.reopenedUpdateNotice || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      updateReadyNoticeVerified,
      updateDeferredNoticeVerified,
      updateRedeliveryVerified,
      callbackVerified,
      folderVerified,
      externalAuthVerified: smokeExternalAuthVerified,
      supremeRendered: /supreme/i.test(normalized),
      preview: normalized.slice(0, 120),
    };
    if (bridgeReady && /supreme/i.test(normalized) && normalized.length >= 20 && !/loading (?:conductor|supreme)/i.test(normalized)) {
      const screenshotPath = process.env.CONDUCTOR_DESKTOP_SMOKE_SCREENSHOT;
      if (screenshotPath) {
        const outputPath = path.resolve(screenshotPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const capture = await window.webContents.capturePage();
        fs.writeFileSync(outputPath, capture.toPNG());
        console.info(`CONDUCTOR_DESKTOP_SCREENSHOT ${outputPath}`);
      }
      console.info(`CONDUCTOR_DESKTOP_UI_READY ${JSON.stringify(normalized.slice(0, 160))}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`React did not finish rendering before the smoke timeout: ${JSON.stringify(lastCheck)}`);
}

function stopLocalService() {
  if (!ownsServer || !serverProcess || serverProcess.killed) return;
  const child = serverProcess;
  child.kill('SIGTERM');
  const forceStop = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }, 8_000);
  forceStop.unref();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  registerDesktopProtocol();
  for (const value of process.argv) queueDesktopUrl(value);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueDesktopUrl(url);
  });
  app.on('second-instance', (_event, argv) => {
    for (const value of argv) queueDesktopUrl(value);
    showMainWindow();
  });
  app.on('activate', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
    else if (serverOrigin) await createMainWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    stopUpdateIdleMonitor();
    stopBackgroundUpdateChecks();
    stopServiceHealthMonitor();
    stopLocalService();
  });
  app.on('window-all-closed', () => {
    // Supreme remains available in the menu bar on macOS.
  });

  app.whenReady().then(async () => {
    app.setName('Supreme Community');
    buildApplicationMenu();
    registerIpcHandlers();
    try {
      serverOrigin = await startLocalService(desktopPort());
      if (IS_DEEP_LINK_SMOKE) await seedDeepLinkSmoke();
      createTray();
      // Seed update state before the renderer mounts. Otherwise the initial
      // broadcast can race did-finish-load and a newly opened window never
      // sees an already-downloaded update until another updater event occurs.
      configureAutoUpdates();
      powerMonitor.on('resume', () => scheduleBackgroundUpdateCheck(UPDATE_WAKE_DELAY_MS, { respectRecentCheck: true }));
      powerMonitor.on('unlock-screen', () => scheduleBackgroundUpdateCheck(UPDATE_WAKE_DELAY_MS, { respectRecentCheck: true }));
      await createMainWindow();
      startServiceHealthMonitor();
    } catch (error) {
      console.error('[desktop] Startup failed:', error);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Supreme could not start',
        message: 'Supreme could not start its local service.',
        detail: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    }
  });
}
