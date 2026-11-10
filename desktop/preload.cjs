const { contextBridge, ipcRenderer } = require('electron');

const authListeners = new Map();
const updateListeners = new Map();

contextBridge.exposeInMainWorld('conductorDesktop', Object.freeze({
  isDesktop: true,
  isSmokeTest: process.env.CONDUCTOR_DESKTOP_SMOKE === '1' || process.argv.includes('--smoke-test'),
  authCallbackUrl: 'conductor://auth/callback',
  openExternalAuth(url) {
    return ipcRenderer.invoke('conductor:open-external-auth', url);
  },
  takeAuthCallback() {
    return ipcRenderer.invoke('conductor:auth-callback:take');
  },
  onAuthCallback(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, url) => {
      listener(url);
      ipcRenderer.send('conductor:auth-callback:ack', url);
    };
    authListeners.set(listener, wrapped);
    ipcRenderer.on('conductor:auth-callback', wrapped);
    return () => {
      const registered = authListeners.get(listener);
      if (!registered) return;
      authListeners.delete(listener);
      ipcRenderer.removeListener('conductor:auth-callback', registered);
    };
  },
  chooseProjectFolder() {
    return ipcRenderer.invoke('conductor:choose-project-folder');
  },
  getUpdateStatus() {
    return ipcRenderer.invoke('supreme:update-status');
  },
  checkForUpdates(manual = true) {
    return ipcRenderer.invoke('supreme:check-for-updates', manual !== false);
  },
  installUpdate(mode) {
    return ipcRenderer.invoke('supreme:install-update', mode);
  },
  notify(payload) {
    return ipcRenderer.invoke('supreme:notify', payload);
  },
  onOpenThread(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, ref) => listener(ref);
    ipcRenderer.on('supreme:open-thread', wrapped);
    return () => ipcRenderer.removeListener('supreme:open-thread', wrapped);
  },
  readyForOpenThread() {
    return ipcRenderer.invoke('supreme:open-thread:ready');
  },
  onUpdateStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, status) => listener(status);
    updateListeners.set(listener, wrapped);
    ipcRenderer.on('supreme:update-status-changed', wrapped);
    return () => {
      const registered = updateListeners.get(listener);
      if (!registered) return;
      updateListeners.delete(listener);
      ipcRenderer.removeListener('supreme:update-status-changed', registered);
    };
  },
}));
