import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './App';
import { flushAnalytics, initializeAnalytics } from './analytics';
import { openThreadAt } from './actions';

initializeAnalytics();
window.addEventListener('pagehide', flushAnalytics);

// Electron's hidden title bar needs explicit draggable regions in the renderer.
// Keep this class desktop-only so the browser/PWA layout is unchanged.
// A macOS notification click arrives here with the thread and tab it was
// about; the same route is exposed for the smoke, which has no Electron.
(window as unknown as { __supremeOpenThread?: typeof openThreadAt }).__supremeOpenThread = openThreadAt;
window.conductorDesktop?.onOpenThread?.((ref) => { void openThreadAt(ref.taskId, ref.tabId); });
if (window.conductorDesktop?.isDesktop) {
  document.documentElement.classList.add('desktop-shell');
  window.addEventListener('online', () => {
    void window.conductorDesktop?.checkForUpdates(false).catch(() => {});
  });
}

const el = document.getElementById('app');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The browser/PWA keeps its network-first offline shell. Supreme Desktop does
// not: its local service must be ready before the window opens, and a persisted
// service-worker cache can otherwise serve a renderer from an older app release.
// Remove legacy desktop registrations without touching auth storage.
if ('serviceWorker' in navigator) {
  if (window.conductorDesktop?.isDesktop) {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
    if ('caches' in window) {
      void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {});
    }
  } else if (import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
