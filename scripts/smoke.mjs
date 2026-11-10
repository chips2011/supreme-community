// Backend contract smoke test. Boots server.mjs on a scratch WORKBENCH_HOME +
// isolated port, asserts the API shapes the React frontend depends on, exercises
// create-project → create-thread → create-tab, and confirms the run endpoint
// streams SSE framing (it starts a run, then cancels immediately — no full agent
// turn). Tears everything down. Never touches ~/.workbench.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliBinary } from '../lib/cli-binaries.mjs';
import { codexLoginAuthenticated } from '../lib/provider-auth.mjs';
import { claudeSessionAvailable, codexSessionAvailable, PERFORMANCE_POLICIES, providerWorkingDirectory, recommendModel, resolveModel } from '../lib/providers.mjs';
import { stableProjectId } from '../lib/store.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4793;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = mkdtempSync(join(tmpdir(), 'wb-smoke-'));
const FIXTURES = join(ROOT, 'scripts', 'test-bin');

// Simulate a pre-project-id record synced from a different Mac before boot.
// The server must upgrade it additively and make it usable on this machine.
const LEGACY_PROJECT_PATH = '/Users/mini-owner/Documents/Legacy Supreme Project';
const LEGACY_TASK_ID = '22222222-2222-4222-8222-222222222222';
const STALE_CLOUD_TASK_ID = '44444444-4444-4444-8444-444444444444';
const FRESH_CLOUD_TASK_ID = '55555555-5555-4555-8555-555555555555';
writeFileSync(join(HOME, 'repos.json'), JSON.stringify([{
  path: LEGACY_PROJECT_PATH,
  name: 'Legacy synced project',
  base: 'main',
  hasRemote: false,
  managed: false,
}], null, 2));
mkdirSync(join(HOME, 'tasks'), { recursive: true });
writeFileSync(join(HOME, 'tasks', `${LEGACY_TASK_ID}.json`), JSON.stringify({
  id: LEGACY_TASK_ID,
  title: 'Legacy synced workstream',
  repo: LEGACY_PROJECT_PATH,
  repoName: 'Legacy synced project',
  model: 'sonnet',
  status: 'idle',
  archived: false,
  pinned: false,
  activeTab: '33333333-3333-4333-8333-333333333333',
  tabs: [{
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Main',
    model: 'sonnet',
    status: 'idle',
    messages: [],
  }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastActivity: '2026-01-01T00:00:00.000Z',
}, null, 2));

function cloudHandoffFixture(id, startedAt) {
  return {
    id,
    title: `Cloud handoff ${id === STALE_CLOUD_TASK_ID ? 'stale' : 'fresh'}`,
    repo: LEGACY_PROJECT_PATH,
    repoName: 'Legacy synced project',
    model: 'sonnet',
    status: 'idle',
    archived: false,
    pinned: false,
    activeTab: `${id.slice(0, 8)}-6666-4666-8666-666666666666`,
    tabs: [{
      id: `${id.slice(0, 8)}-6666-4666-8666-666666666666`,
      name: 'Main',
      model: 'sonnet',
      status: 'idle',
      messages: [],
    }],
    cloudHandoff: { state: 'starting', machineId: '', startedAt },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
  };
}

writeFileSync(join(HOME, 'tasks', `${STALE_CLOUD_TASK_ID}.json`), JSON.stringify(
  cloudHandoffFixture(STALE_CLOUD_TASK_ID, '2026-01-01T00:00:00.000Z'), null, 2,
));
writeFileSync(join(HOME, 'tasks', `${FRESH_CLOUD_TASK_ID}.json`), JSON.stringify(
  cloudHandoffFixture(FRESH_CLOUD_TASK_ID, new Date().toISOString()), null, 2,
));

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) failures += 1; };

const appBundledCodex = join(HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex');
mkdirSync(dirname(appBundledCodex), { recursive: true });
copyFileSync(join(FIXTURES, 'codex'), appBundledCodex);
chmodSync(appBundledCodex, 0o755);
ok(
  resolveCliBinary('codex', { env: { PATH: '' }, home: HOME, platform: 'darwin' }) === appBundledCodex,
  'Codex is discovered inside Codex.app without a shell PATH',
);

const staleCodex = join(HOME, '.local', 'bin', 'codex');
mkdirSync(dirname(staleCodex), { recursive: true });
writeFileSync(staleCodex, '#!/a/missing/interpreter\n', { mode: 0o755 });
ok(
  resolveCliBinary('codex', {
    env: { PATH: dirname(staleCodex) }, home: HOME, platform: 'darwin', shellLookup: false,
  }) === appBundledCodex,
  'Codex.app wins over a stale executable in the GUI PATH',
);

const autoUpdatedCodex = join(HOME, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex');
mkdirSync(dirname(autoUpdatedCodex), { recursive: true });
writeFileSync(join(HOME, '.codex', 'packages', 'standalone', 'current', 'package.json'), '{"type":"module"}\n');
copyFileSync(join(FIXTURES, 'codex'), autoUpdatedCodex);
chmodSync(autoUpdatedCodex, 0o755);
ok(
  resolveCliBinary('codex', { env: { PATH: '' }, home: HOME, platform: 'darwin' }) === autoUpdatedCodex,
  'the auto-updated Codex CLI wins over the stale binary baked into Codex.app',
);

ok(
  codexLoginAuthenticated(null, '', 'Logged in using ChatGPT') === true
    && codexLoginAuthenticated(Object.assign(new Error('exit 1'), { code: 1 }), '', 'Not logged in') === false
    && codexLoginAuthenticated(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '', '') === null,
  'only an explicit Codex signed-out result replaces a healthy account',
);

const shellManagedClaude = join(HOME, 'shell-managed', 'claude');
mkdirSync(dirname(shellManagedClaude), { recursive: true });
copyFileSync(join(FIXTURES, 'claude'), shellManagedClaude);
chmodSync(shellManagedClaude, 0o755);
writeFileSync(join(HOME, '.zshrc'), `export PATH="${dirname(shellManagedClaude)}:$PATH"\n`, { mode: 0o600 });
ok(
  resolveCliBinary('claude', {
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }, home: HOME, platform: 'darwin',
  }) === shellManagedClaude,
  'Claude is discovered from the user login shell without a GUI PATH',
);

const missingSyncedWorktree = join(HOME, 'worktrees', 'from-another-machine');
ok(
  providerWorkingDirectory({ cwd: missingSyncedWorktree }) === process.env.HOME,
  'provider runs fall back when a synced worktree only exists on another machine',
);

const localClaudeCwd = join(HOME, 'local-claude-project');
const localClaudeSession = '11111111-1111-4111-8111-111111111111';
const localClaudeProjectKey = localClaudeCwd.replace(/[^a-z0-9]/gi, '-');
mkdirSync(join(HOME, '.claude', 'projects', localClaudeProjectKey), { recursive: true });
writeFileSync(join(HOME, '.claude', 'projects', localClaudeProjectKey, `${localClaudeSession}.jsonl`), '{}\n');
ok(
  claudeSessionAvailable(localClaudeSession, localClaudeCwd, { home: HOME }),
  'Claude resumes a session that exists for this local working directory',
);
ok(
  !claudeSessionAvailable(localClaudeSession, missingSyncedWorktree, { home: HOME }),
  'Claude does not resume a synced session from another computer',
);

const localCodexSession = '01a05406-4d5f-78f1-8881-000000000001';
mkdirSync(join(HOME, '.codex', 'sessions', '2026', '08', '30'), { recursive: true });
writeFileSync(
  join(HOME, '.codex', 'sessions', '2026', '08', '30', `rollout-2026-08-30T10-00-00-${localCodexSession}.jsonl`),
  '{}\n',
);
ok(
  codexSessionAvailable(localCodexSession, { home: HOME }),
  'Codex resumes a thread whose rollout exists on this Mac',
);
ok(
  !codexSessionAvailable('01a05406-4d5f-78f1-8881-866ebd73451d', { home: HOME }),
  "Codex does not resume a teammate's thread from another Mac",
);

const syncProbe = spawnSync('node', ['--input-type=module', '-e', `
  const sync = await import(${JSON.stringify(new URL('../lib/sync.mjs', import.meta.url).href)});
  if (typeof sync.flushNow !== 'function') process.exit(2);
  await sync.flushNow();
`], {
  cwd: ROOT,
  env: { ...process.env, WORKBENCH_HOME: HOME },
  encoding: 'utf8',
});
ok(syncProbe.status === 0, 'cloud handoff can flush sync immediately instead of crashing');

const server = spawn('node', ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    WORKBENCH_HOME: HOME,
    PORT: String(PORT),
    PATH: `${FIXTURES}${delimiter}${process.env.PATH || ''}`,
    SUPREME_CLAUDE_BINARY: join(FIXTURES, 'claude'),
    SUPREME_CODEX_BINARY: join(FIXTURES, 'codex'),
    WB_FIXTURE_DURATION_MS: '180',
    FIXTURE_CONNECTOR_DELAY_MS: '45',
    WB_FIXTURE_CODEX_401_ONCE: 'after-tool',
    WB_FIXTURE_CAPTURE_PROMPTS: '1',
    WB_MODEL_USAGE_FIXTURE: '1',
    WB_FIXTURE_CLAUDE_MODEL: 'claude-sonnet-5-2',
    TESTFLIGHT_URL: 'https://testflight.apple.com/join/smoke1234',
    TESTFLIGHT_INVITE_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}
async function send(method, path, obj) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: obj ? JSON.stringify(obj) : undefined });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(BASE + '/api/models'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitProvidersReady(providers) {
  let status = null;
  for (let i = 0; i < 40; i += 1) {
    status = await get('/api/status');
    if (providers.every((provider) => status.body.providers?.[provider]?.ready === true)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return status;
}

try {
  if (!(await waitReady())) { console.log('server did not start:\n' + serverErr); process.exit(1); }

  const models = await get('/api/models');
  ok(models.status === 200 && Array.isArray(models.body.models) && models.body.models.length > 0, 'GET /api/models returns models[]');
  ok(models.body.models.every((m) => m.id && m.label && m.provider), 'each model has id/label/provider');
  const astraModel = models.body.models.find((m) => m.id === 'gpt-6-astra');
  ok(astraModel?.label === 'GPT-6 Astra' && astraModel.provider === 'codex' && astraModel.cli === 'gpt-6-astra', 'Astra is exposed in the product catalog through the ChatGPT provider');
  const pickable = models.body.models.filter((m) => !m.retired).map((m) => m.label);
  ok(['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna'].every((label) => pickable.includes(label)) && !pickable.some((label) => /GPT-5\.6/.test(label)), 'the picker offers GPT-6 Astra, GPT-6.1 Sol and GPT-6 Luna, and no GPT-5.6', JSON.stringify(pickable));
  ok(models.body.models.filter((m) => m.retired).map((m) => m.id).sort().join() === 'gpt-5.6-sol,gpt-5.6-terra', 'GPT-5.6 Sol and Terra are retired, still in the catalog for tabs set to them');
  const routed = PERFORMANCE_POLICIES.flatMap((policy) => ['open chrome', 'our strategy', 'review this', 'research it', 'write a memo', 'extract the table', 'hello'].map((prompt) => recommendModel({ prompt, policy }).modelId));
  ok(routed.every((id) => resolveModel(id) && !resolveModel(id).retired) && routed.includes('gpt-6.1-sol') && routed.includes('gpt-6-luna'), 'every Recommended route lands on a current model', [...new Set(routed)].join(', '));

  const repos = await get('/api/repos');
  ok(repos.status === 200 && Array.isArray(repos.body.repos), 'GET /api/repos returns repos[]');
  const legacyProject = repos.body.repos.find((candidate) => candidate.path === LEGACY_PROJECT_PATH);
  ok(legacyProject?.id === stableProjectId({ path: LEGACY_PROJECT_PATH }), 'legacy path-only project gets the same stable id on every Mac');
  ok(legacyProject?.managed === true, 'rail load materializes a legacy project locally without asking for a repository');
  const localizedLegacy = await send('POST', '/api/tasks', {
    repo: LEGACY_PROJECT_PATH,
    projectId: legacyProject?.id,
    model: 'sonnet',
    title: 'Legacy portable workstream',
  });
  ok(localizedLegacy.status === 200 && localizedLegacy.body.task?.repo === LEGACY_PROJECT_PATH, 'project + creates a workstream from a project synced off another Mac');
  ok(localizedLegacy.body.task?.projectId === legacyProject?.id, 'new workstream keeps the project stable id instead of relying on its Mac path');

  const tasks = await get('/api/tasks');
  ok(tasks.status === 200 && Array.isArray(tasks.body.tasks), 'GET /api/tasks returns tasks[]');
  ok(tasks.body.tasks.find((candidate) => candidate.id === LEGACY_TASK_ID)?.projectId === legacyProject?.id, 'legacy workstream migrates onto its project stable id');
  const staleCloudTask = await get(`/api/tasks/${STALE_CLOUD_TASK_ID}`);
  const freshCloudTask = await get(`/api/tasks/${FRESH_CLOUD_TASK_ID}`);
  ok(staleCloudTask.status === 200 && !staleCloudTask.body.task?.cloudHandoff, 'restart frees a thread abandoned while moving to cloud');
  ok(freshCloudTask.status === 200 && freshCloudTask.body.task?.cloudHandoff?.state === 'starting', 'restart preserves a cloud handoff that is still genuinely starting');

  const settings = await get('/api/settings');
  ok(settings.status === 200 && typeof settings.body === 'object', 'GET /api/settings returns object');

  const status = await get('/api/status');
  ok(status.status === 200 && status.body.providers?.claude && status.body.providers?.codex, 'GET /api/status returns model account readiness');
  ok(status.body.serviceReady === true && status.body.product === 'supreme', 'status separates local-service health from model readiness');
  ok(typeof status.body.chrome?.installed === 'boolean' && status.body.chrome?.installUrl?.includes('chromewebstore.google.com'), 'status includes Chrome extension setup');
  ok(typeof status.body.cloudWorker?.configured === 'boolean', 'status exposes the cloud handoff availability gate');

  const modelUsage = await get('/api/model-usage');
  ok(modelUsage.status === 200 && modelUsage.body.providers?.claude?.windows?.length > 0 && modelUsage.body.providers?.codex?.windows?.length > 0, 'GET /api/model-usage returns normalized provider limits');
  ok(!/accessToken|refreshToken|id_token/i.test(JSON.stringify(modelUsage.body)), 'model usage never exposes account credentials');

  const stats = await get('/api/stats');
  ok(stats.status === 200 && typeof stats.body.threads === 'number' && stats.body.byModel, 'GET /api/stats returns aggregates');

  const perf = await get('/api/performance');
  ok(perf.status === 200 && Array.isArray(perf.body.rows), 'GET /api/performance returns rows[]');

  const duels = await get('/api/duels');
  ok(duels.status === 200 && Array.isArray(duels.body.duels) && duels.body.count === 0, 'GET /api/duels returns real empty history');

  const remote = await get('/api/remote');
  ok(remote.status === 200 && Array.isArray(remote.body.sessions), 'GET /api/remote returns a compact session snapshot');
  ok(remote.body.mobileApp?.installed === false && remote.body.mobileApp?.live === false, 'Remote reports the phone as unlinked without a relay session');
  const badTestFlight = await send('POST', '/api/remote/testflight', { email: 'not-an-email' });
  const testFlight = await send('POST', '/api/remote/testflight', { email: 'fixture@example.com' });
  ok(badTestFlight.status === 400, 'TestFlight signup rejects an invalid email');
  ok(testFlight.status === 200 && testFlight.body.url === 'https://testflight.apple.com/join/smoke1234' && testFlight.body.requested === false, 'TestFlight signup returns the configured install link even before relay pairing');

  // connectors shells out to `claude mcp list`; tolerate empty/slow.
  const connectors = await get('/api/connectors');
  ok(connectors.status === 200 && Array.isArray(connectors.body.connectors), 'GET /api/connectors returns connectors[]');
  ok(connectors.body.connectors.some((entry) => entry.name === 'Gmail' && entry.provider === 'codex' && entry.connected === true), 'ChatGPT account plugins surface as connectors');
  ok(!connectors.body.connectors.some((entry) => /^(?:Pdf|Browser)$/i.test(entry.name)), 'bundled tooling plugins stay out of the connector list');

  const patch = await send('PATCH', '/api/settings', {
    defaultModel: 'sonnet', defaultEffort: 'High', browserControlEnabled: false,
    browserControlByProvider: { claude: true, codex: false, grok: true },
    onboarding: { signedIn: true, step: 'models', email: 'fixture@example.com', webProviders: ['grok'] },
  });
  ok(patch.status === 200, 'PATCH /api/settings accepts defaultModel/defaultEffort');
  const settings2 = await get('/api/settings');
  ok(settings2.body.defaultModel === 'sonnet' && settings2.body.defaultEffort === 'High', 'settings persisted defaultModel/defaultEffort');
  ok(settings2.body.browserControlEnabled === false && settings2.body.onboarding?.email === 'fixture@example.com', 'settings persist onboarding and Chrome preferences');
  ok(settings2.body.browserControlByProvider?.claude === true && settings2.body.browserControlByProvider?.codex === false, 'settings persist per-provider Chrome access');
  const status2 = await get('/api/status');
  ok(status2.body.chrome?.byProvider?.claude === true && status2.body.chrome?.byProvider?.codex === false, 'status reports per-provider Chrome access');

  const grokDisconnect = await send('POST', '/api/providers/grok/disconnect');
  const grokStatusOff = await get('/api/status');
  const grokConnect = await send('POST', '/api/providers/grok/connect');
  const grokStatusOn = await get('/api/status');
  ok(grokDisconnect.status === 200 && grokStatusOff.body.providers?.grok?.webConnected === false, 'Grok can disconnect its browser account');
  ok(grokConnect.status === 200 && grokStatusOn.body.providers?.grok?.webConnected === true, 'Grok can reconnect its browser account');
  const claudeDisconnect = await send('POST', '/api/providers/claude/disconnect');
  const codexDisconnect = await send('POST', '/api/providers/codex/disconnect');
  const providerStatusOff = await get('/api/status');
  const claudeConnect = await send('POST', '/api/providers/claude/connect');
  const codexConnect = await send('POST', '/api/providers/codex/connect');
  const providerStatusOn = await waitProvidersReady(['claude', 'codex']);
  ok(claudeDisconnect.status === 200 && providerStatusOff.body.providers?.claude?.ready === false, 'Claude sign-out is detected');
  ok(codexDisconnect.status === 200 && providerStatusOff.body.providers?.codex?.ready === false, 'ChatGPT sign-out is detected');
  ok(claudeConnect.status === 202 && providerStatusOn.body.providers?.claude?.ready === true, 'Claude OAuth reconnect is detected');
  ok(codexConnect.status === 202 && providerStatusOn.body.providers?.codex?.ready === true, 'ChatGPT OAuth reconnect is detected');

  // Sign up ends by starting the first thread from a direction. Without a
  // LinkedIn profile the project falls back to Getting started, and the thread
  // is marked as having come from sign up so the transcript can say so.
  const onboarding = await send('POST', '/api/onboarding/start', { custom: 'Draft the Tuesday lender update' });
  const onboardingTab = onboarding.body.task?.tabs?.[0];
  ok(onboarding.status === 200 && onboarding.body.project?.name === 'Getting started' && onboarding.body.task?.title === 'Draft the Tuesday lender update' && onboarding.body.task?.origin === 'signup', 'sign up start creates the first project and a thread marked as started from sign up');
  ok(typeof onboarding.body.prompt === 'string' && onboarding.body.prompt.includes('Draft the Tuesday lender update'), 'sign up start returns the first prompt built from the chosen direction');
  const onboardingRun = await fetch(`${BASE}/api/tasks/${onboarding.body.task.id}/tabs/${onboardingTab.id}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: onboarding.body.prompt, model: 'sonnet', effort: 'Low', hiddenPrompt: true }),
  });
  await onboardingRun.text();
  const onboardingDetail = await get(`/api/tasks/${onboarding.body.task.id}`);
  const onboardingUser = onboardingDetail.body.task.tabs[0].messages.find((message) => message.role === 'user');
  ok(onboardingRun.ok && onboardingUser?.hiddenInTranscript === true, 'the first sign up prompt stays hidden from the visible transcript');
  const forked = await send('PATCH', `/api/tasks/${onboarding.body.task.id}`, { signupFork: 'repeat' });
  ok(forked.status === 200 && (forked.body.task || forked.body)?.signupFork === 'repeat', 'the sign up thread remembers the one-off or repeatable choice');
  const settingsAfterStart = await get('/api/settings');
  ok(settingsAfterStart.body.onboarding?.complete === true && settingsAfterStart.body.onboarding?.firstTaskId === onboarding.body.task.id, 'sign up completes once the first thread starts');

  const repo = await send('POST', '/api/repos', { name: 'smoke-project' });
  ok(repo.status === 200 && repo.body.repo?.id && repo.body.repo.path, 'POST /api/repos creates an identified managed project');

  // Cloud sync carries the logical project record between Macs, but an old
  // absolute backing path belongs to the other machine. A project id must still
  // create the thread locally without showing Git/repository validation.
  const staleManagedPath = '/Users/someone-on-another-mac/.workbench/projects/smoke-project-stale';
  const repoRecords = JSON.parse(readFileSync(join(HOME, 'repos.json'), 'utf8'));
  repoRecords.find((candidate) => candidate.id === repo.body.repo.id).path = staleManagedPath;
  writeFileSync(join(HOME, 'repos.json'), JSON.stringify(repoRecords, null, 2));
  const task = await send('POST', '/api/tasks', { repo: staleManagedPath, projectId: repo.body.repo.id, model: 'sonnet', title: 'smoke thread' });
  ok(task.status === 200 && task.body.task && task.body.task.id, 'POST /api/tasks creates a thread with a worktree');
  ok(task.body.task?.repo === staleManagedPath, 'managed thread creation survives a synced path from another Mac');
  ok(task.body.task?.projectId === repo.body.repo.id, 'managed thread remains associated by project id after cross-Mac localization');
  const taskId = task.body.task?.id;
  const taskFile = join(HOME, 'tasks', `${taskId}.json`);
  ok(task.body.task && Array.isArray(task.body.task.tabs) && task.body.task.tabs.length === 1, 'new thread has one tab');

  const tab = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'opus' });
  ok(tab.status === 200 && tab.body.tab && tab.body.tab.id, 'POST /api/tasks/:id/tabs adds a tab');
  ok(tab.body.tab?.name === 'New tab' && tab.body.tab?.model === 'opus', 'new blank tab keeps the requested previous model');

  const detail = await get(`/api/tasks/${taskId}`);
  ok(detail.status === 200 && detail.body.task && Array.isArray(detail.body.runningTabs), 'GET /api/tasks/:id returns {task, runningTabs}');
  ok((detail.body.task.tabs || []).length === 2, 'thread now has two tabs');

  // Persisted assistant turns that ask for approval become durable, actionable
  // confirmations in both the transcript and compact thread summary.
  const confirmationTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet', name: 'Approval needed' });
  const confirmationTabId = confirmationTabResponse.body.tab?.id;
  const confirmationTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  const confirmationTab = confirmationTask.tabs.find((candidate) => candidate.id === confirmationTabId);
  confirmationTab.status = 'done';
  confirmationTab.messages.push({
    id: '00000000-0000-4000-8000-000000000012',
    role: 'assistant',
    content: 'I drafted the approved message. Would you like me to send it?',
    ts: new Date().toISOString(),
    ok: true,
  });
  writeFileSync(taskFile, JSON.stringify(confirmationTask, null, 2));
  const confirmationDetail = await get(`/api/tasks/${taskId}`);
  const confirmedMessage = confirmationDetail.body.task.tabs
    .find((candidate) => candidate.id === confirmationTabId)?.messages?.at(-1);
  const confirmationTasks = await get('/api/tasks');
  ok(confirmedMessage?.confirmation?.confirmLabel === 'Confirm', 'an approval request is derived into transcript confirmation controls, and the button only ever says Confirm');
  ok(confirmationTasks.body.tasks?.find((candidate) => candidate.id === taskId)?.needsConfirmationCount >= 1, 'thread summaries expose pending confirmations');
  // The imperative and reply-token phrasings models actually use must also
  // produce controls; the token button sends the exact token.
  const phrasingTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  const phrasingTab = phrasingTask.tabs.find((candidate) => candidate.id === confirmationTabId);
  phrasingTab.messages.push(
    { id: '00000000-0000-4000-8000-000000000021', role: 'assistant', content: 'Nothing will be sent. Confirm and I’ll update the draft, replace the attachment, and keep it unsent.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000022', role: 'assistant', content: 'Reply `go 4/4/3` and I’ll apply the non-overlapping sender pools.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000023', role: 'assistant', content: 'I verified the drafts and everything is saved. Nothing was sent.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000024', role: 'assistant', content: 'The exact sender list is in the [approval manifest](/tmp/approval-manifest.md).\n\nReply **YES** to approve the permanent deletion and creation of these two draft campaigns.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000025', role: 'assistant', content: 'Reply YES to delete the empty campaign, or reply NO to keep it.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000026', role: 'assistant', content: 'Approve and I’ll create both drafts. Nothing sends.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000027', role: 'assistant', content: 'I’ll approve the sender pool once Smartlead finishes verifying it.', ts: new Date().toISOString(), ok: true },
    // A question INSIDE a drafted email (blockquoted) is the draft's voice,
    // not an ask to the user; a real trailing ask after the draft still is.
    { id: '00000000-0000-4000-8000-000000000028', role: 'assistant', content: 'Here is the draft:\n\n> Hi Jordan,\n>\n> Curious if you would be open to a quick call this week?\n>\n> Best,\n> Alex\n\nNothing sent.', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000029', role: 'assistant', content: 'Here is the draft:\n\n> Curious if you would be open to a quick call?\n\nWant me to send it?', ts: new Date().toISOString(), ok: true },
    { id: '00000000-0000-4000-8000-000000000030', role: 'assistant', content: 'What email should I use for Eddie, and which tools should be included?', confirmation: { question: 'What email should I use for Eddie?', confirmLabel: 'Confirm', confirmResponse: 'Confirm.' }, ts: new Date().toISOString(), ok: true },
  );
  writeFileSync(taskFile, JSON.stringify(phrasingTask, null, 2));
  const phrasingDetail = await get(`/api/tasks/${taskId}`);
  const phrasingMessages = phrasingDetail.body.task.tabs.find((candidate) => candidate.id === confirmationTabId)?.messages || [];
  const imperativeMessage = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000021');
  const tokenMessage = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000022');
  const statusMessage = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000023');
  ok(imperativeMessage?.confirmation?.confirmResponse === 'Confirm.', 'an imperative "Confirm and I’ll…" reply gets confirmation controls whose reply is just Confirm');
  ok(tokenMessage?.confirmation?.confirmResponse === 'go 4/4/3' && tokenMessage?.confirmation?.confirmLabel === 'Reply “go 4/4/3”', 'a reply-token instruction sends the exact token');
  ok(!statusMessage?.confirmation, 'a plain status recap never grows confirmation controls');
  const boldYes = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000024');
  const yesOrNo = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000025');
  const approveMessage = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000026');
  const selfApprove = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000027');
  ok(boldYes?.confirmation?.confirmResponse === 'YES' && boldYes?.confirmation?.confirmLabel === 'Reply “YES”', 'a sentence-initial, bold "Reply **YES** to approve…" gets a button that sends YES');
  ok(yesOrNo?.confirmation?.confirmResponse === 'YES', 'when the model offers YES or NO, the button sends the go-ahead, not the way out');
  ok(approveMessage?.confirmation?.confirmResponse === 'Confirm.', 'an imperative "Approve and I’ll…" reply gets confirmation controls');
  ok(!selfApprove?.confirmation, 'the model approving something itself never grows confirmation controls');
  const quotedDraft = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000028');
  const draftThenAsk = phrasingMessages.find((message) => message.id === '00000000-0000-4000-8000-000000000029');
  ok(!quotedDraft?.confirmation, "a question inside a drafted email never grows confirmation controls");
  ok(draftThenAsk?.confirmation?.confirmResponse === 'Confirm.', 'a real ask after a quoted draft still gets its button');
  ok(!phrasingMessages.find(message => message.id === '00000000-0000-4000-8000-000000000030')?.confirmation, 'a stale clarification approval stamp clears when the transcript is read');

  // Paper 20, tab level: Done is a bookend on the tab. Marking it stamps the
  // day and a one-line result for the tray, and hands the active spot to a
  // live sibling; an archived workstream reads but never runs; a new message
  // brings a done tab back on its own.
  await send('PATCH', `/api/tasks/${taskId}/tabs/${confirmationTabId}`, { active: true });
  const doneOn = await send('PATCH', `/api/tasks/${taskId}/tabs/${confirmationTabId}`, { done: true });
  const doneTabRecord = doneOn.body.task?.tabs?.find((candidate) => candidate.id === confirmationTabId);
  ok(doneOn.status === 200 && doneTabRecord?.done === true && !!doneTabRecord?.doneAt, 'PATCH done marks a tab done with a timestamp');
  ok(typeof doneTabRecord?.doneLine === 'string' && doneTabRecord.doneLine.length > 0, 'marking done captures a one-line result for the tray');
  ok(doneOn.body.task?.activeTab !== confirmationTabId, 'a done tab hands the active spot to a live sibling');
  const doneSummaries = await get('/api/tasks');
  const doneSummary = doneSummaries.body.tasks?.find((candidate) => candidate.id === taskId);
  ok((doneSummary?.doneTabs || []).some((row) => row.id === confirmationTabId && !!row.doneAt && !!row.doneLine), 'thread summaries list each done tab with its day and result line');
  ok(doneSummary?.done === false, 'a thread only reads done once every live tab is');
  await send('PATCH', `/api/tasks/${taskId}`, { archived: true });
  const archivedRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${confirmationTabId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello again' }),
  });
  ok(archivedRun.status === 409, 'an archived workstream reads, it does not run');
  await archivedRun.body?.cancel?.();
  const unarchived = await send('PATCH', `/api/tasks/${taskId}`, { archived: false });
  ok(unarchived.body.task?.archived === false && unarchived.body.task?.tabs?.find((candidate) => candidate.id === confirmationTabId)?.done === true, 'unarchiving does not disturb a done mark');
  const bringBackRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${confirmationTabId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'back again' }),
  });
  ok(bringBackRun.status === 200, 'a done tab still runs');
  const backTask = await get(`/api/tasks/${taskId}`);
  const backTab = backTask.body.task?.tabs?.find((candidate) => candidate.id === confirmationTabId);
  ok(backTab?.done === false && !backTab?.doneAt, 'a new message brings a done tab back on its own');
  await bringBackRun.body?.cancel?.();
  // Let the fixture turn land so the sections after this one see a quiet tab.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await get(`/api/tasks/${taskId}`);
    const currentTab = current.body.task?.tabs?.find((candidate) => candidate.id === confirmationTabId);
    if (currentTab && currentTab.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 0.1.37 marked Done at the thread level; a legacy mark spreads to the tabs
  // on read and the thread field disappears.
  const legacyTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  legacyTask.done = true;
  legacyTask.doneAt = new Date().toISOString();
  legacyTask.doneLine = 'Legacy line';
  writeFileSync(taskFile, JSON.stringify(legacyTask, null, 2));
  const migrated = await get(`/api/tasks/${taskId}`);
  ok(migrated.body.task?.done === undefined
    && !(migrated.body.task?.tabs || []).some((candidate) => candidate.done === true),
  'a 0.1.37 thread-level done drops on read instead of spreading to tabs');
  await send('PATCH', `/api/tasks/${taskId}`, { done: false });
  const cleared = await get(`/api/tasks/${taskId}`);
  ok((cleared.body.task?.tabs || []).every((candidate) => !candidate.done), 'a thread-level clear still reaches every tab');

  // One button frees context both ways: fold older turns AND set aside the
  // connectors the tab never used (their schemas are most of a heavy tab).
  const trimProbe = await import(new URL('../lib/connectors.mjs', import.meta.url).href);
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify({ mcpServers: { slack: { command: 'npx', args: ['-y', 'x'] } } }));
  const codexHome = join(HOME, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), [
    '[mcp_servers.gmail]',
    'url = "https://gmail.example/mcp"',
    '',
    '[plugins."notion@openai-api-curated"]',
    'enabled = true',
  ].join('\n'));
  const emptyTrim = trimProbe.mcpTrimFor([], {
    claudeHome: HOME,
    codexHome,
    connectors: [
      { name: 'Gmail', provider: 'codex', server: 'gmail', connected: true },
      { name: 'Notion', provider: 'codex', server: 'notion', connected: true },
    ],
  });
  ok(emptyTrim.claude.mode === 'empty' && emptyTrim.codex.disable.includes('gmail'), 'an all-unused scope strips claude MCP entirely and disables configured codex servers');
  ok(!emptyTrim.codex.disable.includes('notion'), 'a plugin connector never becomes an incomplete per-run MCP server override');
  const localTrim = trimProbe.mcpTrimFor(['slack'], { claudeHome: HOME, connectors: [] });
  ok(localTrim.claude.mode === 'config' && !!localTrim.claude.servers.slack, 'a purely local scope re-declares just those servers');
  ok(trimProbe.mcpTrimFor(['gmail'], { claudeHome: HOME, connectors: [] }).claude.mode === 'none', 'a scope that needs an account connector keeps the full set');

  await send('PATCH', `/api/tasks/${taskId}`, { connectors: true });
  const scopeTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet', name: 'Scope probe' });
  const scopeTabId = scopeTabResponse.body.tab?.id;
  // A finished turn that touched no connector: the scope must come out empty.
  const scopeTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  const scopeTabRecord = scopeTask.tabs.find((candidate) => candidate.id === scopeTabId);
  scopeTabRecord.status = 'done';
  scopeTabRecord.messages = [
    { id: '00000000-0000-4000-8000-000000000031', role: 'user', content: 'sort the drafts', ts: new Date().toISOString() },
    { id: '00000000-0000-4000-8000-000000000032', role: 'assistant', content: 'Sorted. Nothing was sent.', ts: new Date().toISOString(), ok: true },
  ];
  writeFileSync(taskFile, JSON.stringify(scopeTask, null, 2));
  const scopeSum = await send('POST', `/api/tasks/${taskId}/tabs/${scopeTabId}/compact`);
  ok(scopeSum.status === 200 && (scopeSum.body.scope?.setAside || 0) >= 1, 'Sum up sets the connectors this tab never used aside');
  const scopedTask = await get(`/api/tasks/${taskId}`);
  const scopedTab = scopedTask.body.task.tabs.find((candidate) => candidate.id === scopeTabId);
  ok(Array.isArray(scopedTab?.connectorScope?.keys) && scopedTab.connectorScope.keys.length === 0, 'a tab that used nothing scopes to nothing');
  const scopedRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${scopeTabId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'quick check on the drafts' }),
  });
  ok(scopedRun.status === 200, 'a scoped tab still runs');
  await scopedRun.body?.cancel?.();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await get(`/api/tasks/${taskId}`);
    const currentTab = current.body.task?.tabs?.find((candidate) => candidate.id === scopeTabId);
    if (currentTab && currentTab.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const claudeArgLog = readFileSync(join(HOME, 'fixture-claude-prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const scopedEntry = claudeArgLog.reverse().find((entry) => String(entry.prompt || '').includes('quick check on the drafts'));
  ok(!!scopedEntry?.args?.includes('--strict-mcp-config'), 'a scoped-to-nothing tab runs claude with a strict empty MCP config');

  // Paper 21.3-21.5b: handing a message to a sibling tab writes the paper
  // trail at send — the task-level from→to→at edge, the sender's hairline
  // row, and the handed-from stamp on the receiving message. No status, no
  // return trip: the sender's trace is one static line.
  const handTarget = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet', name: 'Hand target' });
  const handTargetId = handTarget.body.tab?.id;
  const handRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${handTargetId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'take it from here, find the emails', handoffFrom: { tabId: scopeTabId } }),
  });
  ok(handRun.status === 200, 'a handed message runs in the sibling tab');
  await handRun.body?.cancel?.();
  const afterHand = await get(`/api/tasks/${taskId}`);
  const edge = (afterHand.body.task?.tabHandoffs || []).find((row) => row.from === scopeTabId && row.to === handTargetId);
  ok(!!edge?.at, 'the from→to→at edge is written at the actual send');
  const handSender = afterHand.body.task.tabs.find((candidate) => candidate.id === scopeTabId);
  ok((handSender?.handedTo || []).some((row) => row.toTabId === handTargetId && row.toName === 'Hand target'), "the sender's hairline row is recorded where its transcript stood");
  let handedMsg = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await get(`/api/tasks/${taskId}`);
    const receiver = current.body.task?.tabs?.find((candidate) => candidate.id === handTargetId);
    handedMsg = (receiver?.messages || []).find((message) => message.role === 'user' && message.handedFrom) || null;
    if (handedMsg && receiver?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ok(handedMsg?.handedFrom?.tabId === scopeTabId && !!handedMsg?.handedFrom?.name, 'the receiving message carries handed-over-from');

  const otherThread = await send('POST', '/api/tasks', { repo: staleManagedPath, projectId: repo.body.repo.id, model: 'sonnet', title: 'other desk' });
  const otherId = otherThread.body.task?.id;
  const otherTabId = otherThread.body.task?.tabs?.[0]?.id;
  const listedOther = (await get('/api/tasks')).body.tasks?.find((row) => row.id === otherId);
  ok(Array.isArray(listedOther?.tabs) && listedOther.tabs[0]?.id === otherTabId && listedOther.tabs[0]?.name === 'Main', 'the thread list carries each live tab by name for the @ menu');
  const crossRun = await fetch(`${BASE}/api/tasks/${otherId}/tabs/${otherTabId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'carry the shortlist over here', handoffFrom: { tabId: scopeTabId, threadId: taskId } }),
  });
  ok(crossRun.status === 200, 'a message handed from another workstream runs there');
  await crossRun.body?.cancel?.();
  const afterCross = await get(`/api/tasks/${otherId}`);
  const crossEdge = (afterCross.body.task?.tabHandoffs || []).find((row) => row.from === scopeTabId && row.to === otherTabId);
  ok(!!crossEdge?.at && crossEdge.fromThreadId === taskId, 'the edge on the receiving workstream names where it came from');
  const crossSender = (await get(`/api/tasks/${taskId}`)).body.task.tabs.find((candidate) => candidate.id === scopeTabId);
  ok((crossSender?.handedTo || []).some((row) => row.toTabId === otherTabId && row.toThreadId === otherId && row.toThreadTitle === 'other desk'), "the sender's hairline row names the other workstream and survives on its own task");
  let crossMsg = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await get(`/api/tasks/${otherId}`);
    const receiver = current.body.task?.tabs?.find((candidate) => candidate.id === otherTabId);
    crossMsg = (receiver?.messages || []).find((message) => message.role === 'user' && message.handedFrom) || null;
    if (crossMsg && receiver?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ok(crossMsg?.handedFrom?.tabId === scopeTabId && crossMsg?.handedFrom?.threadId === taskId && crossMsg?.handedFrom?.threadTitle === 'smoke thread', 'the receiving message says which workstream handed it over');
  // The project cascade below counts one workstream, so this one goes now.
  await send('PATCH', `/api/tasks/${otherId}`, { archived: true });
  await send('DELETE', `/api/tasks/${otherId}`);

  const orphanTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet', name: 'Late synced run' });
  const orphanTabId = orphanTabResponse.body.tab?.id;
  const orphanedTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  const orphanedTab = orphanedTask.tabs.find((candidate) => candidate.id === orphanTabId);
  orphanedTab.status = 'running';
  orphanedTab.activeRun = {
    id: '00000000-0000-4000-8000-000000000013',
    taskId,
    tabId: orphanTabId,
    model: 'sonnet',
    prompt: 'Finish the synced task.',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    text: '',
    workNotes: ['Reached the last confirmed checkpoint.'],
    active: true,
  };
  orphanedTask.status = 'running';
  writeFileSync(taskFile, JSON.stringify(orphanedTask, null, 2));
  const freshCrossDeviceRun = await get(`/api/tasks/${taskId}`);
  const freshCrossDeviceTab = freshCrossDeviceRun.body.task.tabs.find((candidate) => candidate.id === orphanTabId);
  ok(freshCrossDeviceRun.body.task?.status === 'running' && freshCrossDeviceTab?.status === 'running' && freshCrossDeviceTab?.activeRun, 'a fresh cross-device heartbeat keeps the synced run working');

  const staleOrphanedTask = JSON.parse(readFileSync(taskFile, 'utf8'));
  const staleOrphanedTab = staleOrphanedTask.tabs.find((candidate) => candidate.id === orphanTabId);
  staleOrphanedTab.activeRun.updatedAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(taskFile, JSON.stringify(staleOrphanedTask, null, 2));
  const recoveredOrphan = await get(`/api/tasks/${taskId}`);
  const recoveredTab = recoveredOrphan.body.task.tabs.find((candidate) => candidate.id === orphanTabId);
  const recoveredAnswer = recoveredTab?.messages?.[recoveredTab.messages.length - 1];
  ok(recoveredOrphan.body.running === false && recoveredTab?.status === 'error' && !recoveredTab?.activeRun, 'a late-synced orphan run cannot leave a tab working forever');
  ok(recoveredAnswer?.ok === false && /no longer connected to a model process/i.test(recoveredAnswer?.content || ''), 'orphan recovery shows an actionable answer instead of an empty reply');
  ok(recoveredAnswer?.workNotes?.includes('Reached the last confirmed checkpoint.'), 'orphan recovery preserves partial work notes for review');

  const pinThread = await send('PATCH', `/api/tasks/${taskId}`, { pinned: true });
  const pinnedTasks = await get('/api/tasks');
  ok(pinThread.status === 200 && pinThread.body.task?.pinned === true, 'thread can be pinned');
  ok(pinnedTasks.body.tasks?.find((item) => item.id === taskId)?.pinned === true, 'pinned state persists in thread summaries');

  const astraTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'gpt-6-astra', name: 'Astra check' });
  const astraTabId = astraTabResponse.body.tab?.id;
  ok(astraTabResponse.status === 200 && astraTabResponse.body.tab?.model === 'gpt-6-astra', 'a new tab accepts an Astra pin');
  const astraRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${astraTabId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Verify the selected Astra model.', model: 'gpt-6-astra', effort: 'Low' }),
  });
  await astraRun.text();
  const astraDetail = await get(`/api/tasks/${taskId}`);
  const astraTab = astraDetail.body.task.tabs.find((candidate) => candidate.id === astraTabId);
  const astraAnswer = astraTab?.messages?.at(-1);
  const astraPrompts = readFileSync(join(HOME, 'fixture-codex-prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  ok(astraPrompts.some((entry) => entry.method === 'turn/start' && entry.model === 'gpt-6-astra' && entry.prompt.includes('Verify the selected Astra model.')), 'the Codex adapter requests Astra itself, not a fallback model');
  ok(astraRun.ok && astraTab?.model === 'gpt-6-astra' && astraAnswer?.model === 'gpt-6-astra' && astraAnswer?.ok === true, 'the Astra pin and completed answer survive a task reload');
  ok(astraTab?.contextMeter?.windowTokens === 272_000, 'Astra uses the Codex default context window in the tab meter');

  // Codex's suggested next asks (2026-10-02): lifted off the answer onto the
  // message, never shown as text, never a Needs your confirmation card.
  // Its own workstream, so the marker never reaches another tab's shared context.
  const followRepo = (await send('POST', '/api/repos', { name: 'Follow-ups' })).body.repo;
  const followThread = (await send('POST', '/api/tasks', { repo: followRepo.path, model: 'gpt-6-astra', title: 'follow-ups' })).body.task;
  const followTab = followThread.tabs[0];
  const followFileOf = join(HOME, 'tasks', `${followThread.id}.json`);
  const followRun = await fetch(`${BASE}/api/tasks/${followThread.id}/tabs/${followTab.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Match Example Project FIXTURE_FOLLOWUPS', model: 'gpt-6-astra', effort: 'Low' }) });
  await followRun.text();
  const followAnswer = (await get(`/api/tasks/${followThread.id}`)).body.task.tabs.find((candidate) => candidate.id === followTab.id)?.messages?.at(-1);
  ok(followAnswer?.content === 'Example Project fits four lenders.' && !followAnswer.confirmation && followAnswer.followups?.map((row) => row.label).join('|') === 'Submit Example Project|Ask for diligence', 'a GPT answer\'s suggested next asks come off the text, ride the message, and are never an ask', JSON.stringify({ content: followAnswer?.content, confirmation: followAnswer?.confirmation, followups: followAnswer?.followups }));
  const followFile = JSON.parse(readFileSync(followFileOf, 'utf8'));
  const legacyTab = followFile.tabs.find((candidate) => candidate.id === followTab.id);
  legacyTab.messages.push({ role: 'user', content: 'and the shortlist', ts: new Date().toISOString() }, { role: 'assistant', content: 'Shortlist below.\n\n- :codex-followup[Build shortlist]{prompt="Prepare a Example Project lender shortlist covering eCapital, Variant, O15, and Capitala."}', ok: true, ts: new Date().toISOString(), confirmation: { question: ':codex-followup[Build shortlist]{prompt="Prepare a Example Project lender shortlist."}' } });
  writeFileSync(followFileOf, JSON.stringify(followFile, null, 2));
  const legacyAnswer = (await get(`/api/tasks/${followThread.id}`)).body.task.tabs.find((candidate) => candidate.id === followTab.id)?.messages?.at(-1);
  ok(legacyAnswer?.content === 'Shortlist below.' && !legacyAnswer.confirmation && legacyAnswer.followups?.[0]?.label === 'Build shortlist', 'an answer saved before reads without them, and its stale card clears', JSON.stringify({ content: legacyAnswer?.content, confirmation: legacyAnswer?.confirmation }));

  const imageTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'gpt-5.6-sol', name: 'Screenshot review' });
  const imageTabId = imageTabResponse.body.tab?.id;
  const pastedPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const imageRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${imageTabId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Review this pasted screenshot.',
      model: 'gpt-5.6-sol',
      effort: 'Low',
      images: [{ id: 'client-only-id', name: 'clipboard.png', mimeType: 'image/png', size: 68, promptIndex: 0, dataUrl: pastedPng }],
    }),
  });
  await imageRun.text();
  const imageDetail = await get(`/api/tasks/${taskId}`);
  const imageTab = imageDetail.body.task.tabs.find((candidate) => candidate.id === imageTabId);
  const imageUser = imageTab?.messages?.find((message) => message.role === 'user');
  const imageAttachment = imageUser?.attachments?.[0];
  ok(imageRun.ok && imageAttachment?.url?.includes('/attachments/') && imageAttachment.available === true, 'pasted screenshot persists on the user turn with a local preview URL');
  ok(!/data:image|filePath|\.workbench\/attachments/.test(JSON.stringify(imageUser?.attachments || [])), 'task API never leaks pasted image bytes or private paths');
  const attachmentResponse = imageAttachment?.url ? await fetch(`${BASE}${imageAttachment.url}`) : null;
  ok(attachmentResponse?.ok && attachmentResponse.headers.get('content-type') === 'image/png' && (await attachmentResponse.arrayBuffer()).byteLength > 0, 'saved screenshot URL serves the original private image');
  const attachmentFiles = readdirSync(join(HOME, 'attachments', taskId, imageTabId));
  const attachmentPath = join(HOME, 'attachments', taskId, imageTabId, attachmentFiles[0] || 'missing.png');
  ok(attachmentFiles.length === 1 && (statSync(attachmentPath).mode & 0o077) === 0, 'pasted screenshot file is private to the local user');

  // Messages sent while a normal tab is working steer that same provider turn
  // in order. Reusing a request id is idempotent, and the accepted messages
  // become ordinary transcript turns before the final assistant reply.
  const codexSteerTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'gpt-5.6-sol', name: 'Live steering' });
  const codexSteerTabId = codexSteerTabResponse.body.tab?.id;
  const codexSteerRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${codexSteerTabId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Start the live steering fixture.', model: 'gpt-5.6-sol', effort: 'Low' }),
  });
  const codexSteerOne = await send('POST', `/api/tasks/${taskId}/tabs/${codexSteerTabId}/steer`, {
    requestId: 'smoke-codex-steer-0001', prompt: 'Use the shorter opening.' ,
  });
  const codexSteerReplay = await send('POST', `/api/tasks/${taskId}/tabs/${codexSteerTabId}/steer`, {
    requestId: 'smoke-codex-steer-0001', prompt: 'This replay must not be delivered twice.',
  });
  const codexSteerTwo = await send('POST', `/api/tasks/${taskId}/tabs/${codexSteerTabId}/steer`, {
    requestId: 'smoke-codex-steer-0002', prompt: 'Keep the conclusion to one sentence.',
  });
  ok(codexSteerOne.status === 200 && codexSteerTwo.status === 200, 'Codex accepts multiple messages into the active turn');
  ok(codexSteerReplay.status === 200 && codexSteerReplay.body.replayed === true && codexSteerTwo.body.run?.steers?.length === 2, 'live steering is idempotent and ordered in the active snapshot');
  await codexSteerRun.text();
  const codexSteerDetail = await get(`/api/tasks/${taskId}`);
  const codexSteerTab = codexSteerDetail.body.task.tabs.find((candidate) => candidate.id === codexSteerTabId);
  const codexSteeredMessages = (codexSteerTab?.messages || []).filter((message) => message.role === 'user' && message.steered);
  ok(codexSteeredMessages.map((message) => message.content).join('|') === 'Use the shorter opening.|Keep the conclusion to one sentence.', 'Codex steering messages persist once, in send order, before the reply');
  ok(/Use the shorter opening\.[\s\S]*Keep the conclusion to one sentence\./.test(codexSteerTab?.messages?.at(-1)?.content || ''), 'the Codex fixture receives both steering messages inside one live run');
  ok((codexSteerTab?.messages || []).every((message) => message.role !== 'assistant' || message.interim || message === codexSteerTab.messages.at(-1)), 'any answer split off before a steer is marked as an interim');

  const claudeSteerTabResponse = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet', name: 'Claude live steering' });
  const claudeSteerTabId = claudeSteerTabResponse.body.tab?.id;
  const claudeSteerRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${claudeSteerTabId}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Start the Claude live steering fixture.', model: 'sonnet', effort: 'Low' }),
  });
  const claudeSteerOne = await send('POST', `/api/tasks/${taskId}/tabs/${claudeSteerTabId}/steer`, {
    requestId: 'smoke-claude-steer-0001', prompt: 'Prioritize the confirmed examples.',
  });
  const claudeSteerTwo = await send('POST', `/api/tasks/${taskId}/tabs/${claudeSteerTabId}/steer`, {
    requestId: 'smoke-claude-steer-0002', prompt: 'End with the next action.',
  });
  ok(claudeSteerOne.status === 200 && claudeSteerTwo.status === 200, 'Claude accepts multiple realtime inputs while its response is working');
  await claudeSteerRun.text();
  const claudeSteerDetail = await get(`/api/tasks/${taskId}`);
  const claudeSteerTab = claudeSteerDetail.body.task.tabs.find((candidate) => candidate.id === claudeSteerTabId);
  const claudeSteeredMessages = (claudeSteerTab?.messages || []).filter((message) => message.role === 'user' && message.steered);
  const claudePromptLog = readFileSync(join(HOME, 'fixture-claude-prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const claudeLiveInputs = claudePromptLog.filter((entry) => entry.index > 0).slice(-2).map((entry) => entry.prompt);
  ok(claudeSteeredMessages.map((message) => message.content).join('|') === 'Prioritize the confirmed examples.|End with the next action.', 'Claude steering messages persist as ordered user turns');
  ok(claudeLiveInputs.length === 2 && claudeLiveInputs[0].endsWith('Prioritize the confirmed examples.') && claudeLiveInputs[1].endsWith('End with the next action.') && claudeLiveInputs.every((value) => value.startsWith('Sent while you were still working on my previous message.')), 'Claude receives both messages through its still-open realtime input stream, each framed as an addition');

  const layoutUpdatedAt = Date.now();
  const layoutPanes = Array.from({ length: 6 }, (_, index) => ({
    threadId: taskId,
    tabId: index % 2 === 0 ? task.body.task.tabs[0].id : tab.body.tab.id,
    width: index + 1,
  }));
  const layoutPatch = await send('PATCH', '/api/settings', {
    threadLayout: {
      root: taskId,
      layout: { panes: layoutPanes, updatedAt: layoutUpdatedAt },
      updatedAt: layoutUpdatedAt,
    },
  });
  const layoutSettings = await get('/api/settings');
  const savedLayout = layoutSettings.body.threadLayouts?.[taskId];
  ok(layoutPatch.status === 200 && savedLayout?.panes?.length === 6, 'split layouts persist more than four panes');
  ok(savedLayout?.panes?.every((pane, index) => pane.width === index + 1), 'split layouts persist custom pane widths');

  const batchPrompts = ['First queued instruction.', 'Second queued instruction.', 'Final clarification.'];
  const batchRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${tab.body.tab.id}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompts: batchPrompts, model: 'opus', effort: 'Low' }),
  });
  await batchRun.text();
  const batchDetail = await get(`/api/tasks/${taskId}`);
  const batchTab = (batchDetail.body.task.tabs || []).find((candidate) => candidate.id === tab.body.tab.id);
  const batchUser = batchTab?.messages?.[batchTab.messages.length - 2];
  ok(batchRun.ok && Array.isArray(batchUser?.batch) && batchUser.batch.length === 3, 'queued messages persist as one ordered next-turn batch');
  ok(batchPrompts.every((prompt, index) => batchUser?.batch?.[index] === prompt), 'queued batch preserves every message in send order');
  const batchAssistant = batchTab?.messages?.[batchTab.messages.length - 1];
  ok(Array.isArray(batchAssistant?.workNotes) && batchAssistant.workNotes.includes('I’ll verify the connected accounts first.'), 'provider narration persists as explicit work notes');
  ok(Array.isArray(batchAssistant?.connectors) && batchAssistant.connectors.some((connector) => connector?.connector === 'Granola' && connector?.state === 'done'), 'completed connector calls persist as structured receipts');
  ok(batchAssistant?.effort === 'Low', 'completed replies preserve their selected effort');
  ok(!String(batchAssistant?.content || '').includes('I’ll verify the connected accounts first.') && String(batchAssistant?.content || '').startsWith('Results:'), 'the saved assistant content contains only the final answer');
  const linkedInTouch = batchAssistant?.outsideTouches?.find((touch) => touch.platform === 'LinkedIn');
  const notionTouch = batchAssistant?.outsideTouches?.find((touch) => touch.platform === 'Notion');
  ok(linkedInTouch?.url?.startsWith('https://www.linkedin.com/'), 'LinkedIn outside touch links back to LinkedIn');
  ok(notionTouch?.url?.startsWith('https://www.notion.so/'), 'Notion outside touch links back to Notion');

  const contextTarget = await send('POST', `/api/tasks/${taskId}/tabs`, { model: 'sonnet' });
  const contextRun = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${contextTarget.body.tab.id}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Use the pricing decision from the attached terminal.',
      model: 'sonnet',
      effort: 'Low',
      terminalContexts: [{
        sourceTaskId: taskId,
        sourceTabId: tab.body.tab.id,
        guidance: 'Find and use the queued pricing decision only.',
      }],
    }),
  });
  await contextRun.text();
  const contextDetail = await get(`/api/tasks/${taskId}`);
  const contextTab = contextDetail.body.task.tabs.find((candidate) => candidate.id === contextTarget.body.tab.id);
  const contextUser = contextTab?.messages?.find((message) => message.role === 'user');
  const contextFiles = readdirSync(join(HOME, 'context-shares')).filter((name) => name.endsWith('.md'));
  const contextPath = join(HOME, 'context-shares', contextFiles[0] || 'missing.md');
  const contextMarkdown = contextFiles.length ? readFileSync(contextPath, 'utf8') : '';
  ok(contextRun.ok && contextUser?.terminalContexts?.[0]?.sourceTabId === tab.body.tab.id, 'cross-terminal context is attached to the saved user turn');
  ok(!JSON.stringify(contextUser?.terminalContexts || []).includes(HOME) && !('filePath' in (contextUser?.terminalContexts?.[0] || {})), 'private transcript paths never leak into the task API');
  ok(contextFiles.length === 1 && contextMarkdown.includes('# Supreme terminal transcript') && contextMarkdown.includes('First queued instruction.'), 'backend writes the source tab’s full Markdown transcript at send time');
  ok((statSync(contextPath).mode & 0o077) === 0, 'terminal transcript snapshot is private to the local user');

  // A picked Duel becomes a normal tab with the winning model, while the
  // source gets a timeline receipt + the same winner without a duplicate
  // visible user bubble.
  const firstTab = task.body.task.tabs[0].id;
  const duelSetupRequestId = 'smoke-duel-setup-0001';
  const duelSetup = await send('POST', `/api/tasks/${taskId}/duel`, { setup: true, sourceTabId: firstTab, requestId: duelSetupRequestId });
  const replayedDuelSetup = await send('POST', `/api/tasks/${taskId}/duel`, { setup: true, sourceTabId: firstTab, requestId: duelSetupRequestId });
  const duelTab = (duelSetup.body.task.tabs || []).find((candidate) => candidate.id === duelSetup.body.duelTabId);
  const duelId = duelTab?.duel?.duelId;
  ok(duelSetup.status === 200 && duelId && duelTab?.type === 'duel', 'Duel setup creates a temporary Duel tab');
  ok(replayedDuelSetup.status === 200 && replayedDuelSetup.body.duelTabId === duelSetup.body.duelTabId && replayedDuelSetup.body.replayed === true, 'Duel setup is idempotent when Electron loses the first response');
  const duelLock = await send('POST', `/api/tasks/${taskId}/duel/${duelId}/lock`, { effort: 'High' });
  ok(duelLock.status === 200, 'Duel contenders lock against the source context');
  const duelRunRequestId = 'smoke-duel-run-0001';
  const duelRunBody = { tabId: duelSetup.body.duelTabId, prompt: 'Draft the strongest short answer.', effort: 'High', requestId: duelRunRequestId };
  const duelRunPromise = send('POST', `/api/tasks/${taskId}/duel`, duelRunBody);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const inFlightDuelReplay = await send('POST', `/api/tasks/${taskId}/duel`, duelRunBody);
  const duelRun = await duelRunPromise;
  const replayedDuelRun = await send('POST', `/api/tasks/${taskId}/duel`, duelRunBody);
  const resultTab = (duelRun.body.task.tabs || []).find((candidate) => candidate.id === duelSetup.body.duelTabId);
  ok(inFlightDuelReplay.status === 202 && inFlightDuelReplay.body.running === true, 'an in-flight Duel retry reconnects to the saved run instead of starting two contenders');
  ok(duelRun.status === 200 && resultTab?.duel?.phase === 'results' && resultTab?.duel?.a?.ok !== false && resultTab?.duel?.b?.ok !== false, 'Duel returns two blind results even after a transient Codex 401');
  ok(replayedDuelRun.status === 200 && replayedDuelRun.body.duelTabId === duelSetup.body.duelTabId && replayedDuelRun.body.replayed === true, 'completed Duel run is idempotent when its response is retried');
  ok(!/orphan custom tool|401 unauthorized|responses_websocket/i.test(JSON.stringify(resultTab?.duel || {})), 'raw Codex transport errors never leak into Duel output');
  const codexPromptLog = readFileSync(join(HOME, 'fixture-codex-prompts.jsonl'), 'utf8');
  const codexInvocations = codexPromptLog.trim().split('\n').map((line) => JSON.parse(line));
  const imageInvocation = codexInvocations.find((entry) => entry.args?.includes('-i'));
  const imageArgIndex = imageInvocation?.args?.indexOf('-i') ?? -1;
  ok(imageArgIndex >= 0 && imageInvocation.args[imageArgIndex + 1]?.startsWith(join(HOME, 'attachments')), 'Codex receives the pasted screenshot as a native image input');
  ok(/Do not repeat any action that already completed/.test(codexPromptLog), 'Codex recovery explicitly verifies platform state before repeating an action');
  ok(serverErr.includes('transient websocket authorization failure; retrying'), 'Codex transient authorization recovery is logged for diagnosis');
  const duelPick = await send('POST', `/api/tasks/${taskId}/duel/${duelId}/pick`, { choice: 'b' });
  const pickedSource = (duelPick.body.task.tabs || []).find((candidate) => candidate.id === firstTab);
  const pickedDuelTab = (duelPick.body.task.tabs || []).find((candidate) => candidate.id === duelSetup.body.duelTabId);
  ok(duelPick.status === 200 && duelPick.body.sourceTabId === firstTab && duelPick.body.duelTabId === duelSetup.body.duelTabId, 'picking a winner links the Duel and source tabs');
  ok(pickedDuelTab && !pickedDuelTab.type && pickedDuelTab.duel?.choice === 'b' && duelPick.body.task.activeTab === pickedDuelTab.id, 'picked Duel becomes the active normal tab');
  ok(pickedDuelTab?.messages?.[0]?.role === 'user' && pickedDuelTab?.messages?.[1]?.fromDuel === duelId, 'normal Duel tab keeps the prompt and winner as its conversation');
  ok(pickedSource?.duels?.[0]?.duelId === duelId && pickedSource.duels[0].choice === 'b', 'picked comparison is embedded in the source timeline');
  ok(pickedSource?.messages?.[0]?.hiddenInTranscript === true && pickedSource?.messages?.[1]?.fromDuel === duelId, 'Duel prompt stays hidden while the winning answer becomes a normal message');
  const duelHistory = await get('/api/duels');
  ok(duelHistory.status === 200 && duelHistory.body.count === 1 && duelHistory.body.duels[0]?.id === duelId, 'embedded picked Duel appears once in Duel history');

  // SSE framing: start a run, read the first frames, then cancel via the
  // tab-scoped endpoint. We only assert the wire format, not a full agent turn.
  const runRes = await fetch(`${BASE}/api/tasks/${taskId}/tabs/${firstTab}/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'smoke: reply with the single word ok', model: 'sonnet', effort: 'Low' }),
  });
  ok(runRes.ok && (runRes.headers.get('content-type') || '').includes('text/event-stream'), 'run endpoint responds with text/event-stream');
  let sawData = false; let sawStart = false;
  if (runRes.body) {
    const reader = runRes.body.getReader();
    const dec = new TextDecoder();
    const started = Date.now();
    let buf = '';
    while (Date.now() - started < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('data: ')) sawData = true;
      if (buf.includes('"type":"start"')) { sawStart = true; break; }
    }
    await reader.cancel().catch(() => {});
  }
  ok(sawData, 'run stream emits `data:` frames');
  ok(sawStart, 'run stream emits a start event');
  // Cancel it so the scratch run does not linger.
  await send('POST', `/api/tasks/${taskId}/tabs/${firstTab}/cancel`).catch(() => {});
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await get(`/api/tasks/${taskId}`);
    if (!(current.body.runningTabs || []).includes(firstTab)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const badCancel = await send('POST', '/api/runs/00000000-0000-0000-0000-000000000000/cancel');
  ok(badCancel.status === 404, 'cancel of unknown run 404s');

  const archiveDuelSource = await send('DELETE', `/api/tasks/${taskId}/tabs/${firstTab}`);
  ok(archiveDuelSource.status === 200, 'source tab with a Duel can be archived');
  const historyAfterDelete = await get('/api/duels');
  ok(historyAfterDelete.status === 200 && historyAfterDelete.body.count === 0, 'deleted or archived Duels stay out of Duel history');

  const permanentTabDelete = await send('DELETE', `/api/tasks/${taskId}/tabs/${firstTab}/permanent`);
  ok(permanentTabDelete.status === 200 && !(permanentTabDelete.body.task.archivedTabs || []).some((candidate) => candidate.id === firstTab), 'an archived tab can be permanently deleted');
  ok((permanentTabDelete.body.task.deletedTabs || []).some((row) => row.id === firstTab), 'a permanent tab delete leaves a tombstone so a shared merge cannot bring it back');

  const activeThreadDelete = await send('DELETE', `/api/tasks/${taskId}`);
  ok(activeThreadDelete.status === 409, 'an active workstream must be archived before permanent deletion');
  const archiveThread = await send('PATCH', `/api/tasks/${taskId}`, { archived: true });
  const permanentThreadDelete = await send('DELETE', `/api/tasks/${taskId}`);
  const deletedThread = await get(`/api/tasks/${taskId}`);
  ok(archiveThread.status === 200 && permanentThreadDelete.status === 200 && deletedThread.status === 404, 'an archived workstream can be permanently deleted');

  const cascadeTask = await send('POST', '/api/tasks', {
    repo: staleManagedPath,
    projectId: repo.body.repo.id,
    model: 'sonnet',
    title: 'project cascade delete',
  });
  const activeProjectDelete = await send('DELETE', `/api/repos?path=${encodeURIComponent(staleManagedPath)}`);
  ok(activeProjectDelete.status === 409, 'an active project must be archived before permanent deletion');

  // A Claude row is an alias the CLI maps to its newest model; the label
  // follows the concrete id the CLI answered with (the fixture says 5.2).
  const modelsAfter = await get('/api/models');
  const sonnetRow = (modelsAfter.body.models || []).find((m) => m.id === 'sonnet');
  ok(sonnetRow?.label === 'Sonnet 5.2' && sonnetRow?.apiModel === 'claude-sonnet-5-2', 'a Claude alias row is labelled by the model the CLI answered with');
  const archiveProject = await send('PATCH', '/api/repos', { path: staleManagedPath, archived: true });
  const permanentProjectDelete = await send('DELETE', `/api/repos?path=${encodeURIComponent(staleManagedPath)}`);
  const deletedProjectTask = await get(`/api/tasks/${cascadeTask.body.task.id}`);
  const reposAfterDelete = await get('/api/repos');
  ok(
    archiveProject.status === 200
      && permanentProjectDelete.status === 200
      && permanentProjectDelete.body.deletedWorkstreams === 1
      && deletedProjectTask.status === 404
      && !reposAfterDelete.body.repos.some((candidate) => candidate.path === staleManagedPath),
    'deleting an archived project permanently removes its Supreme workstreams',
  );

  console.log(failures ? `\nSMOKE: FAIL (${failures})` : '\nSMOKE: PASS');
  process.exitCode = failures ? 1 : 0;
} catch (e) {
  console.log('SMOKE: ERROR ' + e.message);
  process.exitCode = 1;
} finally {
  server.kill('SIGKILL');
  if (process.env.WB_KEEP_SMOKE_HOME === '1') console.log(`Retained scratch home: ${HOME}`);
  else try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
