/// <reference types="vite/client" />

interface ConductorDesktopProjectFolder {
  path: string;
}

interface SupremeDesktopUpdateStatus {
  phase: 'starting' | 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'waiting' | 'installing' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  reason: string | null;
  activeRuns: number | null;
  installWhenIdle: boolean;
}

interface ConductorDesktopBridge {
  readonly isDesktop: true;
  readonly isSmokeTest: boolean;
  readonly authCallbackUrl: string;
  openExternalAuth(url: string): Promise<void>;
  takeAuthCallback(): Promise<string | null>;
  onAuthCallback(listener: (url: string) => void): () => void;
  chooseProjectFolder(): Promise<ConductorDesktopProjectFolder | null>;
  getUpdateStatus(): Promise<SupremeDesktopUpdateStatus | null>;
  checkForUpdates(manual?: boolean): Promise<SupremeDesktopUpdateStatus | null>;
  installUpdate(mode: 'now' | 'idle' | 'cancel'): Promise<SupremeDesktopUpdateStatus | null>;
  onUpdateStatus(listener: (status: SupremeDesktopUpdateStatus) => void): () => void;
  notify?(payload: { title: string; body: string; threadId?: string; tabId?: string }): Promise<boolean>;
  onOpenThread?(listener: (ref: { taskId: string; tabId: string | null }) => void): () => void;
  readyForOpenThread?(): Promise<boolean>;
}

interface Window {
  conductorDesktop?: ConductorDesktopBridge;
}
