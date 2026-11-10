import { useEffect, useRef, useState } from 'react';
import { useApp, state, set } from '../store';
import { LANDING_MS, setMotionDemoLayer, streamKey } from '../actions';
import { backdateTouch, SLEEP_AFTER_MS, touch } from '../lib/vitality';
import type { ComputerActivity, ConnectorActivity, Message } from '../types';

// Dev harness for Paper 16, behind ?motiondemo=1. It never ships to users and
// never calls the server: it drives a scripted fake run through the real
// store, so the real Pane, TabsRow, Rail and RunCard animate. Open a thread
// (or split a few panes) first, then start the demo on one of them. The one
// thing worth keeping repeatable is the slow case: forty seconds a step.
const STEPS = [
  "Find Jordan's open LinkedIn tab",
  'Verify the active LinkedIn sender',
  "Switch to Jordan's signed-in LinkedIn profile",
  "Open Jordan's profile",
  'Connect with a two-line note about Brooklyn',
  'Confirm the request went out',
];
type Mode = 'text' | 'working' | 'driving' | 'paused' | 'stopped' | 'error';
const RUN_ID = 'motion-demo';

function secondsFromSlider(value: number): number {
  return Math.round(Math.exp(Math.log(40) * (value / 100)) * 10) / 10;
}

export function MotionDemo() {
  const s = useApp();
  const [paneIdx, setPaneIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('working');
  const [slider, setSlider] = useState(22);
  const [live, setLive] = useState(false);
  const step = useRef(0);
  const target = useRef<{ threadId: string; tabId: string } | null>(null);
  const timer = useRef<number | null>(null);
  const seconds = secondsFromSlider(slider);

  const write = (patch: (stream: NonNullable<(typeof state.streams)[string]>) => void) => {
    const t = target.current;
    if (!t) return;
    const key = streamKey(t.threadId, t.tabId);
    const stream = state.streams[key];
    if (!stream) return;
    patch(stream);
    set();
  };

  const computerFor = (kind: Mode, at: string): ComputerActivity => ({
    runId: RUN_ID,
    state: kind === 'paused' ? 'paused' : kind === 'stopped' ? 'stopped' : kind === 'error' ? 'error' : 'active',
    surface: 'Chrome',
    app: 'LinkedIn',
    startedAt: at,
    updatedAt: at,
    currentStep: STEPS[Math.min(step.current, STEPS.length - 1)],
    steps: STEPS.slice(0, step.current + 1).map((text) => ({ step: text, at })),
    hasPreview: false,
  });
  const connectorFor = (kind: Mode, at: string): ConnectorActivity => ({
    id: 'motion-demo-notion', connector: 'Notion', action: 'search',
    state: kind === 'stopped' ? 'stopped' : kind === 'error' ? 'error' : 'active',
    detail: 'Brooklyn deal', startedAt: at, updatedAt: at,
  });

  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const t = target.current;
    if (t) {
      delete state.streams[streamKey(t.threadId, t.tabId)];
      const task = state.cache[t.threadId];
      const tab = task?.tabs.find((candidate) => candidate.id === t.tabId);
      if (tab) tab.status = 'idle';
      const summary = state.threads.find((thread) => thread.id === t.threadId);
      if (summary) summary.status = 'idle';
    }
    target.current = null;
    setLive(false);
    set();
  };

  const apply = (kind: Mode) => {
    const at = new Date().toISOString();
    write((stream) => {
      stream.statusText = kind === 'text' ? 'Writing' : kind === 'driving' ? 'Working in your Chrome' : 'Working';
      stream.error = kind === 'error' ? 'LinkedIn via Chrome stopped responding' : undefined;
      stream.computer = kind === 'text' || kind === 'working' ? null : computerFor(kind, at);
      stream.connectors = kind === 'working' ? [connectorFor(kind, at)] : [];
      stream.tools = kind === 'working' ? ['Notion'] : [];
      if (kind === 'text') stream.text = `${stream.text || ''}Looking at the last four replies before drafting anything. `;
    });
  };

  const schedule = (kind: Mode) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!(kind === 'driving' || kind === 'working' || kind === 'text')) return;
    timer.current = window.setTimeout(() => {
      if (step.current < STEPS.length - 1) {
        step.current += 1;
        apply(kind);
        schedule(kind);
      } else {
        stop();
      }
    }, secondsFromSlider(slider) * 1000);
  };

  const start = (kind: Mode = mode) => {
    stop();
    const pane = state.panes[paneIdx] || state.panes[0];
    const task = pane ? state.cache[pane.threadId] : null;
    const tab = task ? task.tabs.find((candidate) => candidate.id === (pane.tabId || task.activeTab)) || task.tabs[0] : null;
    if (!task || !tab) return;
    target.current = { threadId: task.id, tabId: tab.id };
    step.current = 0;
    state.streams[streamKey(task.id, tab.id)] = {
      threadId: task.id, tabId: tab.id, prompt: 'connect with Jordan and mention the Brooklyn deal', prompts: [],
      text: '', draftText: '', workNotes: [], tools: [], effort: 'Medium', statusText: 'Working', runId: RUN_ID, model: tab.model,
      computer: null, connectors: [],
    };
    tab.status = 'running';
    const summary = state.threads.find((thread) => thread.id === task.id);
    if (summary) summary.status = 'running';
    setLive(true);
    setMode(kind);
    apply(kind);
    schedule(kind);
  };

  const switchMode = (kind: Mode) => {
    setMode(kind);
    if (!live) return;
    apply(kind);
    schedule(kind);
  };

  // Paper 16.6: land the running turn. The live block holds for LANDING_MS so
  // the card can finish its lap and light green, then a fake assistant
  // message takes its place in the cached tab (never the server). `ask`
  // lands waiting on the user instead, which must stay neutral and still.
  const land = (ask = false) => {
    const t = target.current;
    if (!t) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const key = streamKey(t.threadId, t.tabId);
    const stream = state.streams[key];
    if (!stream) return;
    const at = new Date().toISOString();
    if (stream.computer) stream.computer = { ...stream.computer, state: 'released', currentStep: STEPS[STEPS.length - 1], steps: STEPS.map((text) => ({ step: text, at })) };
    stream.connectors = (stream.connectors || []).map((item) => ({ ...item, state: 'done', outcome: '3 pages' }));
    stream.text = stream.text || (ask ? 'Forty drafts are ready. Shall I send them?' : 'Forty drafts are ready in Gmail, one per lender, each with the Brooklyn deal in the first line.');
    stream.landed = { at: Date.now(), green: !ask };
    set();
    const hadCard = !!(stream.computer || stream.connectors?.length || stream.tools.length);
    window.setTimeout(() => {
      delete state.streams[key];
      const task = state.cache[t.threadId];
      const tab = task?.tabs.find((candidate) => candidate.id === t.tabId);
      if (task && tab) {
        tab.status = 'done';
        const message: Message = {
          role: 'assistant', content: stream.text, ts: new Date().toISOString(), ok: true, model: tab.model,
          workNotes: [], tools: stream.tools.map((tool) => (typeof tool === 'string' ? { name: tool } : tool)), computer: stream.computer || null, connectors: stream.connectors || [],
          turnMs: stream.startedAt ? Math.max(0, Date.now() - Date.parse(stream.startedAt)) : undefined,
          ...(ask ? { confirmation: { question: 'Send all forty?', confirmLabel: 'Confirm', confirmResponse: 'Confirm.', declineLabel: 'Not yet', declineResponse: 'Not yet.' } } : {}),
        };
        tab.messages = [...(tab.messages || []), { role: 'user', content: stream.prompt, ts: stream.startedAt || new Date().toISOString() }, message];
        task.status = 'done';
        task.lastActivity = message.ts;
      }
      const summary = state.threads.find((thread) => thread.id === t.threadId);
      if (summary) { summary.status = 'done'; summary.lastActivity = new Date().toISOString(); summary.needsConfirmationCount = ask ? 1 : 0; }
      touch(t.threadId, t.tabId);
      target.current = null;
      setLive(false);
      set();
    }, hadCard ? LANDING_MS : 0);
  };

  // Paper 16.10: pretend the pane's workstream was last touched a day and an
  // hour ago, so the room can be seen asleep; wake puts it back.
  const sleep = () => {
    const pane = state.panes[paneIdx] || state.panes[0];
    const task = pane ? state.cache[pane.threadId] : null;
    if (!task) return;
    const then = Date.now() - SLEEP_AFTER_MS - 60 * 60 * 1000;
    const thenIso = new Date(then).toISOString();
    for (const tab of task.tabs) for (const message of tab.messages || []) if (message.ts && Date.parse(message.ts) > then) message.ts = thenIso;
    task.lastActivity = thenIso;
    const summary = state.threads.find((thread) => thread.id === task.id);
    if (summary) summary.lastActivity = thenIso;
    backdateTouch(task.id, then, task.tabs.map((tab) => tab.id));
    set();
  };
  const wake = () => {
    const pane = state.panes[paneIdx] || state.panes[0];
    if (!pane) return;
    touch(pane.threadId, pane.tabId || state.cache[pane.threadId]?.activeTab);
    set();
  };
  // Reproduce the stuck-blue tab: the send-time `running` marker left behind
  // with no stream and no activeRun, which is what a failed read-back at the
  // end of a run leaves. The UI must not read it as working, and the run
  // poll must clear it from the server's copy.
  const stale = () => {
    const pane = state.panes[paneIdx] || state.panes[0];
    const task = pane ? state.cache[pane.threadId] : null;
    const tab = task ? task.tabs.find((candidate) => candidate.id === (pane.tabId || task.activeTab)) || task.tabs[0] : null;
    if (!task || !tab) return;
    delete tab.activeRun;
    tab.status = 'running';
    set();
  };

  useEffect(() => () => stop(), []);
  useEffect(() => { if (live) schedule(mode); }, [slider]);

  return (
    <div className="motion-demo" role="region" aria-label="Motion demo">
      <span className="k">Motion demo</span>
      <label>step <input type="range" min={0} max={100} value={slider} onChange={(event) => setSlider(Number(event.target.value))} /><output>{seconds.toFixed(1)}s</output></label>
      <span className="seg">
        {(['text', 'working', 'driving', 'paused', 'stopped', 'error'] as Mode[]).map((kind) => (
          <button key={kind} type="button" className={mode === kind ? 'on' : ''} onClick={() => switchMode(kind)}>
            {kind === 'text' ? 'Just text' : kind === 'working' ? 'Working' : kind === 'driving' ? 'Driving Chrome' : kind === 'paused' ? 'Waiting on you' : kind === 'stopped' ? 'Interrupted' : 'Failed'}
          </button>
        ))}
      </span>
      <span className="seg">
        {state.panes.map((_, index) => <button key={index} type="button" className={paneIdx === index ? 'on' : ''} onClick={() => setPaneIdx(index)}>pane {index + 1}</button>)}
      </span>
      <button type="button" className="go" onClick={() => (live ? stop() : start())}>{live ? 'Stop' : 'Start'}</button>
      <span className="seg">
        <button type="button" disabled={!live} onClick={() => land(false)}>Land</button>
        <button type="button" disabled={!live} onClick={() => land(true)}>Land asking</button>
        <button type="button" onClick={sleep}>Sleep</button>
        <button type="button" onClick={wake}>Wake</button>
        <button type="button" onClick={stale}>Stale</button>
      </span>
      <span className="seg toggles">
        {(['road', 'ground', 'edges'] as const).map((layer) => (
          <label key={layer}><input type="checkbox" checked={s.motion[layer]} onChange={(event) => setMotionDemoLayer(layer, event.target.checked)} />{layer}</label>
        ))}
      </span>
      {!state.panes.length ? <small>Open a thread first.</small> : null}
    </div>
  );
}
