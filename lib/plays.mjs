// Plays (Paper section 17): things the user taught Supreme by doing them once.
// A play is a name, a "use it when" line and a block of rules in the user's
// own words. Running one is an agent that types: it sends one message per
// rule into the thread and everything downstream is the app as it already is.
// This module owns the store, the rules format, and the prompts; the runner
// and the routes live in server.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, newId, changes } from './store.mjs';

const PLAYS_FILE = path.join(DATA_DIR, 'plays.json');
const MAX_RULES = 9;

// ---------------------------------------------------------------------------
// Store

export function loadPlays() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PLAYS_FILE, 'utf8'));
    return Array.isArray(parsed?.plays) ? parsed.plays.filter((play) => play && typeof play === 'object' && play.id) : [];
  } catch {
    return [];
  }
}

export function savePlays(plays) {
  fs.mkdirSync(path.dirname(PLAYS_FILE), { recursive: true });
  const tmp = `${PLAYS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, plays }, null, 2));
  fs.renameSync(tmp, PLAYS_FILE);
  // Same team mirrors the plays of a shared project (lib/team.mjs).
  changes.emit('change', { kind: 'plays', data: plays });
  return plays;
}

export function getPlay(id) {
  return loadPlays().find((play) => play.id === id) || null;
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createPlay(input = {}) {
  const now = new Date().toISOString();
  const play = {
    id: newId(),
    name: clean(input.name, 80) || 'Untitled play',
    useWhen: clean(input.useWhen, 200),
    rules: sanitizeRulesHtml(input.rules || ''),
    projectId: input.projectId || null,
    repo: input.repo || null,
    repoName: clean(input.repoName, 80) || null,
    sourceTaskId: input.sourceTaskId || null,
    sourceTabId: input.sourceTabId || null,
    ...(input.createdBy && typeof input.createdBy === 'object' ? { createdBy: { id: input.createdBy.id, name: input.createdBy.name } } : {}),
    createdAt: now,
    updatedAt: now,
    runs: 0,
    lastRunAt: null,
  };
  const plays = loadPlays();
  plays.push(play);
  savePlays(plays);
  return play;
}

export function updatePlay(id, patch = {}) {
  const plays = loadPlays();
  const play = plays.find((candidate) => candidate.id === id);
  if (!play) return null;
  if (typeof patch.name === 'string') play.name = clean(patch.name, 80) || play.name;
  if (typeof patch.useWhen === 'string') play.useWhen = clean(patch.useWhen, 200);
  if (typeof patch.rules === 'string') play.rules = sanitizeRulesHtml(patch.rules);
  // Same team: who last changed a shared play (the panel's "changed by" line).
  if (patch.updatedBy && typeof patch.updatedBy === 'object' && patch.updatedBy.id) play.updatedBy = { id: patch.updatedBy.id, name: patch.updatedBy.name || '' };
  if (patch.noteRun) {
    play.runs = (Number(play.runs) || 0) + 1;
    play.lastRunAt = new Date().toISOString();
  }
  play.updatedAt = new Date().toISOString();
  savePlays(plays);
  return play;
}

export function deletePlay(id) {
  const plays = loadPlays();
  const next = plays.filter((play) => play.id !== id);
  if (next.length === plays.length) return false;
  savePlays(next);
  return true;
}

export function playPublic(play) {
  if (!play) return null;
  return { ...play, rulesText: rulesHtmlToText(play.rules), steps: rulesHtmlToSteps(play.rules) };
}

// ---------------------------------------------------------------------------
// The rules block. The panel edits a small HTML subset in place (numbered by
// default, but the user can turn lines into paragraphs, bullets or headers);
// a connector mention is one token, <span class="play-token" data-name="Gmail">.
// The model and the Plays list read the plain text derived from it.

const ALLOWED = new Set(['h3', 'p', 'ol', 'ul', 'li', 'b', 'strong', 'i', 'em', 'u', 'br', 'span', 'div']);

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function tokenHtml(name) {
  const safe = escapeHtml(clean(name, 40));
  return `<span class="play-token" contenteditable="false" data-name="${safe}">${safe}</span>`;
}

// Keep only the tags the editor produces; on a span keep only the token
// attributes, everything else loses its attributes. Scripts and styles go.
export function sanitizeRulesHtml(html) {
  let out = String(html || '').slice(0, 40_000);
  out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED.has(tag)) return '';
    const closing = match.startsWith('</');
    if (closing) return `</${tag}>`;
    if (tag === 'br') return '<br>';
    if (tag === 'span') {
      const isToken = /class\s*=\s*["']?play-token/i.test(attrs);
      const name = /data-name\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] || /data-name\s*=\s*'([^']*)'/i.exec(attrs)?.[1] || '';
      if (isToken && name) return `<span class="play-token" contenteditable="false" data-name="${escapeHtml(decodeEntities(name))}">`;
      return '<span>';
    }
    return `<${tag}>`;
  });
  return out.trim();
}

// Plain text for the model and the list: one line per block, numbered items
// as "N. ...", bullets as "- ...", headers as "# ...", tokens as @[Name].
export function rulesHtmlToText(html) {
  const source = sanitizeRulesHtml(html);
  const lines = [];
  let counter = 0;
  let inOl = false;
  const inline = (fragment) => decodeEntities(
    fragment
      .replace(/<span class="play-token"[^>]*data-name="([^"]*)"[^>]*>[\s\S]*?<\/span>/gi, (_, name) => `@[${decodeEntities(name)}]`)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s+/g, ' ').trim();
  const blockRe = /<(h3|p|li|div)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(ol|ul)(?:\s[^>]*)?>|<\/(ol|ul)>/gi;
  let lastIndex = 0;
  let match;
  const pushLoose = (text) => { const value = inline(text); if (value) lines.push(value); };
  while ((match = blockRe.exec(source))) {
    if (match.index > lastIndex) pushLoose(source.slice(lastIndex, match.index));
    lastIndex = blockRe.lastIndex;
    if (match[3]) { inOl = match[3].toLowerCase() === 'ol'; if (inOl) counter = 0; continue; }
    if (match[4]) { inOl = false; continue; }
    const tag = match[1].toLowerCase();
    const text = inline(match[2]);
    if (!text) continue;
    if (tag === 'h3') lines.push(`# ${text}`);
    else if (tag === 'li') { if (inOl) { counter += 1; lines.push(`${counter}. ${text}`); } else lines.push(`- ${text}`); }
    else lines.push(text);
  }
  if (lastIndex < source.length) pushLoose(source.slice(lastIndex));
  return lines.join('\n');
}

// The steps a run walks: list items when the block has any, otherwise every
// plain line. Headers and paragraphs around a list are context, not steps.
export function rulesHtmlToSteps(html) {
  const text = rulesHtmlToText(html);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const items = lines.filter((line) => /^(\d+\.|-)\s/.test(line));
  const chosen = items.length ? items : lines.filter((line) => !line.startsWith('# '));
  return chosen.map((line) => line.replace(/^(\d+\.|-)\s+/, '').replace(/@\[([^\]]+)\]/g, '$1')).filter(Boolean);
}

export function rulesListToHtml(rules) {
  const items = (Array.isArray(rules) ? rules : []).map((rule) => clean(rule, 400)).filter(Boolean).slice(0, MAX_RULES);
  if (!items.length) return '';
  const body = items.map((rule) => `<li>${escapeHtml(rule).replace(/@\[([^\]]+)\]/g, (_, name) => tokenHtml(decodeEntities(name)))}</li>`).join('');
  return `<ol>${body}</ol>`;
}

export function tokenNames(html) {
  const names = new Set();
  for (const match of String(html || '').matchAll(/data-name="([^"]*)"/g)) names.add(decodeEntities(match[1]));
  return [...names];
}

// ---------------------------------------------------------------------------
// Reading a thread for the model. Play-authored turns are the play's own
// instructions and never count as the user's; the marker lives in the data.

export function condenseTranscript(messages, { maxTurns = 40, maxChars = 900 } = {}) {
  const visible = (Array.isArray(messages) ? messages : []).filter((message) => message && !message.hiddenInTranscript);
  const recent = visible.slice(-maxTurns);
  return recent.map((message) => {
    const who = message.role === 'user' ? (message.play ? `Play (${message.play.name}, step ${message.play.step})` : 'User') : 'Assistant';
    // The kickoff line on a play's first message is the user's own scoping
    // ("on the chicago list"); it is theirs to learn from, the rule is not.
    const kickoff = message.role === 'user' && message.play?.kickoff ? `User: ${String(message.play.kickoff).replace(/\s+/g, ' ').trim().slice(0, maxChars)}\n` : '';
    const text = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    const tools = [...new Set([
      ...((message.tools || []).map((tool) => (typeof tool === 'string' ? tool : tool?.name)).filter(Boolean)),
      ...((message.connectors || []).map((item) => item?.connector).filter(Boolean)),
      ...(message.computer ? [`Chrome: ${message.computer.app || 'browser'}`] : []),
    ])];
    const touches = (message.outsideTouches || []).map((touch) => `${touch.count || ''} ${touch.action || ''} in ${touch.platform || ''}`.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const extras = [tools.length ? `tools: ${tools.join(', ')}` : '', touches.length ? `outcome: ${touches.join('; ')}` : ''].filter(Boolean);
    return `${kickoff}${who}: ${text}${extras.length ? `\n  [${extras.join(' | ')}]` : ''}`;
  }).join('\n');
}

// The turns the user wrote: their own messages, plus the kickoff line that
// rides on a play's first message. A play's messages are its instructions,
// never the user's, so they are left out entirely.
export function userTurns(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user' || message.hiddenInTranscript) continue;
    if (message.play) {
      if (message.play.kickoff) out.push({ role: 'user', content: String(message.play.kickoff), ts: message.ts, kickoff: true });
      continue;
    }
    out.push(message);
  }
  return out;
}

export function findPlayPrompt({ transcript, cutIns, connectors, projectName }) {
  const tools = connectors.length ? connectors.join(', ') : 'none';
  return [
    'You are reading a working thread between a person and Supreme, their assistant. The person did a piece of work here once. Write it up as a Play: what to do the same way every time they ask for this again.',
    '',
    'How to read it. The first message says what they wanted. The turns where they cut in afterwards are corrections, and corrections are the rules. Keep what stayed the same across the thread (the filters, the order, the tone, what never to do) and drop what was specific to this one run (individual names, one-off numbers). Write in the person\'s own words and register: short, plain, imperative, the way they typed.',
    '',
    `Project: ${projectName || 'unknown'}.`,
    `Connected tools the person has on: ${tools}. When a rule depends on one of them, write it exactly as @[Tool Name] using one of those names; never invent a tool.`,
    '',
    `Turns where the person cut in (${cutIns.length}):`,
    ...cutIns.map((turn, index) => `${index + 1}. ${turn}`),
    '',
    'The thread:',
    transcript,
    '',
    'Answer with strict JSON only, no prose around it:',
    '{"name": "two to four words, how the person would refer to it", "useWhen": "completes the sentence Use it when, starting with I, e.g. I ask you to build a prospect list", "rules": ["rule", "..."]}',
    'Three to seven rules. Each rule one line, under 120 characters, no numbering inside the text.',
  ].join('\n');
}

export function revisePlayPrompt({ play, instruction, connectors }) {
  const tools = connectors.length ? connectors.join(', ') : 'none';
  return [
    'You maintain a Play: a name, a "use it when" line and a short list of rules the person wrote in their own words. Apply the change they ask for and nothing else. Keep their register: short, plain, imperative.',
    '',
    `Connected tools: ${tools}. A rule that depends on one writes it as @[Tool Name] using one of those names.`,
    '',
    `Current play:\nName: ${play.name}\nUse it when: ${play.useWhen}\nRules:\n${play.rulesText}`,
    '',
    `Change asked for: ${instruction}`,
    '',
    'Answer with strict JSON only: {"name": "...", "useWhen": "...", "rules": ["...", "..."]}',
  ].join('\n');
}

export function composeStepPrompt({ play, stepIndex, kickoff, transcript }) {
  const steps = play.steps;
  const current = steps[stepIndex];
  const numbered = steps.map((step, index) => `${index + 1}. ${step}${index === stepIndex ? '   <- this one' : ''}`).join('\n');
  return [
    `You are the voice of a Play called "${play.name}" while it runs. It runs by typing into the thread, one message per rule, exactly as the person would type it. Supreme answers each message and does the work; you only type the next one.`,
    '',
    `The person started it with: "${kickoff || play.useWhen || play.name}".`,
    'Rules, in order:',
    numbered,
    '',
    'The thread so far (most recent last):',
    transcript || '(nothing yet)',
    '',
    `Write the next message, for rule ${stepIndex + 1}: "${current}". One to three sentences, plain and imperative, in the person's register, carrying forward concrete numbers and names from the thread when they matter (for example "Of the 41 left, keep only..."). Never ask for permission, never approve or confirm anything on the person's behalf, never say who you are. If a needed tool has no API, say to do it by hand in Chrome.`,
    stepIndex > 0 ? `Also read the last reply and give the outcome of rule ${stepIndex} in a few words (for example "41 of 60", "done", "none found").` : '',
    `If rule ${stepIndex + 1} does not apply to what the person asked for, set skip to true.`,
    '',
    'Answer with strict JSON only: {"message": "...", "outcome": "...", "skip": false}',
  ].filter(Boolean).join('\n');
}

function jsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

export function parsePlayJson(text) {
  const parsed = jsonObject(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const rules = (Array.isArray(parsed.rules) ? parsed.rules : []).map((rule) => clean(typeof rule === 'string' ? rule : rule?.text, 400)).filter(Boolean).slice(0, MAX_RULES);
  const name = clean(parsed.name, 80);
  if (!name || !rules.length) return null;
  return { name, useWhen: clean(parsed.useWhen, 200).replace(/^use it when\s*/i, ''), rules };
}

export function parseStepJson(text) {
  const parsed = jsonObject(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const message = String(parsed.message || '').trim().slice(0, 2_000);
  return { message, outcome: clean(parsed.outcome, 60), skip: parsed.skip === true };
}

// ---------------------------------------------------------------------------
// Fixture mode (WB_PLAYS_FIXTURE=1): deterministic reads and steps so the
// smokes can drive the whole surface without a model.

export function fixturePlayFromTranscript(messages, { projectName } = {}) {
  const turns = userTurns(messages);
  const first = clean(turns[0]?.content, 80) || 'the work in this thread';
  const cutIns = turns.slice(1).map((turn) => clean(turn.content, 120)).filter(Boolean);
  const rules = cutIns.length ? cutIns : [`Do what I asked: ${first}`, 'Say plainly what could not be checked'];
  return {
    name: projectName ? `${projectName} play` : 'Thread play',
    useWhen: `I ask for ${first.toLowerCase()}`,
    rules: rules.slice(0, MAX_RULES),
  };
}

export function fixtureStep({ play, stepIndex, kickoff }) {
  const rule = play.steps[stepIndex] || '';
  return {
    message: stepIndex === 0 && kickoff ? `${kickoff}. ${rule}` : rule,
    outcome: stepIndex > 0 ? 'done' : '',
    skip: false,
  };
}
