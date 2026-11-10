// The read behind onboarding (Paper section 14): what Supreme can honestly
// know about a new user before they type anything. The seed is local. Both
// model CLIs keep their own histories on this Mac (prompts, thread names,
// memory, instructions, skills) and the connectors say which tools are
// already authorised. Neither web account is readable from here, so nothing
// below pretends to have it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SESSIONS = 300;
const MAX_PROMPTS = 120;
const MAX_FILE_BYTES = 64 * 1024;
const RECENT_DAYS = 120;
const SENT_MAIL_DAYS = 90;
const MAX_SENT_SAMPLES = 40;

function clean(value, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function newest(files, limit) {
  return files
    .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((entry) => entry.file);
}

function listFiles(dir, suffix, depth = 0) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (depth < 4) out.push(...listFiles(full, suffix, depth + 1)); continue; }
    if (entry.isFile() && entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function readHead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, MAX_FILE_BYTES, 0);
      return buffer.toString('utf8', 0, bytes);
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join(' ');
  return '';
}

// A real request the user typed, not the harness noise that wraps it.
function meaningful(text) {
  const value = clean(text, 600);
  if (!value || value.length < 8) return '';
  if (/^<(?:system-reminder|command-name|local-command-stdout|task-notification)/i.test(value)) return '';
  if (/^(?:\/[a-z-]+\b|continue$|ok$|yes$|no$)/i.test(value)) return '';
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function headings(file, max = 24) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((line) => /^#{1,3}\s+\S/.test(line))
      .map((line) => clean(line.replace(/^#+\s*/, ''), 80))
      .filter(Boolean)
      .slice(0, max);
  } catch { return []; }
}

function frontmatterDescriptions(files, max = 60) {
  const out = [];
  for (const file of files.slice(0, 400)) {
    const head = readHead(file).slice(0, 2000);
    const match = head.match(/^description:\s*(.+)$/m);
    if (match) out.push(clean(match[1], 140));
    if (out.length >= max) break;
  }
  return out;
}

function dirNames(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, 40); } catch { return []; }
}

function claudeEvidence(home, since) {
  const root = path.join(home, '.claude');
  const sessions = newest(listFiles(path.join(root, 'projects'), '.jsonl'), MAX_SESSIONS);
  const prompts = [];
  const cwds = new Map();
  for (const file of sessions) {
    const head = readHead(file);
    let first = null;
    for (const line of head.split('\n')) {
      if (!line.startsWith('{')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'user' || row.isMeta || row.isSidechain) continue;
      const text = meaningful(promptText(row.message?.content));
      if (!text) continue;
      const at = Date.parse(row.timestamp || '') || 0;
      if (row.cwd) cwds.set(row.cwd, (cwds.get(row.cwd) || 0) + 1);
      first = { text, at: at ? new Date(at).toISOString() : null, cwd: row.cwd || null };
      break;
    }
    if (first && (!first.at || Date.parse(first.at) >= since)) prompts.push(first);
    if (prompts.length >= MAX_PROMPTS) break;
  }
  const memoryFiles = listFiles(path.join(root, 'projects'), '.md').filter((file) => /\/memory\//.test(file));
  return {
    sessions: sessions.length,
    prompts,
    projects: [...cwds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([cwd, count]) => ({ name: path.basename(cwd) || cwd, count })),
    memoryTopics: frontmatterDescriptions(memoryFiles),
    memoryFiles: memoryFiles.length,
    instructions: headings(path.join(root, 'CLAUDE.md')),
    skills: dirNames(path.join(root, 'skills')),
  };
}

function codexEvidence(home, since) {
  const root = path.join(home, '.codex');
  const prompts = [];
  try {
    const lines = fs.readFileSync(path.join(root, 'history.jsonl'), 'utf8').trim().split('\n').slice(-600).reverse();
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const text = meaningful(row.text);
      if (!text) continue;
      const at = Number(row.ts) ? new Date(Number(row.ts) * (Number(row.ts) > 1e12 ? 1 : 1000)).toISOString() : null;
      if (at && Date.parse(at) < since) continue;
      prompts.push({ text, at, cwd: null });
      if (prompts.length >= MAX_PROMPTS) break;
    }
  } catch {}
  const threads = [];
  try {
    const lines = fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8').trim().split('\n').slice(-200).reverse();
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const name = clean(row.thread_name, 100);
      if (name && !threads.includes(name)) threads.push(name);
      if (threads.length >= 60) break;
    }
  } catch {}
  return {
    sessions: listFiles(path.join(root, 'sessions'), '.jsonl').length,
    prompts,
    threads,
    instructions: headings(path.join(home, 'AGENTS.md')),
    skills: dirNames(path.join(root, 'skills')),
  };
}

// Sent mail is the one signal that shows how the user writes to other people,
// not to a model. Whichever route fetches it (Supreme's own Gmail read or a
// provider connector), the caller hands the raw messages here and this shapes
// them the same way: a count, the domains they write to most, and a sample of
// subject + first line pairs from the recent window. No bodies are kept.
export function normalizeSentMail(raw, { now = Date.now() } = {}) {
  const since = now - SENT_MAIL_DAYS * 86_400_000;
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
  const messages = [];
  const domains = new Map();
  for (const row of rows) {
    const at = Date.parse(row?.at || row?.date || '') || 0;
    if (at && at < since) continue;
    const to = clean(row?.to, 120);
    const subject = clean(row?.subject, 120);
    const firstLine = clean(row?.firstLine ?? String(row?.body || '').split('\n').find((line) => line.trim()), 160);
    if (!subject && !firstLine) continue;
    for (const match of to.match(/@([a-z0-9.-]+)/gi) || []) {
      const domain = match.slice(1).toLowerCase();
      domains.set(domain, (domains.get(domain) || 0) + 1);
    }
    messages.push({ to, subject, firstLine, at: at ? new Date(at).toISOString() : null });
  }
  return {
    count: Math.max(messages.length, Math.floor(Number(raw?.count) || 0)),
    windowDays: SENT_MAIL_DAYS,
    topDomains: [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, count]) => ({ domain, count })),
    messages: messages.slice(0, MAX_SENT_SAMPLES),
  };
}

export function collectInheritedEvidence({ home = os.homedir(), connectors = [], sentMail = null, now = Date.now() } = {}) {
  const since = now - RECENT_DAYS * 86_400_000;
  const claude = claudeEvidence(home, since);
  const codex = codexEvidence(home, since);
  const mail = normalizeSentMail(sentMail, { now });
  const tools = [...new Set((Array.isArray(connectors) ? connectors : [])
    .filter((connector) => connector && connector.connected !== false)
    .map((connector) => clean(connector.name, 40)).filter(Boolean))];
  return {
    claude,
    codex,
    sentMail: mail,
    tools,
    counts: {
      claudeSessions: claude.sessions,
      codexSessions: codex.sessions,
      prompts: claude.prompts.length + codex.prompts.length,
      sentEmails: mail.count,
      memoryFiles: claude.memoryFiles,
      skills: claude.skills.length + codex.skills.length,
      tools: tools.length,
    },
    windowDays: RECENT_DAYS,
  };
}

// ---------------------------------------------------------------------------
// The read itself: one model call that returns JSON, and a deterministic
// version for when no model is connected or the model does not answer.

export function onboardingReadPrompt({ profile, evidence, answers }) {
  answers = answers || {};
  const lines = [];
  lines.push('You are Supreme, a chief of staff who works alongside the user. This is your first read of a new user, before they have typed anything. Answer with JSON only, no prose, no code fence.');
  lines.push('');
  lines.push('Who they are (from LinkedIn):');
  lines.push(JSON.stringify({ name: profile?.name, headline: profile?.headline, company: profile?.company, role: profile?.role, location: profile?.location, summary: profile?.summary }));
  lines.push('');
  lines.push(`What they already do with AI on this Mac (last ${evidence.windowDays} days). Recent requests they typed, newest first:`);
  for (const prompt of [...evidence.claude.prompts, ...evidence.codex.prompts].slice(0, 80)) lines.push(`- ${prompt.text}`);
  if (evidence.codex.threads.length) lines.push(`Thread names in ChatGPT/Codex: ${evidence.codex.threads.slice(0, 40).join(' | ')}`);
  if (evidence.claude.projects.length) lines.push(`Project folders worked in: ${evidence.claude.projects.map((project) => `${project.name} (${project.count})`).join(', ')}`);
  if (evidence.claude.memoryTopics.length) lines.push(`Things Claude has remembered about them: ${evidence.claude.memoryTopics.slice(0, 40).join(' | ')}`);
  if (evidence.claude.instructions.length || evidence.codex.instructions.length) lines.push(`Standing instructions they wrote: ${[...evidence.claude.instructions, ...evidence.codex.instructions].slice(0, 30).join(' | ')}`);
  if (evidence.claude.skills.length || evidence.codex.skills.length) lines.push(`Skills they installed: ${[...evidence.claude.skills, ...evidence.codex.skills].join(', ')}`);
  lines.push(`Tools already connected: ${evidence.tools.join(', ') || 'none'}`);
  if (evidence.sentMail?.count) {
    lines.push('');
    lines.push(`Mail they sent in the last ${evidence.sentMail.windowDays} days: ${evidence.sentMail.count} messages. This is how they actually write to people, so weigh it heavily for voice, and let it inform areas and directions too.`);
    if (evidence.sentMail.topDomains.length) lines.push(`Who they write to most: ${evidence.sentMail.topDomains.map((entry) => `${entry.domain} (${entry.count})`).join(', ')}`);
    for (const message of evidence.sentMail.messages.slice(0, 30)) {
      lines.push(`- ${[message.subject ? `"${message.subject}"` : '', message.firstLine].filter(Boolean).join(' — ')}`);
    }
  }
  if (answers.roleNote) lines.push(`They corrected the role read: "${answers.roleNote}"`);
  if (answers.somethingElse) lines.push(`They added an area: "${answers.somethingElse}"`);
  if (answers.voiceNote) lines.push(`They described their own voice: "${answers.voiceNote}"`);
  lines.push('');
  lines.push('Return exactly this JSON shape:');
  lines.push('{"roleLine": "one sentence, second person, what they are and what the evidence says they are mostly on, e.g. Founder at Vime, and from the last few months it looks like you are mostly on the broker side.",');
  lines.push(' "areas": [{"label": "3 to 6 words, an area of their week", "evidence": "a short phrase with a real count from the inputs", "preselected": true}],');
  lines.push(' "voice": {"summary": "one sentence of concrete writing traits, taken from how they actually write in the requests and sent mail above", "sources": {"prompts": 0, "sentEmails": 0, "transcripts": 0}},');
  lines.push(' "directions": [{"title": "at most six words, a noun phrase", "detail": "one line: the scoped task and the concrete thing it produces", "needs": [], "prompt": "the full instruction Supreme will run, written to the agent, concrete, ending with what must not happen without approval"}],');
  lines.push(' "thin": false, "gap": ""}');
  lines.push('Rules: four to six areas with exactly two preselected; exactly two directions, each a task the evidence shows they were going to do anyway, never a demo; counts only from the inputs, never invented; needs lists tools from Gmail, Chrome, Notion, Slack, Calendar, Drive that the task cannot do without; nothing that reaches another person may be sent without approval, say so in the prompt; if the evidence is thin, set thin true and write gap as one sentence naming what is missing and the one source that would fix it.');
  return lines.join('\n');
}

export function parseOnboardingRead(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const areas = (Array.isArray(parsed.areas) ? parsed.areas : []).map((area) => ({
    label: clean(area?.label, 60), evidence: clean(area?.evidence, 120), preselected: !!area?.preselected,
  })).filter((area) => area.label).slice(0, 6);
  if (areas.filter((area) => area.preselected).length !== 2) {
    areas.forEach((area, index) => { area.preselected = index < 2; });
  }
  const directions = (Array.isArray(parsed.directions) ? parsed.directions : []).map((direction) => ({
    title: clean(direction?.title, 60), detail: clean(direction?.detail, 200),
    needs: (Array.isArray(direction?.needs) ? direction.needs : []).map((need) => clean(need, 24)).filter(Boolean).slice(0, 4),
    prompt: String(direction?.prompt || '').trim().slice(0, 4000),
  })).filter((direction) => direction.title && direction.prompt).slice(0, 2);
  if (!areas.length || directions.length < 1) return null;
  const sources = parsed.voice?.sources && typeof parsed.voice.sources === 'object' ? parsed.voice.sources : {};
  return {
    roleLine: clean(parsed.roleLine, 240),
    areas,
    voice: {
      summary: clean(parsed.voice?.summary, 240),
      sources: { prompts: Number(sources.prompts) || 0, sentEmails: Number(sources.sentEmails) || 0, transcripts: Number(sources.transcripts) || 0 },
    },
    directions,
    thin: !!parsed.thin,
    gap: clean(parsed.gap, 240),
  };
}

// No model, or the model did not answer: still say something true.
export function deterministicOnboardingRead({ profile, evidence }) {
  const role = [profile?.role || profile?.headline, profile?.company].filter(Boolean).join(' at ');
  const projects = evidence.claude.projects.map((project) => project.name).filter((name) => name && name !== '-' && name !== 'private-tmp');
  const threads = evidence.codex.threads;
  const areaSeeds = [...threads.slice(0, 3), ...projects.slice(0, 3)].map((name) => clean(name, 48)).filter(Boolean);
  const areas = areaSeeds.slice(0, 5).map((label, index) => ({ label, evidence: index < 3 && threads.length ? 'a recent thread' : 'a project you work in', preselected: index < 2 }));
  const recent = [...evidence.codex.prompts, ...evidence.claude.prompts].filter((prompt) => prompt.text).slice(0, 2);
  const directions = recent.map((prompt) => ({
    title: clean(prompt.text.split(/[.:,]/)[0], 40) || 'Pick up where you left off',
    detail: `Pick up where you left off: "${clean(prompt.text, 90)}"`,
    needs: [],
    prompt: `Pick up this request the user made recently and finish it properly: "${prompt.text}". Work from what is on this Mac and the connected tools. Do not send, post, or message anyone without asking first.`,
  }));
  const thin = evidence.counts.prompts < 5;
  return {
    roleLine: role ? `${role}. I have not seen enough of your work yet to say what fills your week.` : 'I do not have your profile yet, so this read is from what is on this Mac.',
    areas: areas.length ? areas : [{ label: 'What you work on most', evidence: 'nothing inherited yet', preselected: true }],
    voice: { summary: evidence.counts.sentEmails ? 'Plain and direct, from your requests and the mail you sent.' : 'Plain and direct, from the few requests I could see.', sources: { prompts: evidence.counts.prompts, sentEmails: evidence.counts.sentEmails || 0, transcripts: 0 } },
    directions: directions.length ? directions : [{ title: 'Tell me the right one', detail: 'Nothing inherited yet, so you set the first task.', needs: [], prompt: '' }],
    thin,
    gap: thin ? 'I can see almost nothing yet. Connecting Gmail would show me the week.' : '',
  };
}

// The instruction that starts the first workstream, carrying everything the
// user confirmed or corrected at sign up.
export function firstTaskPrompt({ profile, read, answers, direction }) {
  answers = answers || {};
  const chosenAreas = (answers?.areas || []).length ? answers.areas : (read?.areas || []).filter((area) => area.preselected).map((area) => area.label);
  const lines = [
    'This is the first task for a new Supreme user, started from what Supreme read at sign up. Work like a chief of staff: finish the task properly, keep the user in charge of anything that reaches another person, and say plainly what you did and did not do.',
    '',
    'About the user:',
    `- ${[profile?.name, profile?.headline].filter(Boolean).join(', ') || 'Profile not available'}${profile?.company ? ` (${profile.company})` : ''}`,
    read?.roleLine ? `- Role read: ${read.roleLine}${answers?.role === 'not-quite' && answers?.roleNote ? ` They corrected this: "${answers.roleNote}".` : ''}` : '',
    chosenAreas.length ? `- Areas that fill their week: ${chosenAreas.join('; ')}${answers?.somethingElse ? `; ${answers.somethingElse}` : ''}` : '',
    read?.voice?.summary ? `- How they write: ${answers?.voice === 'own' && answers?.voiceNote ? answers.voiceNote : read.voice.summary}` : '',
    '',
    'The task:',
    direction?.prompt || direction?.detail || direction?.title || '',
    '',
    'Nothing that reaches another person (email, message, post, invitation) may be sent without asking first. Draft it, show it, and stop.',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

export function onboardingContextBlock({ profile, read, answers }) {
  answers = answers || {};
  const lines = [];
  if (profile?.name) lines.push(`${profile.name}${profile.headline ? `, ${profile.headline}` : ''}${profile.company ? ` at ${profile.company}` : ''}${profile.location ? ` (${profile.location})` : ''}.`);
  if (read?.roleLine) lines.push(answers?.role === 'not-quite' && answers?.roleNote ? `Role, in their words: ${answers.roleNote}` : read.roleLine);
  const areas = (answers?.areas || []).length ? answers.areas : (read?.areas || []).filter((area) => area.preselected).map((area) => area.label);
  if (areas.length) lines.push(`Areas that fill their week: ${[...areas, answers?.somethingElse].filter(Boolean).join('; ')}.`);
  if (read?.voice?.summary || answers?.voiceNote) lines.push(`How they write: ${answers?.voice === 'own' && answers?.voiceNote ? answers.voiceNote : read.voice.summary}`);
  return lines.join('\n');
}
