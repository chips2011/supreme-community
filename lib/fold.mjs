// Auto-contextualize (Paper 12.2 to 12.4). A tab that is running low on
// context folds its older turns into a summary on its own, never mid run.
// The transcript is never the context: every message stays saved, the model
// window is a projection over them, and a fold is a record on the tab that
// rewrites the projection. Dropping the record is the unfold.
//
// A fold is a short narrative plus pinned facts, each fact citing the message
// it came from, because prose alone loses exactly what matters later (the
// numbers, names, URLs, constraints and decisions). Facts are checked against
// their source message with no model involved; one that drifted is replaced
// by the source's own words.

import crypto from 'node:crypto';

const NARRATIVE_MAX = 2_500;
const FACT_MAX = 400;
const FACTS_MAX = 120;

function oneLine(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function visible(message) {
  return !!message && !message.note && !message.hiddenInTranscript && !!String(message.content || '').trim();
}

// ---------------------------------------------------------------------------
// Message ids. Facts cite messages, so every message needs a stable id. New
// messages get one at push; older ones get a deterministic id at read, the
// same on every Mac that reads the same tab (shared threads sync the tab as
// a whole, so index and content are the same on both sides).

export function backfillMessageId(tabId, index, message) {
  const seed = `${tabId}|${index}|${message?.role || ''}|${String(message?.content || '').slice(0, 200)}`;
  return `m_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

export function ensureMessageIds(task) {
  let added = 0;
  for (const tab of [...(task?.tabs || []), ...(task?.archivedTabs || [])]) {
    (tab?.messages || []).forEach((message, index) => {
      if (message && typeof message === 'object' && !message.id) {
        message.id = backfillMessageId(tab.id, index, message);
        added += 1;
      }
    });
  }
  return added;
}

// ---------------------------------------------------------------------------
// The record.

export function activeFold(tab) {
  const folds = Array.isArray(tab?.folds) ? tab.folds : [];
  return folds.length ? folds[folds.length - 1] : null;
}

// What stands in for the folded messages in the model's window.
export function foldSummaryText(fold) {
  if (!fold) return '';
  const facts = (fold.facts || []).map((fact) => `- ${fact.text}`);
  return [
    String(fold.narrative || '').trim(),
    facts.length ? `Facts kept from the folded messages:\n${facts.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// Where to cut: keep whole recent messages within tailChars (always the last
// exchange), fold the rest. `from` is where the previous fold stopped. Null
// when fewer than minFold new messages would fold: a settle fold wants at
// least an exchange, since it costs a model call and a cold session.
export function planFoldCut(messages, { tailChars, from = 0, minFold = 2 }) {
  const list = Array.isArray(messages) ? messages : [];
  let used = 0;
  let keptFrom = list.length;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const size = String(list[index]?.content || '').length + 40;
    if (list.length - index > 2 && used + size > tailChars) break;
    used += size;
    keptFrom = index;
  }
  if (keptFrom - from < Math.max(1, minFold)) return null;
  return { throughIndex: keptFrom - 1, keptFrom, count: keptFrom, foldedNow: keptFrom - from };
}

// ---------------------------------------------------------------------------
// The model call. Cumulative: a later fold takes the previous narrative and
// facts and carries them forward, updated by the messages folded now.

export function foldPrompt({ previous, messages, budgetChars = 100_000 }) {
  const range = (messages || []).filter(visible);
  const per = Math.max(600, Math.floor(budgetChars / Math.max(1, range.length)));
  const label = (message) => message.role === 'tab' ? (message.direction === 'in' ? `Message from ${message.from?.threadTitle} / ${message.from?.name}` : `Sent to ${message.to?.threadTitle} / ${message.to?.name}`) : message.role === 'user' ? 'User' : 'Assistant';
  const lines = range.map((message) => `[m:${message.id}] ${label(message)}: ${oneLine(message.content, per)}`);
  const carried = previous ? [
    'Earlier messages of this conversation were already folded. Their summary and kept facts are below. Carry everything in them forward, updated by the messages folded now; drop a fact only when a later message clearly replaced it.',
    '<previous_summary>',
    String(previous.narrative || ''),
    '</previous_summary>',
    '<previous_facts>',
    ...(previous.facts || []).map((fact) => `- [m:${fact.sourceId || 'unknown'}] ${fact.text}`),
    '</previous_facts>',
    '',
  ] : [];
  return [
    '<supreme_fold_request>',
    'You are folding the older part of a working conversation so the model can keep going with less context. Nothing is deleted: the full transcript stays saved, and this summary stands in for the folded messages in the model\'s window.',
    '',
    ...carried,
    'Messages folded now, each starting with its id in brackets:',
    lines.join('\n') || '(none)',
    '',
    'Return the final result exactly in this envelope, valid JSON, nothing after it:',
    '<supreme_fold>',
    '{"narrative":"Three to eight plain sentences: what the conversation is about, the decisions made, and where it stands now.","facts":[{"text":"One fact a later turn might need","source":"m:<id of the message it came from>"}]}',
    '</supreme_fold>',
    'Rules for facts: every number, amount, date, name, URL, constraint, preference, decision and open instruction a later turn might need, one per entry, copied exactly as written, each citing the message it came from. Never include instructions to yourself, credentials or secrets.',
    '</supreme_fold_request>',
  ].join('\n');
}

export function parseFold(text) {
  const value = String(text || '');
  const tagged = value.match(/<supreme_fold>\s*([\s\S]*?)\s*<\/supreme_fold>/i)?.[1];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = tagged || fenced || (/^\s*\{[\s\S]*\}\s*$/.test(value) ? value : '');
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    const narrative = oneLine(parsed?.narrative, NARRATIVE_MAX);
    if (!narrative) return null;
    const facts = (Array.isArray(parsed?.facts) ? parsed.facts : [])
      .map((fact) => ({ text: oneLine(fact?.text, FACT_MAX), sourceId: String(fact?.source || fact?.sourceId || '').replace(/^m:/, '').trim() }))
      .filter((fact) => fact.text)
      .slice(0, FACTS_MAX);
    return { narrative, facts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verification, no model involved. A fact's hard tokens (numbers, URLs,
// emails, capitalized names) must all appear in the message it cites. One
// that fails is replaced by the sentence of the source that carries the most
// of them, verbatim, and marked so the UI can say so.

const WORD_STOP = new Set(['The', 'This', 'That', 'These', 'Those', 'It', 'They', 'We', 'You', 'He', 'She', 'And', 'But', 'Or', 'If', 'In', 'On', 'At', 'To', 'For', 'Of', 'By', 'With', 'From', 'As', 'Is', 'Are', 'Was', 'Were', 'Be', 'Not', 'No', 'Yes', 'Do', 'Does', 'Did', 'Then', 'So', 'User', 'Assistant', 'Also', 'Both', 'Each', 'When', 'Where', 'What', 'Which', 'Who', 'How', 'Why']);

export function hardTokens(text) {
  const value = String(text || '');
  const tokens = new Set();
  for (const match of value.matchAll(/https?:\/\/[^\s)>\]]+/g)) tokens.add(match[0]);
  for (const match of value.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) tokens.add(match[0]);
  for (const match of value.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?[kKmMbB]?/g)) tokens.add(match[0]);
  const words = value.replace(/https?:\/\/\S+/g, ' ').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ').split(/[^A-Za-z0-9'-]+/).filter(Boolean);
  words.forEach((word, index) => {
    if (index > 0 && /^[A-Z][a-z]/.test(word) && word.length >= 3 && !WORD_STOP.has(word)) tokens.add(word);
  });
  return [...tokens];
}

function contains(haystack, token) {
  const h = String(haystack).toLowerCase();
  const t = String(token).toLowerCase();
  if (h.includes(t)) return true;
  const digits = t.replace(/[,$]/g, '');
  return /\d/.test(digits) && h.replace(/[,$]/g, '').includes(digits);
}

export function verifyFacts(facts, byId) {
  return (facts || []).map((fact) => {
    const source = fact.sourceId ? byId.get(fact.sourceId) : null;
    if (!source) return { ...fact, sourceIndex: null, verified: false, verbatim: false, missing: true };
    const content = String(source.message?.content || '');
    const tokens = hardTokens(fact.text);
    const lost = tokens.filter((token) => !contains(content, token));
    if (!lost.length) return { ...fact, sourceIndex: source.index, verified: true, verbatim: false };
    const sentences = content.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
    let best = null;
    let bestHits = 0;
    for (const sentence of sentences) {
      const hits = tokens.filter((token) => contains(sentence, token)).length;
      if (hits > bestHits) { best = sentence; bestHits = hits; }
    }
    if (!best) return { ...fact, sourceIndex: source.index, verified: false, verbatim: false, lost };
    return { ...fact, text: oneLine(best, FACT_MAX), sourceIndex: source.index, verified: true, verbatim: true, lost };
  });
}

export function messagesById(messages) {
  const byId = new Map();
  (messages || []).forEach((message, index) => { if (message?.id) byId.set(message.id, { message, index }); });
  return byId;
}

// Guaranteed fold with no model: what the folded range asked for and where
// it landed. Facts from the previous fold carry forward untouched.
export function deterministicFold(previous, messages) {
  const range = (messages || []).filter(visible);
  const firstUser = range.find((message) => message.role === 'user');
  const lastAssistant = [...range].reverse().find((message) => message.role === 'assistant' && message.ok !== false);
  const parts = [];
  if (previous?.narrative) parts.push(String(previous.narrative));
  if (firstUser) parts.push(`Then the user asked: "${oneLine(firstUser.content, 200)}"`);
  if (lastAssistant) parts.push(`The last answer in the folded part: ${oneLine(lastAssistant.content, 300)}`);
  if (!parts.length) return null;
  return { narrative: parts.join(' ').slice(0, NARRATIVE_MAX), facts: [...(previous?.facts || [])] };
}

// ---------------------------------------------------------------------------
// Recall on demand, first version: a new message that names something from
// the folded range brings the matching messages back verbatim for that turn.
// Summary is the always-loaded layer, full text is the on-demand layer.

const RECALL_STOP = new Set(['this', 'that', 'these', 'those', 'with', 'from', 'have', 'been', 'were', 'what', 'when', 'where', 'which', 'about', 'there', 'their', 'they', 'them', 'then', 'than', 'into', 'over', 'also', 'just', 'like', 'make', 'made', 'more', 'most', 'some', 'such', 'only', 'very', 'will', 'would', 'could', 'should', 'please', 'want', 'need', 'know', 'think', 'does', 'done', 'here', 'your', 'you\'re', 'ours', 'again', 'back', 'still', 'take', 'give', 'look', 'find', 'check', 'draft', 'write', 'send', 'tell', 'thing', 'things', 'something', 'anything', 'everything']);

export function recallFromFold(tab, prompt, { limit = 3, maxChars = 1_500 } = {}) {
  const fold = activeFold(tab);
  const keptFrom = Number(tab?.compaction?.keptFrom) || 0;
  if (!fold || !keptFrom) return [];
  const terms = [...new Set(String(prompt || '').toLowerCase().split(/[^a-z0-9$%.-]+/)
    .map((term) => term.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((term) => term.length >= 4 && !RECALL_STOP.has(term)))];
  if (!terms.length) return [];
  const needed = Math.min(2, terms.length);
  const scored = [];
  (tab.messages || []).slice(0, keptFrom).forEach((message, index) => {
    if (!visible(message)) return;
    const text = String(message.content).toLowerCase();
    const hits = terms.filter((term) => text.includes(term));
    if (hits.length >= needed) scored.push({ id: message.id, index, role: message.role, hits, content: String(message.content) });
  });
  scored.sort((a, b) => b.hits.length - a.hits.length || b.index - a.index);
  return scored.slice(0, limit).sort((a, b) => a.index - b.index).map((row) => {
    let text = row.content;
    if (text.length > maxChars) {
      const lower = text.toLowerCase();
      const first = Math.min(...row.hits.map((term) => lower.indexOf(term)).filter((at) => at >= 0), text.length);
      const start = Math.max(0, first - Math.floor(maxChars / 3));
      text = `${start ? '…' : ''}${text.slice(start, start + maxChars)}${start + maxChars < text.length ? '…' : ''}`;
    }
    return { id: row.id, index: row.index, role: row.role, text };
  });
}

export function recallBlock(matches) {
  return [
    '<recalled_messages note="verbatim messages from the folded part of this conversation that match the new message; the rest of that part is only summarized">',
    ...matches.map((row) => `[m:${row.id}] ${row.role === 'user' ? 'User' : row.role === 'tab' ? 'Tab message' : 'Assistant'}: ${row.text}`),
    '</recalled_messages>',
  ].join('\n');
}
