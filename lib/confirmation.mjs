import { takeFollowups } from './followups.mjs';

const ACTION_WORDS = /\b(?:send|message|post|publish|delete|remove|archive|merge|deploy|release|install|restart|submit|purchase|pay|schedule|book|invite|connect|upload|overwrite|move|apply|execute|proceed|continue|save|draft|update|create|replace|attach|share|reply|sign|cancel|order|start|switch)\b/i;
const EXPLICIT_APPROVAL = /\b(?:confirm|confirmation|approve|approval|permission|authorize|authorization)\b/i;
const DIRECT_ASK = /\b(?:shall I|should I|may I|can I|would you like me to|do you want me to|want me to|ready for me to)\b/i;
// Imperative asks with no question mark: "Confirm and I'll…", "Say the word…",
// "Give me the go-ahead…", "I need your confirmation before…".
const IMPERATIVE_CONFIRM = /\b(?:confirm|approve|say the word|give (?:me )?the go[- ]ahead|let me know,? and i[’']ll|(?:i need|waiting on) your (?:confirmation|approval|go[- ]ahead))\b/i;
// "Let me confirm the date" is the model talking about its own next step, not
// an ask — never turn it into a prompt.
const SELF_CONFIRM = /\b(?:let me|i[’']ll|i will|i[’']m|i am)\s+(?:quickly\s+|just\s+)?(?:confirm|approve)/i;
// "Tell me when you're in", "let me know when it loads" — the user must do
// something and report back.
const TELL_WHEN = /\b(?:tell me|let me know)\s+when\b/i;
// The model names the exact reply it wants, quoted or backticked (optionally
// bold): "Reply `YES` and I'll…", "Confirm `yes, use Apollo`", tell me “ready”.
// The lookbehind keeps verbs inside inline code ("`Await reply`") from
// starting a match, and the first token character must be substantive.
const REPLY_TOKEN = /(?<![`\w])(?:reply|respond(?:\s+with)?|say|type|answer|tell\s+me|confirm)\s*(?:with\s+)?[*_]{0,2}[`'"“‘]([^\s`'"“‘”’.,;:!?][^`'"”’\n]{0,59})[`'"”’]/gi;
// Unquoted all-caps variant, plain or bold: "Reply YES and I'll…",
// "Reply **YES** to approve…". The verb usually opens the sentence, so it
// matches in either case; the token itself must be capitals.
const REPLY_TOKEN_CAPS = /\b(?:[Rr]eply|[Rr]espond(?:\s+with)?|[Ss]ay|[Tt]ype|[Aa]nswer)\s+(?:with\s+)?[*_]{0,2}([A-Z][A-Z0-9/-]{1,15})[*_]{0,2}(?=[\s.,;:!?]|$)/g;
// "Reply YES to delete it, or NO to keep it": the button must send the
// go-ahead, never the way out.
const NEGATIVE_TOKEN = /^(?:no|nope|cancel|stop|skip|abort|hold|wait|later)$/i;
// A closing question that is the action itself: "Send this?", "Post it?",
// "Go ahead?". The first real @Supreme draft (2026-09-21) ended "Send
// this?" and got no Confirm row, because nothing above matched a question
// with no approval word in it.
const CLOSING_ACTION_QUESTION = /^(?:send|post|publish|reply|submit|share|ship|proceed|go ahead|deliver|forward|schedule|book|email|message|dm|ok(?:ay)? to send|good to send|ready to send)\b[^?]{0,60}\?$/i;

// Drafted copy the model is SHOWING the user (emails, messages) arrives as
// blockquotes; a question inside a draft is the draft's voice, not an ask to
// the user (a Confirm card once grew from "open to a quick call?" inside an
// email body). Quoted lines never feed detection.
function withoutQuotedDrafts(value) {
  return String(value || '').split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
}

function plainText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function finalQuestion(value) {
  const tail = plainText(value).slice(-1_000);
  const end = tail.lastIndexOf('?');
  if (end < 0) return '';
  const prior = tail.slice(0, end);
  const start = Math.max(prior.lastIndexOf('\n'), prior.lastIndexOf('.'), prior.lastIndexOf('!'));
  const question = tail.slice(start + 1, end + 1)
    .replace(/^\s*(?:confirm|confirmation)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  return question ? question[0].toUpperCase() + question.slice(1) : '';
}

function closingSentences(text, count = 1) {
  const tail = String(text || '').slice(-400).trim();
  const parts = tail.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  return parts.slice(-count);
}

function finalSentence(text) {
  return closingSentences(text, 1)[0] || '';
}

// The button says Confirm and nothing more. It used to guess a verb from the
// question ("Confirm and send" whenever "send" appeared nearby), and because
// the click sends the label back as the reply, a question about uploading a
// draft could answer itself with "Confirm and send." The question above the
// button already says what is being confirmed.
function confirmLabel() {
  return 'Confirm';
}

function questionCase(value, fallback) {
  const shown = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return shown ? shown[0].toUpperCase() + shown.slice(1) : fallback;
}

function requestShape(question, label, response) {
  return {
    question,
    confirmLabel: label,
    confirmResponse: response,
    declineLabel: 'Not yet',
    declineResponse: 'Not yet.',
  };
}

// A reply that ends by asking the user to act must always surface an
// actionable prompt. Detection favors the message tail so quoted emails and
// long recaps earlier in the reply cannot hide the ask — or fake one.
export function confirmationRequest(value) {
  // Codex's suggested next asks are buttons, never a question to the user.
  const raw = withoutQuotedDrafts(takeFollowups(value).content);
  const text = plainText(raw);
  if (!text) return null;

  // 1) Exact reply token. Scan the raw tail so backticks/quotes survive; the
  // last instruction wins ("reply `confirm`", "reply `go 4/4/3`", "say YES"),
  // except that a token which only ever means "don't" never beats one that
  // means "go" ("reply YES to delete it, or reply NO to keep it").
  const tokens = [];
  for (const re of [new RegExp(REPLY_TOKEN.source, 'gi'), new RegExp(REPLY_TOKEN_CAPS.source, 'g')]) {
    let match;
    while ((match = re.exec(raw.slice(-500)))) tokens.push(match[1].trim().replace(/[.,;:!?]+$/, ''));
  }
  const affirmative = tokens.filter((candidate) => !NEGATIVE_TOKEN.test(candidate));
  const token = (affirmative.length ? affirmative : tokens).at(-1) || null;
  if (token && token.length <= 40) {
    const display = token.length > 24 ? `${token.slice(0, 22)}…` : token;
    return requestShape(
      questionCase(finalSentence(text), `Reply “${display}” to proceed?`),
      `Reply “${display}”`,
      token,
    );
  }

  const context = text.slice(-800);
  const sentence = finalSentence(text);

  // 2) A closing question that asks for approval. Explicit approval language
  // in the question itself is enough on its own ("Confirm?"); a softer
  // question needs approval language nearby plus a concrete action.
  const question = finalQuestion(text);
  if (question) {
    // "What email should I use?" includes "should I", but Confirm supplies
    // no email. A request for information is never approval to do the work,
    // even when the surrounding recap mentions sending or permission.
    if (/^(?:(?:and|also)\s+)?(?:what|which|who|whose|where|when|how)\b/i.test(question)) return null;
    if (/^(?:do you mean|did you mean|are you asking for)\b.*\bor\b/i.test(question)) return null;
    const asksForApproval = EXPLICIT_APPROVAL.test(question)
      || DIRECT_ASK.test(question)
      || (EXPLICIT_APPROVAL.test(context) && ACTION_WORDS.test(`${question} ${context.slice(-320)}`));
    if (asksForApproval) {
      const label = confirmLabel(`${question} ${sentence}`);
      return requestShape(question, label, `${label}.`);
    }
    if (CLOSING_ACTION_QUESTION.test(question)) {
      const label = confirmLabel(question);
      return requestShape(question, label, `${label}.`);
    }
  }

  // 3) "Do the thing, then tell me when it's done" — the user acts and
  // reports back.
  if (TELL_WHEN.test(sentence)) {
    return requestShape(questionCase(sentence, 'Done?'), 'Done — continue', 'Done — continue.');
  }

  // 4) Imperative ask with no question mark: "Confirm and I'll update the
  // draft…", "Say the word and I'll turn it on." Models often close on a
  // reassurance after the ask ("Approve and I'll create both. Nothing
  // sends."), so the ask may sit one sentence before the end.
  const ask = closingSentences(text, 2).reverse()
    .find((candidate) => IMPERATIVE_CONFIRM.test(candidate) && !SELF_CONFIRM.test(candidate));
  if (ask) {
    const label = confirmLabel(`${ask} ${context.slice(-320)}`);
    return requestShape(questionCase(ask, 'Confirm to continue?'), label, `${label}.`);
  }
  return null;
}

export function tabConfirmation(tab) {
  if (!tab || tab.activeRun || tab.status === 'running') return null;
  const visible = (tab.messages || []).filter((message) => !message.hiddenInTranscript);
  const last = visible[visible.length - 1];
  if (!last || last.role !== 'assistant' || last.ok === false || last.stopped) return null;
  // Email handoffs have a structured target picker. Other stamps are
  // derived, and old false positives must not keep the inbox waiting.
  return last.confirmation?.emailHandoff ? last.confirmation : confirmationRequest(last.content);
}

// A confirmation raised by a turn someone else ran is theirs to answer (their
// Mac, their Chrome, their connectors), so it never counts as waiting on this
// user. Same team sets the viewer once the signed-in user is known; unset
// means count everything, which is right for a Mac with no team attached.
let viewerId = null;
export function setConfirmationViewer(id) { viewerId = id ? String(id) : null; }

function confirmationIsMine(tab) {
  if (!viewerId) return true;
  const visible = (tab.messages || []).filter((message) => !message.hiddenInTranscript);
  const ranBy = visible[visible.length - 1]?.ranBy;
  return !ranBy?.id || ranBy.id === viewerId;
}

export function taskConfirmationCount(task) {
  return (task?.tabs || []).reduce((count, tab) => count + (tabConfirmation(tab) && confirmationIsMine(tab) ? 1 : 0), 0);
}
