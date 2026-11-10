import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './store.mjs';

export const DEFAULT_EMAIL_DOMAIN = 'in.example.com';
const HANDOFFS_FILE = () => path.join(DATA_DIR, 'email-handoffs.json');
const HANDOFFS_MAX = 200;

export function parseAddress(value) {
  const text = String(value || '').trim();
  const angled = text.match(/^(.*?)<([^<>@\s]+@[^<>\s]+)>\s*$/);
  if (angled) return { name: angled[1].replace(/^["'\s]+|["'\s]+$/g, ''), address: angled[2].toLowerCase() };
  const bare = text.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return { name: '', address: bare ? bare[0].toLowerCase() : '' };
}

// The part before the @ of the first address it was sent to.
export function prefixOf(to) {
  const list = Array.isArray(to) ? to : String(to || '').split(',');
  for (const one of list) {
    const { address } = parseAddress(one);
    if (address) return address.split('@')[0].split('+')[0].toLowerCase();
  }
  return '';
}

export function isAllowed(from, allow) {
  const { address } = parseAddress(from);
  if (!address) return false;
  return (allow || []).map((row) => String(row || '').trim().toLowerCase()).filter(Boolean).includes(address);
}

// What someone typed in a reply, less the quoted thread under it.
export function replyText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .{3,200}wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*(?:Original|Forwarded) Message\s*-{2,}/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

const YES = /^(?:yes|y|yep|yeah|yup|ok|okay|sure|go|go ahead|confirm|confirmed|do it|send it there|hand it over)\b[\s.!]*$/i;
export function isYes(text) {
  const first = replyText(text).split('\n').map((line) => line.trim()).find(Boolean) || '';
  return YES.test(first);
}

// The orchestrator's suggestion rides its answer as a last line,
// "Hand to: Workstream / Tab" or "Hand to: new tab <Name>", which comes off
// before the answer is shown.
const HAND_TO = /^[ \t]*[*_]*Hand to:?[*_]*[ \t]*(.+?)[ \t]*$/im;
export function takeSuggestion(content) {
  const text = String(content || '');
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(HAND_TO);
    if (!match) { if (lines[index].trim()) break; continue; }
    const said = match[1].replace(/^[`"'“]+|[`"'”.]+$/g, '').trim();
    const rest = lines.slice(0, index).join('\n').trim();
    const fresh = said.match(/^new tab\s+[`"'“]?(.+?)[`"'”]?(?:\s+in\s+(.+))?$/i);
    if (fresh) return { content: rest, target: { newTab: fresh[1].trim(), workstream: (fresh[2] || '').trim() } };
    return { content: rest, target: { name: said } };
  }
  return { content: text, target: null };
}

export function supremeLink(threadId, tabId) {
  return `supreme://open?thread=${encodeURIComponent(threadId)}&tab=${encodeURIComponent(tabId)}`;
}

function plainLine(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// One or two sentences of what a tab said, for the closing email.
export function summaryOf(answer, { max = 320 } = {}) {
  const firstPart = String(answer || '').split(/\n\s*\n|```/)[0];
  const sentences = plainLine(firstPart).split(/(?<=[.!?])\s+/).filter(Boolean);
  let out = sentences.slice(0, 2).join(' ');
  if (out.length > max) out = `${out.slice(0, max - 3).trimEnd()}...`;
  return out;
}

const subjectRe = (subject) => (/^re:/i.test(String(subject || '').trim()) ? String(subject).trim() : `Re: ${String(subject || '').trim() || 'Your email'}`);

// Board 32.5c: the suggestion, and how to answer it by email.
export function suggestEmail({ said, label }) {
  const first = plainLine(said) || `I'd hand this to ${label}.`;
  return `${first}\n\nReply yes and it goes to ${label}, or reply with another tab's name. I'll email you again when it's done.`;
}

// Boards 32.1 and 32.2a: who took it, what it did, the way back in.
export function closingEmail({ label, answer, waiting, link }) {
  const summary = summaryOf(answer);
  if (waiting) {
    return {
      text: `${label} took this.\n\n${summary ? `${summary} ` : ''}It's waiting on you to send.\n\nOpen in Supreme to send: ${link}`,
      html: `<p>${esc(label)} took this.</p><p>${summary ? `${esc(summary)} ` : ''}It's waiting on you to send.</p><p><a href="${esc(link)}">Open in Supreme to send</a></p>`,
    };
  }
  return {
    text: `${label} took this.\n\n${summary || 'Done.'}\n\nOpen in Supreme: ${link}`,
    html: `<p>${esc(label)} took this.</p><p>${esc(summary || 'Done.')}</p><p><a href="${esc(link)}">Open in Supreme</a></p>`,
  };
}

function sentAtLabel(value) {
  const at = new Date(String(value || ''));
  if (!Number.isFinite(at.getTime())) return '';
  return at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function whoReplied(reply) {
  const from = reply?.from || {};
  const name = String(from.name || from.email || 'Someone').trim();
  const firm = String(reply?.firm?.name || '').trim();
  return { name, firm, email: String(from.email || '').trim() };
}

// Board 33.3: the orchestrator's one line.
export function dealLine({ reply = {}, deal = {}, tabName = '' } = {}) {
  const who = whoReplied(reply);
  const what = String(reply.subject || deal.name || 'the deal').replace(/^\s*(?:re|fwd?):\s*/i, '').trim();
  return `${who.name}${who.firm ? ` at ${who.firm}` : ''} replied on ${what}.${tabName ? ` ${tabName} drafts the answer.` : ''}`;
}

export function dealBrief({ reply = {}, deal = {}, dryRun = false, instructions = '' } = {}) {
  const who = whoReplied(reply);
  const role = ['lender', 'broker'].includes(reply.sender_role) ? reply.sender_role : '';
  const tag = [who.firm, role].filter(Boolean).join(', ');
  const when = sentAtLabel(reply.sent_at);
  const cc = (reply.cc || []).filter(Boolean);
  const files = (deal.room_files || []).map((file) => file?.name).filter(Boolean);
  const numbers = Object.entries(deal.numbers || {}).filter(([, value]) => String(value || '').trim());
  const broker = deal.broker && deal.broker.email ? deal.broker : null;
  const lines = [
    `${who.name}${tag ? ` (${tag})` : ''} replied on "${reply.subject || deal.name || ''}" in ${reply.mailbox}${when ? `, ${when}` : ''}:`,
    '',
    String(reply.text || '').trim(),
    '',
    `Gmail thread ${reply.gmail_thread_id} in ${reply.mailbox}. From ${who.email}${(reply.to || []).length ? `, to ${reply.to.join(', ')}` : ''}${cc.length ? `, cc ${cc.join(', ')}` : ''}.`,
    '',
    `The deal: ${deal.name || reply.subject || ''}`,
    deal.room_url ? `Room: ${deal.room_url}` : '',
    files.length ? `In the room: ${files.join(', ')}` : 'In the room: nothing Vime knows of.',
    ...numbers.map(([label, value]) => `${label}: ${value}`),
    broker ? `Broker: ${broker.name || broker.email}${broker.firm ? ` (${broker.firm})` : ''} <${broker.email}>${broker.gmail_thread_id ? `, their thread ${broker.gmail_thread_id}` : ', no thread with them on this deal yet'}` : 'Broker: none on file.',
    '',
    instructions ? `Your standing instruction for deal replies: ${String(instructions).trim()}` : '',
    '',
    dryRun
      ? 'This is a dry run. Write each draft here only, and do not create, change or send anything in Gmail.'
      : `Save the reply as a Gmail draft inside that thread, from ${reply.mailbox}, to ${who.email} with the same cc as the thread. Answer from what is in the room and the numbers above, and point to the room rather than attaching files.${broker ? ' If they asked for something the room does not have, also save a draft to the broker asking for exactly that, in the broker\'s thread when there is one.' : ''} Send nothing.`,
    'Then answer here with one line, each draft numbered with who it goes to, and end with "Send these?"',
  ];
  return lines.filter((line, index, all) => line !== '' || (all[index - 1] !== '' && index > 0)).join('\n').trim();
}

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// The handoffs: one per forwarded email, from suggesting to done.

function readAll() {
  try { return JSON.parse(fs.readFileSync(HANDOFFS_FILE(), 'utf8')) || []; } catch { return []; }
}
function writeAll(rows) {
  try {
    fs.mkdirSync(path.dirname(HANDOFFS_FILE()), { recursive: true });
    fs.writeFileSync(HANDOFFS_FILE(), JSON.stringify(rows.slice(-HANDOFFS_MAX), null, 2));
  } catch (err) { console.error('[email] could not save handoffs:', err.message); }
}
export function listHandoffs() { return readAll(); }
export function getHandoff(id) { return readAll().find((row) => row.id === id) || null; }
export function saveHandoff(row) {
  const rows = readAll();
  const at = rows.findIndex((candidate) => candidate.id === row.id);
  if (at >= 0) rows[at] = row; else rows.push(row);
  writeAll(rows);
  return row;
}
export function newHandoff(fields) {
  return saveHandoff({ id: randomUUID(), status: 'suggesting', createdAt: new Date().toISOString(), sent: [], ...fields });
}
// A reply belongs to the handoff whose forward, or one of whose replies, it
// answers.
export function handoffForReply({ inReplyTo, references }) {
  const ids = new Set([inReplyTo, ...(Array.isArray(references) ? references : String(references || '').split(/\s+/))].map((value) => String(value || '').trim()).filter(Boolean));
  if (!ids.size) return null;
  return [...readAll()].reverse().find((row) => ids.has(row.email?.messageId) || (row.sent || []).some((id) => ids.has(id))) || null;
}
export function seenMessage(messageId) {
  if (!messageId) return false;
  return readAll().some((row) => row.email?.messageId === messageId || (row.replies || []).includes(messageId));
}

// ---------------------------------------------------------------------------
// The sender. Resend in the product, a file on disk in the smokes
// (WB_EMAIL_OUTBOX). The key is a setting, never in the code.

export function makeSender({ apiKey, cloud = null, outbox = process.env.WB_EMAIL_OUTBOX || '', fetchImpl = fetch } = {}) {
  return async function sendEmail({ from, to, subject, text, html, inReplyTo, references }) {
    const messageId = `<${randomUUID()}@${String(from).split('@')[1]?.replace(/>.*$/, '') || DEFAULT_EMAIL_DOMAIN}>`;
    const headers = { 'Message-ID': messageId };
    if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
    const refs = [...new Set([...(Array.isArray(references) ? references : String(references || '').split(/\s+/)), inReplyTo].filter(Boolean))];
    if (refs.length) headers.References = refs.join(' ');
    const mail = { from, to: [to], subject: subjectRe(subject), text, ...(html ? { html } : {}), headers };
    if (outbox) {
      fs.appendFileSync(outbox, `${JSON.stringify({ ...mail, messageId, at: new Date().toISOString() })}\n`);
      return { ok: true, messageId };
    }
    if (!apiKey && cloud) {
      // Supreme's cloud sends it (resend-inbound, send), signed in as this person.
      const response = await fetchImpl(`${cloud.url}/functions/v1/resend-inbound`, {
        method: 'POST',
        headers: { apikey: cloud.anon || '', Authorization: `Bearer ${cloud.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', mail }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Supreme could not send the email (${response.status}): ${payload.error || ''}`.trim());
      return { ok: true, messageId, id: payload.id || null };
    }
    if (!apiKey) throw new Error('Not signed in to Supreme and no Resend key in Settings, so the email was not sent.');
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(mail),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Resend refused the email (${response.status}): ${payload.message || payload.error || ''}`.trim());
    return { ok: true, messageId, id: payload.id || null };
  };
}
