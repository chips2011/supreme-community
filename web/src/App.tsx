import { useEffect, useRef } from 'react';
import { useApp, getState, set } from './store';
import { refreshVisibleRuns, refreshSharedProjects, loadRemote, refreshMap, loadSchedules, handleGlobalKeyDown, markOnScreenSeen, reportViewing } from './actions';
import { refreshRailWatch } from './lib/rail';
import { syncSeen } from './lib/seen';
import { Rail } from './components/Rail';
import { Home } from './components/Home';
import { TabView } from './components/TabView';
import { LandedView } from './components/LandedView';
import { SlackInboxView } from './components/SlackInboxView';
import { WorkspaceSearch } from './components/WorkspaceSearch';
import { MapView } from './components/MapView';
import { MapsView } from './components/MapsView';
import { ScheduledView } from './components/ScheduledView';
import { RemoteView } from './components/RemoteView';
import { PerformanceView } from './components/PerformanceView';
import { DuelsView } from './components/DuelsView';
import { RoutingView } from './components/Stub';
import { PlaysView } from './components/PlaysView';
import { ModelsView } from './components/ModelsView';
import { ContextView } from './components/ContextView';
import { ConnectorsView } from './components/ConnectorsView';
import { OnboardingView } from './components/OnboardingView';
import { Popovers } from './components/Popovers';
import { ShareDialog } from './components/ShareDialog';
import { Toast } from './components/Toast';
import { AuthGate, AuthLoading } from './components/AuthGate';
import { DesktopUpdateNotice } from './components/DesktopUpdateNotice';
import { MotionDemo } from './components/MotionDemo';
import { ensureBackendSession, initializeAuth } from './auth';
import { dragEnd } from './lib/dnd';

let authStarted = false;

function MainView() {
  const s = useApp();
  switch (s.view) {
    case 'home': return <Home />;
    case 'tab': return <TabView />;
    case 'landed': return <LandedView />;
    case 'slack': return <SlackInboxView />;
    case 'map': return <MapView />;
    case 'maps': return <MapsView />;
    case 'scheduled': return <ScheduledView />;
    case 'plays': return <PlaysView />;
    case 'duels': return <DuelsView />;
    case 'performance': return <PerformanceView />;
    case 'routing': return <RoutingView />;
    case 'remote': return <RemoteView />;
    case 'models': return <ModelsView />;
    case 'context': return <ContextView />;
    case 'connectors': return <ConnectorsView />;
    case 'onboarding': return <OnboardingView />;
    default: return null;
  }
}

export function App() {
  const s = useApp();
  const started = useRef(false);

  useEffect(() => {
    // Coming back to the window is looking at the tabs on screen; the rail
    // stops calling their landings new.
    window.addEventListener('focus', markOnScreenSeen);
    return () => window.removeEventListener('focus', markOnScreenSeen);
  }, []);
  useEffect(() => {
    // Presence v2: keep the service current on which shared tab is focused.
    const timer = window.setInterval(() => reportViewing(), 2_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!authStarted) {
      authStarted = true;
      void initializeAuth().then(() => ensureBackendSession());
    }
    if (started.current) return;
    started.current = true;
    const runsTimer = setInterval(refreshVisibleRuns, 1200);
    const sharedTimer = setInterval(() => { void refreshSharedProjects(); }, 4_000);
    // Section 28: answers an orchestrator is waiting on land in workstreams
    // that are not open, so the rail reads just those rows back.
    const railTimer = setInterval(() => { void refreshRailWatch(); }, 4_000);
    // Section 34: Landed is one list across this Mac and the phone, so what
    // was read on either side travels every few seconds.
    void syncSeen({ force: true });
    const seenTimer = setInterval(() => { void syncSeen(); }, 5_000);
    // Section 29: the rail's Scheduled count and a tab's chip read the list
    // of tasks, which is a few hundred bytes; the page itself looks more often.
    void loadSchedules();
    const scheduleTimer = setInterval(() => { if (!document.hidden) void loadSchedules(); }, 30_000);
    // Runs hidden too: a minimised window must still renew its sign-in.
    const backendSessionTimer = setInterval(() => { void ensureBackendSession(); }, 5_000);
    const remoteTimer = setInterval(() => {
      if (getState().view === 'remote' && !document.hidden) loadRemote({ quiet: true });
      // Connected tabs: the map on screen follows edits made elsewhere (a
      // teammate, a tab that just went), a few hundred bytes at a time.
      if (getState().view === 'map' && !document.hidden) void refreshMap();
    }, 2500);
    const reconnectBackend = () => { if (!document.hidden) void ensureBackendSession(); };
    // Paper 16.10: sleep is a function of time, so the room re-reads its
    // clocks once a minute while someone is looking, and on the next paint
    // after they come back. No animation fires while nobody is watching.
    const sleepTimer = setInterval(() => { if (!document.hidden) set(); }, 60_000);
    const wakeRoom = () => { if (!document.hidden) set(); };
    // Native dragend is not guaranteed when a drag is released outside the
    // window. Clear any leftover drag state on the next safe pointer/window
    // boundary so an invisible split/drop layer can never trap navigation.
    const dragIsStuck = () => {
      const appRoot = document.getElementById('app');
      return !!getState().drag || !!appRoot && [
        'dragging', 'dragging-project', 'dragging-thread', 'dragging-context',
      ].some((name) => appRoot.classList.contains(name));
    };
    const clearStaleDrag = () => { if (dragIsStuck()) dragEnd(); };
    const clearDragOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !dragIsStuck()) return;
      // A stuck native drag owns Escape. Do not let the normal Escape shortcut
      // fall through and stop an unrelated model run in the selected pane.
      event.preventDefault();
      event.stopImmediatePropagation();
      dragEnd();
    };
    window.addEventListener('keydown', clearDragOnEscape, true);
    window.addEventListener('keydown', handleGlobalKeyDown);
    window.addEventListener('online', reconnectBackend);
    window.addEventListener('blur', clearStaleDrag);
    window.addEventListener('pointerup', clearStaleDrag);
    window.addEventListener('dragend', clearStaleDrag);
    document.addEventListener('visibilitychange', reconnectBackend);
    document.addEventListener('visibilitychange', wakeRoom);
    return () => {
      clearInterval(runsTimer);
      clearInterval(sharedTimer);
      clearInterval(railTimer);
      clearInterval(seenTimer);
      clearInterval(scheduleTimer);
      clearInterval(backendSessionTimer);
      clearInterval(remoteTimer);
      clearInterval(sleepTimer);
      document.removeEventListener('visibilitychange', wakeRoom);
      window.removeEventListener('keydown', clearDragOnEscape, true);
      window.removeEventListener('keydown', handleGlobalKeyDown);
      window.removeEventListener('online', reconnectBackend);
      window.removeEventListener('blur', clearStaleDrag);
      window.removeEventListener('pointerup', clearStaleDrag);
      window.removeEventListener('dragend', clearStaleDrag);
      document.removeEventListener('visibilitychange', reconnectBackend);
    };
  }, []);

  if (!s.authReady) return <><AuthLoading /><DesktopUpdateNotice /></>;
  if (s.authConfigured && !s.session) return <><AuthGate /><DesktopUpdateNotice /></>;

  return (
    <>
      {s.railOpen && s.view !== 'onboarding' ? <Rail /> : null}
      <div className="main">
        <MainView />
        <Popovers />
        {s.workspaceSearchOpen ? <WorkspaceSearch /> : null}
      <ShareDialog />
        <Toast />
        <DesktopUpdateNotice />
        {new URLSearchParams(location.search).get('motiondemo') === '1' ? <MotionDemo /> : null}
      </div>
    </>
  );
}
