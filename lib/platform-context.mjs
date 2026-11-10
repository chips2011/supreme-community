import crypto from 'node:crypto';
import { connectorKey, groupConnectors } from './connectors.mjs';

// Context is owned by the stable product surface the user works in. Access is
// deliberately described separately because a platform can move from Chrome
// to a direct API (or back) without invalidating what the user taught Supreme.
export const PLATFORM_CONTEXT_DEFINITIONS = Object.freeze([
  { key: 'linkedin', name: 'LinkedIn', mark: 'in', accessKind: 'chrome', accessLabel: 'LinkedIn via Chrome', connectorNames: [] },
  { key: 'gmail', name: 'Gmail', mark: 'M', accessKind: 'connector', accessLabel: 'Gmail connector', connectorNames: ['Gmail'] },
  { key: 'notion', name: 'Notion', mark: 'N', accessKind: 'connector', accessLabel: 'Notion connector', connectorNames: ['Notion'] },
  { key: 'slack', name: 'Slack', mark: 'S', accessKind: 'connector', accessLabel: 'Slack connector', connectorNames: ['Slack'] },
  { key: 'google-calendar', name: 'Google Calendar', mark: 'C', accessKind: 'connector', accessLabel: 'Google Calendar connector', connectorNames: ['Google Calendar'] },
  { key: 'google-drive', name: 'Google Drive', mark: 'D', accessKind: 'connector', accessLabel: 'Google Drive connector', connectorNames: ['Google Drive'] },
]);

const DEFINITION_BY_KEY = new Map(PLATFORM_CONTEXT_DEFINITIONS.map((definition) => [definition.key, definition]));

// Beyond the curated six, every connector the user has becomes a Context
// platform of its own (Paper 15.3: Context follows Connectors). Dynamic keys
// are namespaced so a connector can never collide with a curated slug, and
// the order follows the Connectors page (most used first) with LinkedIn, the
// one Chrome platform, kept first.
function connectorDefinition(group) {
  const name = String(group.name || '').trim();
  return {
    key: `connector:${group.key.replace(/\s+/g, '-')}`,
    name,
    mark: name.slice(0, 1).toUpperCase() || '?',
    accessKind: 'connector',
    accessLabel: `${name} connector`,
    connectorNames: group.names || [name],
    dynamic: true,
  };
}

function syntheticDefinition(key) {
  const slug = String(key).replace(/^connector:/, '');
  const name = slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return { ...connectorDefinition({ key: slug.replace(/-/g, ' '), name, names: [name] }), orphan: true };
}

export function platformContextDefinitions({ connectors = [], order = [] } = {}) {
  const curated = PLATFORM_CONTEXT_DEFINITIONS.map((definition) => ({ ...definition }));
  const coveredNames = new Set(curated.flatMap((definition) => definition.connectorNames.map((name) => name.toLowerCase())));
  const dynamic = groupConnectors(connectors)
    .filter((group) => group.connected && !group.names.some((name) => coveredNames.has(name.toLowerCase())))
    .map(connectorDefinition);
  const rank = new Map(order.map((key, index) => [key, index]));
  const rankOf = (definition) => {
    if (definition.accessKind === 'chrome') return -1;
    const key = definition.dynamic ? definition.key.replace(/^connector:/, '').replace(/-/g, ' ') : connectorKey(definition.connectorNames[0] || '');
    return rank.has(key) ? rank.get(key) : Number.MAX_SAFE_INTEGER;
  };
  return [...curated, ...dynamic].sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));
}
const MAX_ENTRIES = 24;
const MAX_MESSAGES = 80;

function cleanLine(value, max = 1_200) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanText(value, max = 12_000) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function cleanTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function entry(value, fallbackAt = new Date().toISOString()) {
  const text = cleanLine(typeof value === 'string' ? value : value?.text, 2_000);
  if (!text) return null;
  return {
    id: cleanLine(typeof value === 'object' ? value?.id : '', 96) || crypto.randomUUID(),
    text,
    createdAt: cleanTimestamp(typeof value === 'object' ? value?.createdAt : '') || fallbackAt,
    updatedAt: cleanTimestamp(typeof value === 'object' ? value?.updatedAt : '') || fallbackAt,
  };
}

function entries(values) {
  const now = new Date().toISOString();
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const next = entry(value, now);
    if (!next || seen.has(next.text.toLowerCase())) return [];
    seen.add(next.text.toLowerCase());
    return [next];
  }).slice(0, MAX_ENTRIES);
}

function examples(values) {
  return (Array.isArray(values) ? values : []).flatMap((value, index) => {
    const excerpt = cleanText(typeof value === 'string' ? value : value?.excerpt || value?.text, 700);
    if (!excerpt) return [];
    let url = '';
    try {
      const parsed = new URL(String(typeof value === 'object' ? value?.url || '' : ''));
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) url = parsed.toString().slice(0, 2_000);
    } catch {}
    return [{
      id: cleanLine(typeof value === 'object' ? value?.id : '', 96) || `example-${index + 1}`,
      excerpt,
      ...(url ? { url } : {}),
    }];
  }).slice(0, 50);
}

function message(value) {
  if (!value || !['user', 'assistant'].includes(value.role)) return null;
  const content = cleanText(value.content, 20_000);
  if (!content) return null;
  return {
    id: cleanLine(value.id, 96) || crypto.randomUUID(),
    role: value.role,
    content,
    at: cleanTimestamp(value.at || value.ts) || new Date().toISOString(),
    ...(value.kind === 'access' ? { kind: 'access' } : {}),
  };
}

function source(value, definition) {
  if (!value || typeof value !== 'object') return null;
  const kind = value.kind === 'history' ? 'history' : value.kind === 'manual' ? 'manual' : null;
  if (!kind) return null;
  const count = Number(value.exampleCount);
  return {
    kind,
    accessKind: kind === 'history' ? definition.accessKind : 'manual',
    label: kind === 'history' ? definition.accessLabel : 'Entered manually',
    exampleCount: kind === 'history' && Number.isFinite(count) && count >= 0 ? Math.min(Math.floor(count), 1_000_000) : null,
    examples: kind === 'history' ? examples(value.examples) : [],
    retrievedAt: cleanTimestamp(value.retrievedAt) || null,
  };
}

export function platformContextDefinition(key, definitions = PLATFORM_CONTEXT_DEFINITIONS) {
  const wanted = String(key || '').toLowerCase();
  if (!wanted) return null;
  const found = definitions.find((definition) => definition.key === wanted) || DEFINITION_BY_KEY.get(wanted) || null;
  if (found) return found;
  // A record for a connector that is not in the current scan still resolves,
  // so saved Context is never orphaned by a flaky mcp list.
  return wanted.startsWith('connector:') ? syntheticDefinition(wanted) : null;
}

export function normalizePlatformContexts(value, definitions = PLATFORM_CONTEXT_DEFINITIONS) {
  const raw = value && typeof value === 'object' ? value : {};
  const normalized = {};
  const known = new Set(definitions.map((definition) => definition.key));
  const orphans = Object.keys(raw).filter((key) => key.startsWith('connector:') && !known.has(key)).map(syntheticDefinition);
  for (const definition of [...definitions, ...orphans]) {
    const record = raw[definition.key];
    if (!record || typeof record !== 'object') continue;
    const savedEntries = entries(record.entries);
    const draftEntries = entries(record.draftEntries);
    const messages = (Array.isArray(record.messages) ? record.messages : [])
      .flatMap((candidate) => message(candidate) || [])
      .slice(-MAX_MESSAGES);
    const updatedAt = cleanTimestamp(record.updatedAt) || cleanTimestamp(record.savedAt) || new Date().toISOString();
    normalized[definition.key] = {
      key: definition.key,
      entries: savedEntries,
      draftEntries,
      messages,
      source: source(record.source, definition),
      draftSource: source(record.draftSource, definition),
      savedAt: cleanTimestamp(record.savedAt),
      updatedAt,
      suggestions: entries(record.suggestions),
    };
  }
  return normalized;
}

export function platformContextRecord(value, key, definitions = PLATFORM_CONTEXT_DEFINITIONS) {
  const definition = platformContextDefinition(key, definitions);
  if (!definition) return null;
  const normalized = normalizePlatformContexts(value, definitions);
  return normalized[definition.key] || {
    key: definition.key,
    entries: [],
    draftEntries: [],
    messages: [],
    source: null,
    draftSource: null,
    savedAt: null,
    updatedAt: null,
    suggestions: [],
  };
}

function connectorName(value) {
  return cleanLine(value?.name || value?.connector || value?.label || value, 80).toLowerCase();
}

function linkedinAccess(status) {
  if (process.env.WB_CONTEXT_CHROME_FIXTURE === '1') {
    return {
      kind: 'chrome', label: 'LinkedIn via Chrome', ready: true, provider: 'codex',
      detail: 'Uses the LinkedIn session already signed in to your active Chrome profile.',
    };
  }
  const providers = status?.providers || {};
  const chrome = status?.chrome || {};
  const extensionByProvider = chrome.providers || {};
  const candidates = ['codex', 'claude'].filter((provider) => providers[provider]?.ready && chrome.byProvider?.[provider] !== false);
  const readyProvider = candidates.find((provider) => {
    const extension = extensionByProvider[provider];
    return extension?.activeProfileInstalled && extension?.activeProfileEnabled;
  });
  if (readyProvider) {
    return {
      kind: 'chrome', label: 'LinkedIn via Chrome', ready: true, provider: readyProvider,
      detail: 'Uses the LinkedIn session already signed in to your active Chrome profile.',
    };
  }
  if (!candidates.length) {
    return {
      kind: 'chrome', label: 'LinkedIn via Chrome', ready: false, provider: null,
      detail: 'Connect ChatGPT or Claude and turn on Chrome access. You can still enter Context manually.',
    };
  }
  if (!chrome.installed) {
    return {
      kind: 'chrome', label: 'LinkedIn via Chrome', ready: false, provider: candidates[0],
      detail: 'Install the Chrome extension first. You can still enter Context manually.',
    };
  }
  return {
    kind: 'chrome', label: 'LinkedIn via Chrome', ready: false, provider: candidates[0],
    detail: `Turn on the extension in ${cleanLine(chrome.activeProfile, 80) || 'your active Chrome profile'}. You can still enter Context manually.`,
  };
}

export function platformAccess(definition, { status, connectors = [] } = {}) {
  if (!definition) return null;
  if (definition.accessKind === 'chrome') return linkedinAccess(status);
  const available = (Array.isArray(connectors) ? connectors : [])
    .filter((candidate) => !candidate || typeof candidate !== 'object' || candidate.connected !== false)
    .map((candidate) => ({ candidate, name: connectorName(candidate) }))
    .filter((candidate) => candidate.name);
  const connector = available.find((candidate) => definition.connectorNames.some((name) => name.toLowerCase() === candidate.name));
  return connector ? {
    kind: 'connector', label: definition.accessLabel, ready: true,
    provider: cleanLine(connector.candidate?.provider, 32) || null,
    detail: `Uses the connected ${definition.name} account.`,
  } : {
    kind: 'connector', label: definition.accessLabel, ready: false, provider: null,
    detail: `Connect ${definition.name} to pull examples. You can still enter Context manually.`,
  };
}

export function platformContextSnapshot(settings, { status, connectors = [], definitions = null } = {}) {
  const active = definitions || platformContextDefinitions({ connectors });
  const records = normalizePlatformContexts(settings?.platformContexts, active);
  const platforms = active.map((definition) => {
    const record = records[definition.key] || platformContextRecord(records, definition.key, active);
    return {
      key: definition.key,
      name: definition.name,
      mark: definition.mark,
      savedCount: record.entries.length,
      draftCount: record.draftEntries.length,
      hasSuggestions: record.suggestions.length > 0,
      access: platformAccess(definition, { status, connectors }),
    };
  });
  return { platforms, records };
}

export function publicPlatformContextRecord(record, definition, access) {
  return {
    key: definition.key,
    name: definition.name,
    mark: definition.mark,
    entries: record.entries,
    draftEntries: record.draftEntries,
    messages: record.messages,
    source: record.source,
    draftSource: record.draftSource,
    savedAt: record.savedAt,
    updatedAt: record.updatedAt,
    suggestions: record.suggestions,
    access,
  };
}

export function appendPlatformContextMessage(record, role, content, kind = null) {
  const next = message({ role, content, kind, at: new Date().toISOString() });
  if (!next) return record;
  record.messages = [...(record.messages || []), next].slice(-MAX_MESSAGES);
  record.updatedAt = next.at;
  return record;
}

export function replacePlatformContextDraft(record, result, definition, mode) {
  const now = new Date().toISOString();
  const priorDraftSource = record.draftSource;
  record.draftEntries = entries(result.entries);
  record.draftSource = mode === 'history' ? {
    kind: 'history',
    accessKind: definition.accessKind,
    label: definition.accessLabel,
    exampleCount: Number.isFinite(Number(result.exampleCount)) && Number(result.exampleCount) >= 0
      ? Math.min(Math.floor(Number(result.exampleCount)), 1_000_000)
      : null,
    examples: examples(result.examples),
    retrievedAt: now,
  } : priorDraftSource?.kind === 'history' ? {
    // A chat revision changes the proposed entries, not where the examples
    // came from. Preserve the history receipt until the user locks the draft.
    ...priorDraftSource,
  } : {
    kind: 'manual', accessKind: 'manual', label: 'Entered manually', exampleCount: null, examples: [], retrievedAt: null,
  };
  record.updatedAt = now;
  return record;
}

export function lockPlatformContextDraft(record) {
  if (!record.draftEntries?.length) return null;
  const now = new Date().toISOString();
  record.entries = record.draftEntries.map((candidate) => ({ ...candidate, updatedAt: now }));
  record.source = record.draftSource;
  record.draftEntries = [];
  record.draftSource = null;
  record.savedAt = now;
  record.updatedAt = now;
  // Suggestions are proposals only. Locking the explicitly reviewed draft is
  // the sole operation that changes the active entries.
  record.suggestions = [];
  return record;
}

export function parsePlatformContextResult(text) {
  const value = String(text || '');
  const tagged = value.match(/<supreme_context_result>\s*([\s\S]*?)\s*<\/supreme_context_result>/i)?.[1];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = tagged || fenced || (/^\s*\{[\s\S]*\}\s*$/.test(value) ? value : '');
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    const resultEntries = entries(parsed.entries).map((candidateEntry) => candidateEntry.text);
    const exampleCount = Number(parsed.exampleCount);
    return {
      entries: resultEntries,
      summary: cleanText(parsed.summary, 2_000),
      exampleCount: Number.isFinite(exampleCount) && exampleCount >= 0 ? Math.min(Math.floor(exampleCount), 1_000_000) : null,
      examples: examples(parsed.examples),
      needsAccess: parsed.needsAccess === true,
      accessMessage: cleanText(parsed.accessMessage, 1_000),
    };
  } catch {
    return null;
  }
}

export function platformContextRunPrompt({ definition, mode, userPrompt, record }) {
  const saved = (record.entries || []).map((candidate, index) => `${index + 1}. ${candidate.text}`).join('\n') || '(none)';
  const draft = (record.draftEntries || []).map((candidate, index) => `${index + 1}. ${candidate.text}`).join('\n') || '(none)';
  const accessRules = definition.accessKind === 'chrome' ? [
    `Use only the user's signed-in ${definition.name} session through Chrome.`,
    'Do not use a connector, web search, shell command, local file, or public web fallback.',
    'Before the first Chrome action, write one short user-facing sentence saying what you are about to inspect.',
    `If ${definition.name} is not open or the user is signed out, do not work around it. Return needsAccess=true and explain what the user needs to open or sign in to.`,
  ] : [
    `Use only the working direct ${definition.name} connector.`,
    'Do not use Chrome, web search, shell commands, local files, or a public web fallback.',
    'Before the first connector call, write one short user-facing sentence saying what you are about to inspect.',
    `If the ${definition.name} account is not connected or signed in, do not work around it. Return needsAccess=true and explain what the user needs to connect.`,
  ];
  const historyRules = mode === 'history' ? [
    ...accessRules,
    'Read real examples matching the user’s focus. Do not create, edit, react, message, publish, or otherwise change anything.',
    'Count only examples you actually inspected. Never estimate or invent the count.',
  ] : [
    'Do not use tools. Turn the user’s instruction into concise, standalone context entries.',
    'Treat this as an edit when current draft or saved entries exist. Apply the requested change without silently dropping unrelated entries.',
  ];
  return [
    `<supreme_context_request platform="${definition.key}" mode="${mode}">`,
    `Platform: ${definition.name}`,
    `Access label: ${definition.accessLabel}`,
    '',
    ...historyRules,
    '',
    'Current approved entries:',
    saved,
    '',
    'Current draft entries:',
    draft,
    '',
    'User message:',
    cleanText(userPrompt, 12_000),
    '',
    'Return the final result exactly in this envelope, with valid JSON and no text after it:',
    '<supreme_context_result>',
    '{"summary":"One short user-facing sentence about what you learned or changed.","exampleCount":null,"examples":[{"excerpt":"A short identifying excerpt from an example actually inspected","url":"https://the-specific-platform.example/item"}],"needsAccess":false,"accessMessage":"","entries":["Standalone entry one","Standalone entry two"]}',
    '</supreme_context_result>',
    'For a history pull, exampleCount must be the exact inspected count and examples should contain short excerpts from inspected items (up to 50) with their exact platform URLs when available. For manual work, leave exampleCount null and examples empty.',
    'When needsAccess is true, entries must be the unchanged current draft (or an empty array) and accessMessage must be actionable.',
    '</supreme_context_request>',
  ].join('\n');
}

export function platformContextAssistantCopy(result, mode) {
  if (result.needsAccess) return result.accessMessage || 'Open and sign in to this platform, then try again. You can keep entering Context manually.';
  if (result.summary) return result.summary;
  if (mode === 'history') {
    return result.exampleCount == null
      ? 'I reviewed the matching examples and drafted Context entries.'
      : `From those ${result.exampleCount} examples, I drafted ${result.entries.length} Context ${result.entries.length === 1 ? 'entry' : 'entries'}.`;
  }
  return 'Updated. I would save:';
}

// ---------------------------------------------------------------------------
// suggestions — entries Supreme proposes from real platform work. Proposals
// only: they never touch active entries until the user stages and locks them.

export function platformsTouchedByMessage(message, definitions = PLATFORM_CONTEXT_DEFINITIONS) {
  const keys = new Set();
  for (const activity of message?.connectors || []) {
    const name = cleanLine(activity?.connector || activity?.name, 80).toLowerCase();
    if (!name) continue;
    for (const definition of definitions) {
      if (definition.connectorNames.some((candidate) => candidate.toLowerCase() === name)) keys.add(definition.key);
    }
  }
  // Persisted browser activity names the app (screenshots and page URLs are
  // deliberately stripped); outside-touch receipts may still carry domains.
  const app = cleanLine(message?.computer?.app, 80).toLowerCase();
  for (const definition of definitions) {
    if (app && definition.name.toLowerCase() === app) keys.add(definition.key);
  }
  if (/linkedin\.com/i.test(JSON.stringify(message?.outsideTouches || []))) keys.add('linkedin');
  return [...keys];
}

export function platformTurnActivity(message) {
  const lines = [];
  for (const activity of message?.connectors || []) {
    const name = cleanLine(activity?.connector || activity?.name, 80);
    const what = cleanLine(activity?.title || activity?.tool, 160);
    if (name) lines.push(what ? `${name}: ${what}` : name);
  }
  const computer = message?.computer;
  if (computer?.app || computer?.currentStep) {
    const steps = (computer.steps || []).map((step) => cleanLine(step?.step, 120)).filter(Boolean).slice(0, 6);
    lines.push(`Browser (${cleanLine(computer.app, 60) || 'web'}): ${steps.join(' -> ') || cleanLine(computer.currentStep, 120)}`);
  }
  return lines.slice(0, 12).join('\n');
}

export function platformSuggestionPrompt({ definition, record, turn }) {
  const saved = (record.entries || []).map((candidate, index) => `${index + 1}. ${candidate.text}`).join('\n') || '(none)';
  const pending = (record.suggestions || []).map((candidate, index) => `${index + 1}. ${candidate.text}`).join('\n') || '(none)';
  return [
    `<supreme_context_suggestion_request platform="${definition.key}">`,
    `Supreme just finished a task that used ${definition.name}. Propose durable Context entries the user would plausibly approve: standing preferences, recurring patterns, or stable facts about how they use ${definition.name}. Never one-off task details, and never anything already covered below.`,
    'Do not use tools. At most 3 entries, each standalone and under 200 characters. If nothing durable stands out, return an empty entries array — that is the common case.',
    '',
    'Approved entries:',
    saved,
    '',
    'Pending suggestions:',
    pending,
    '',
    'User request:',
    cleanText(turn.userPrompt, 4_000),
    '',
    `What Supreme did in ${definition.name}:`,
    cleanText(turn.activity, 2_000) || '(no activity detail)',
    '',
    'Assistant reply (excerpt):',
    cleanText(turn.assistantText, 4_000),
    '',
    'Return the final result exactly in this envelope, with valid JSON and no text after it:',
    '<supreme_context_result>',
    '{"summary":"","exampleCount":null,"examples":[],"needsAccess":false,"accessMessage":"","entries":["Durable entry"]}',
    '</supreme_context_result>',
    '</supreme_context_suggestion_request>',
  ].join('\n');
}

export function mergePlatformSuggestions(record, proposed) {
  const covered = new Set([...(record.entries || []), ...(record.suggestions || [])].map((candidate) => candidate.text.toLowerCase()));
  const additions = entries(proposed).filter((candidate) => !covered.has(candidate.text.toLowerCase()));
  if (!additions.length) return null;
  record.suggestions = entries([...(record.suggestions || []), ...additions]).slice(0, 10);
  record.updatedAt = new Date().toISOString();
  return record;
}

export function stagePlatformContextSuggestions(record) {
  if (!record.suggestions?.length) return null;
  record.draftEntries = entries([...(record.entries || []), ...record.suggestions]);
  if (record.draftSource?.kind !== 'history') {
    record.draftSource = { kind: 'manual', accessKind: 'manual', label: 'Entered manually', exampleCount: null, examples: [], retrievedAt: null };
  }
  record.suggestions = [];
  record.updatedAt = new Date().toISOString();
  return record;
}

export function clearPlatformContextSuggestions(record) {
  if (!record.suggestions?.length) return null;
  record.suggestions = [];
  record.updatedAt = new Date().toISOString();
  return record;
}

export function savedPlatformContextPrompt(prompt, value, definitions = PLATFORM_CONTEXT_DEFINITIONS) {
  const records = normalizePlatformContexts(value, definitions);
  const active = definitions.flatMap((definition) => {
    const record = records[definition.key];
    if (!record?.entries?.length) return [];
    return [[
      `<platform key="${definition.key}" name="${definition.name}">`,
      ...record.entries.map((candidate, index) => `${index + 1}. ${candidate.text}`),
      '</platform>',
    ].join('\n')];
  });
  if (!active.length) return String(prompt || '');
  return [
    'The user explicitly approved the following platform Context. Apply the matching block whenever you read, write, search, or take action in that platform. The platform key is stable even if the current access method changes. Do not silently edit these entries or claim that new activity changed them.',
    '<supreme_platform_context>',
    active.join('\n\n'),
    '</supreme_platform_context>',
    '',
    'Current user request:',
    String(prompt || ''),
  ].join('\n');
}
