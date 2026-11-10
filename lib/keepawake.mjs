// Keeps the Mac awake so a run can finish after the user walks away / closes the
// lid. Uses macOS `caffeinate` (no dependency, no sudo). Controlled by the
// `keepAwake` setting: 'off' | 'running' | 'always'.
//
//   running  -> stay awake while any run is in flight, sleep normally when idle
//   always   -> never idle-sleep while the app is open
//
// Honest limitation: `caffeinate -is` prevents *idle* system sleep (and system
// sleep on AC). A laptop with the lid physically CLOSED on battery still enters
// clamshell sleep — macOS only avoids that with an external display or the
// sudo-only `pmset -c disablesleep 1`. So this reliably covers "lid open but
// walked away" and "lid closed while plugged in"; battery+clamshell is out of
// reach without admin rights. We surface that in the UI copy.
import { spawn } from 'node:child_process';

let proc = null;

export function engage() {
  if (proc || process.platform !== 'darwin') return;
  proc = spawn('caffeinate', ['-is'], { stdio: 'ignore' });
  proc.on('exit', () => { proc = null; });
}

export function release() {
  if (proc) { try { proc.kill(); } catch { /* ignore */ } proc = null; }
}

export function active() {
  return !!proc;
}
