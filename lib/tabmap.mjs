// Connected tabs (Paper page 8-2, boards 1 to 7). A workstream's map is a
// canvas of its tabs, each a card: one line of description, the tools it
// uses with a line of context each, one skill, and what starts it. Two
// cards connect with an edge, and the person says in plain words what hands
// over; those words are the source of truth, the When / Then / With rule is
// the parse. The tab stays the building block: opening a card opens the
// tab, and the card is standing guidance for every turn the tab runs.
//
// Nothing here runs on its own. A hand-over rule reaches the model as a
// line in the turn's brief, and the model hands over with the send_to_tab
// tool from section 26, which wakes the other tab.

export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 292;
export const CARD_MIN_HEIGHT = 86;
export const MAP_DESCRIPTION_MAX = 600;
export const MAP_CONTEXT_MAX = 160;
export const MAP_TOOLS_MAX = 8;
export const MAP_WORDS_MAX = 400;

export function cardKey(threadId, tabId) {
  return `${threadId}:${tabId}`;
}

export function parseCardKey(key) {
  const value = String(key || '');
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1) return null;
  return { threadId: value.slice(0, at), tabId: value.slice(at + 1) };
}

export function refKey(ref) {
  return cardKey(ref?.threadId || '', ref?.tabId || '');
}

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanTools(values) {
  return (Array.isArray(values) ? values : [])
    .map((row) => ({ name: text(row?.name, 60).replace(/^@/, ''), context: text(row?.context, MAP_CONTEXT_MAX) }))
    .filter((row) => row.name)
    .slice(0, MAP_TOOLS_MAX);
}

function cleanSkill(value) {
  if (!value || typeof value !== 'object') return null;
  const name = text(value.name, 80).replace(/^@/, '');
  if (!name) return null;
  return { id: text(value.id, 80) || null, name };
}

export function cleanCard(card = {}) {
  const out = {
    description: text(card.description, MAP_DESCRIPTION_MAX),
    tools: cleanTools(card.tools),
    skill: cleanSkill(card.skill),
    minimized: !!card.minimized,
  };
  if (Number.isFinite(Number(card.x)) && Number.isFinite(Number(card.y))) {
    out.x = Math.max(0, Math.round(Number(card.x)));
    out.y = Math.max(0, Math.round(Number(card.y)));
  }
  if (card.addedAt) out.addedAt = String(card.addedAt);
  if (card.hidden) out.hidden = true;
  // Section 27: what the tab owes the orchestrator, short ("150",
  // "preflight"), and who put the card here (the orchestrator may take off
  // only what it added).
  if (text(card.owes, 40)) out.owes = text(card.owes, 40);
  if (card.by === 'orchestrator') out.by = 'orchestrator';
  return out;
}

export function cleanRule(rule = {}) {
  return {
    when: text(rule.when, 160),
    then: text(rule.then, 160),
    with: text(rule.with, 200),
    label: text(rule.label, 40),
    trigger: text(rule.trigger, 80),
  };
}

function cleanEdge(edge) {
  return {
    id: String(edge.id),
    from: { threadId: String(edge.from.threadId), tabId: String(edge.from.tabId) },
    to: { threadId: String(edge.to.threadId), tabId: String(edge.to.tabId) },
    words: text(edge.words, MAP_WORDS_MAX),
    rule: cleanRule(edge.rule),
    createdAt: edge.createdAt || null,
    updatedAt: edge.updatedAt || null,
  };
}

// The stored map with hidden own cards kept, for a route that saves it back.
export function mergeHidden(task, map) {
  const stored = task?.map?.cards && typeof task.map.cards === 'object' ? task.map.cards : {};
  const cards = { ...map.cards };
  for (const [key, card] of Object.entries(stored)) {
    if (card?.hidden && !cards[key]) cards[key] = { ...cleanCard(card), threadId: parseCardKey(key)?.threadId || task.id, tabId: parseCardKey(key)?.tabId || '' };
  }
  return { cards, edges: map.edges };
}

export function emptyMap() {
  return { cards: {}, edges: [] };
}

// Own tabs taken off the map by hand, so Add tab can list them.
export function hiddenOwnTabs(task) {
  const stored = task?.map?.cards && typeof task.map.cards === 'object' ? task.map.cards : {};
  return (task?.tabs || []).filter((tab) => tab && tab.type !== 'duel' && stored[cardKey(task.id, tab.id)]?.hidden);
}

// The stored map made whole: every live tab of the workstream has a card
// unless taken off by hand, a card whose tab is gone goes, a foreign card
// stays only while its tab is still there, and an edge needs both ends.
// lookupTask reads another workstream; without it foreign cards are kept
// as stored.
export function normalizeMap(task, lookupTask = null) {
  const stored = task?.map && typeof task.map === 'object' ? task.map : {};
  const storedCards = stored.cards && typeof stored.cards === 'object' ? stored.cards : {};
  const cards = {};
  for (const tab of task?.tabs || []) {
    if (!tab || tab.type === 'duel') continue;
    const key = cardKey(task.id, tab.id);
    const previous = storedCards[key];
    // A done tab stays on the map: the map is the shape of a workflow that
    // has run, and its hand-overs are the part worth keeping (design
    // session, 2026-09-08). A card taken off by hand is hidden, not gone;
    // Add tab brings it back.
    if (previous?.hidden) continue;
    cards[key] = { ...cleanCard(previous || {}), threadId: task.id, tabId: tab.id };
  }
  for (const [key, card] of Object.entries(storedCards)) {
    if (cards[key]) continue;
    const ref = parseCardKey(key);
    if (!ref || ref.threadId === task.id) continue;
    if (lookupTask) {
      const other = lookupTask(ref.threadId);
      const tab = other && !other.archived ? (other.tabs || []).find((candidate) => candidate.id === ref.tabId && candidate.type !== 'duel') : null;
      if (!tab) continue;
    }
    cards[key] = { ...cleanCard(card || {}), threadId: ref.threadId, tabId: ref.tabId };
  }
  const edges = (Array.isArray(stored.edges) ? stored.edges : [])
    .filter((edge) => edge && edge.id && edge.from && edge.to && cards[refKey(edge.from)] && cards[refKey(edge.to)] && refKey(edge.from) !== refKey(edge.to))
    .map(cleanEdge);
  return { cards, edges };
}

function tabNameOf(task, tabId) {
  const tab = (task?.tabs || []).find((candidate) => candidate.id === tabId);
  return tab?.name || 'Untitled';
}

function titleOf(task) {
  return task?.title || task?.repoName || 'Untitled';
}

// What a card is called on a map, and where it lives. Names are read at
// read time so a renamed tab reads right without the map knowing.
export function mapPublic(task, lookupTask = null) {
  const map = normalizeMap(task, lookupTask);
  const others = new Map();
  const taskFor = (threadId) => {
    if (threadId === task.id) return task;
    if (!others.has(threadId)) others.set(threadId, lookupTask ? lookupTask(threadId) : null);
    return others.get(threadId);
  };
  const cards = {};
  for (const [key, card] of Object.entries(map.cards)) {
    const owner = taskFor(card.threadId);
    const tab = (owner?.tabs || []).find((candidate) => candidate.id === card.tabId);
    cards[key] = {
      ...card,
      key,
      own: card.threadId === task.id,
      name: tab?.name || 'Untitled',
      threadTitle: titleOf(owner),
      status: tab?.status || 'idle',
      done: !!tab?.done,
    };
  }
  const named = (ref) => ({ ...ref, name: tabNameOf(taskFor(ref.threadId), ref.tabId), threadTitle: titleOf(taskFor(ref.threadId)) });
  const edges = map.edges.map((edge) => ({ ...edge, from: named(edge.from), to: named(edge.to) }));
  return { cards, edges };
}

export const LANE_QUIET_MS = 10 * 60_000;

export function laneStates(tab, now = Date.now(), quietAfterMs = LANE_QUIET_MS) {
  const lanes = {};
  for (const message of tab?.messages || []) {
    if (!message || message.role !== 'tab') continue;
    const address = message.direction === 'out' ? message.to : message.from;
    if (!address?.threadId || !address?.tabId) continue;
    const key = cardKey(address.threadId, address.tabId);
    const lane = lanes[key] || (lanes[key] = { askedAt: null, answeredAt: null, quietAt: null, last: null });
    const at = Date.parse(message.ts || '') || 0;
    if (message.direction === 'out') { lane.askedAt = message.ts || null; lane.answeredAt = null; }
    else if (lane.askedAt && !lane.answeredAt && at >= (Date.parse(lane.askedAt) || 0)) lane.answeredAt = message.ts || null;
    lane.last = message.ts || lane.last;
  }
  for (const lane of Object.values(lanes)) {
    const asked = Date.parse(lane.askedAt || '') || 0;
    lane.quietAt = lane.askedAt && !lane.answeredAt && now - asked > quietAfterMs ? new Date(asked + quietAfterMs).toISOString() : null;
  }
  return lanes;
}

export function laneWords(lane, now = Date.now()) {
  if (!lane || !lane.askedAt) return 'not asked yet';
  const ago = (iso) => {
    const minutes = Math.max(0, Math.round((now - (Date.parse(iso) || now)) / 60_000));
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
  };
  if (lane.answeredAt) return `answered ${ago(lane.answeredAt)}`;
  if (lane.quietAt) return `asked ${ago(lane.askedAt)}, gone quiet`;
  return `asked ${ago(lane.askedAt)}, waiting`;
}

// The orchestrator's brief, at the top of every turn: what it is, what it
// may do to the roster, and the roster as it stands with each lane.
export function orchestratorBrief({ task, tab, lookupTask = null, now = Date.now() }) {
  const map = normalizeMap(task, lookupTask);
  const own = cardKey(task.id, tab.id);
  const lanes = laneStates(tab, now);
  const rows = Object.entries(map.cards).filter(([key]) => key !== own).map(([key, card]) => {
    const owner = card.threadId === task.id ? task : (lookupTask ? lookupTask(card.threadId) : null);
    const bits = [];
    if (card.description) bits.push(card.description);
    if (card.owes) bits.push(`Owes: ${card.owes}`);
    bits.push(laneWords(lanes[key], now));
    return `- ${titleOf(owner)} / ${tabNameOf(owner, card.tabId)}: ${bits.join('. ')}`;
  });
  return [
    '<orchestrator>',
    `You are the orchestrator tab of ${titleOf(task)}${task?.repoName ? ` in the project ${task.repoName}` : ''}. You reach every tab in this project with send_to_tab, and you keep the roster of the tabs you work with: the cards on this workstream's map. The roster is yours to write with the roster tools (roster_add, roster_new_tab, roster_remove, roster_write), and every change lands in the workstream's traffic where the person can undo it. You cannot set another tab's type, and you cannot take off a tab the person put on the map or connected. Ask a tab for one thing at a time, in full, and stop when you are waiting: the answer comes back as a message on a later turn of yours.`,
    rows.length ? 'Your roster:' : 'Your roster is empty: put tabs on it with roster_add, or make one with roster_new_tab.',
    ...rows,
    '</orchestrator>',
  ].join('\n');
}

// Board 1: "Starts" on a card is what wakes it, "When I ask" first and then
// every connection that lands here, by its trigger.
export function cardStarts(map, key) {
  const triggers = (map?.edges || []).filter((edge) => refKey(edge.to) === key).map((edge) => edge.rule?.trigger || edge.rule?.when).filter(Boolean);
  return ['When I ask', ...triggers];
}

const capitalize = (value) => (value ? value[0].toUpperCase() + value.slice(1) : '');
const lower = (value) => (value ? value[0].toLowerCase() + value.slice(1) : '');
const untrail = (value) => String(value || '').trim().replace(/[.!\s]+$/, '');

// Boards 4 and 5: the words become the rule. The model gets the sentence and
// both tab names and answers with the four fields as JSON; the person's nouns
// stay theirs.
export function rulePrompt({ words, fromName, toName }) {
  return [
    `Two tabs in a work app are connected: "${fromName}" hands over to "${toName}". The person wrote, in their own words, what hands over:`,
    `"${untrail(words)}"`,
    'Turn that into a rule. Answer with JSON only, no prose, exactly these fields:',
    `{"when": "what happens in ${fromName} that starts it, e.g. A firm passes in ${fromName}", "then": "${toName} starts", "with": "what ${toName} receives, e.g. Offices like the one that passed", "label": "two or three words naming the connection, e.g. Firms that passed", "trigger": "the when without the tab name, e.g. A firm passes"}`,
    'Keep the person\'s nouns. Sentence case, no trailing period. Never invent a condition the person did not say.',
  ].join('\n');
}

export function parseRule(value) {
  const raw = String(value || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const rule = cleanRule({
    when: untrail(parsed.when),
    then: untrail(parsed.then),
    with: untrail(parsed.with),
    label: untrail(parsed.label),
    trigger: untrail(parsed.trigger),
  });
  if (!rule.when || !rule.then || !rule.with) return null;
  if (!rule.trigger) rule.trigger = rule.when;
  if (!rule.label) rule.label = shortLabel(rule.trigger);
  return rule;
}

function shortLabel(value) {
  const words = untrail(value).replace(/^(a|an|the)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return capitalize(words);
}

// No model on this Mac, or one that did not answer: the sentence still
// becomes a rule, by its shape. "when X, Y" and "X, then Y" split into the
// condition and the hand-over; anything else is all hand-over, started by
// the source tab finishing a turn.
export function deterministicRule({ words, fromName, toName }) {
  const raw = untrail(words);
  let condition = '';
  let payload = raw;
  const lead = raw.match(/^(?:when|whenever|after|once|if|as soon as|every time)\s+(.+?)(?:\s*,\s*|\s+then\s+|\s*:\s*)(.+)$/i);
  if (lead) {
    condition = lead[1];
    payload = lead[2];
  } else {
    const mid = raw.match(/^(.+?)\s*(?:,\s*then\s+|\s+then\s+|\s*-->\s*|\s*->\s*)(.+)$/i);
    if (mid) {
      condition = mid[1];
      payload = mid[2];
    }
  }
  condition = untrail(condition);
  payload = untrail(payload).replace(/^(?:then\s+)/i, '');
  const trigger = condition ? capitalize(condition) : `${fromName} finishes`;
  return cleanRule({
    when: condition ? `${capitalize(condition)} in ${fromName}` : `${fromName} finishes a turn`,
    then: `${toName} starts`,
    with: capitalize(payload) || 'What the person said',
    label: shortLabel(condition || payload),
    trigger,
  });
}

// The maps a tab has a card on: its own workstream's, and any workstream
// that dragged it in (a membership written when the card was added).
// A map taken off (task.mapOff) is not read for anyone's turns: its cards
// and connections stay stored for Add map, and say nothing meanwhile.
export function mapsForTab(task, lookupTask) {
  const maps = task?.mapOff ? [] : [{ mapTask: task, map: normalizeMap(task, lookupTask) }];
  for (const mapTaskId of Array.isArray(task?.mapMemberships) ? task.mapMemberships : []) {
    if (mapTaskId === task.id) continue;
    const mapTask = lookupTask ? lookupTask(mapTaskId) : null;
    if (!mapTask || mapTask.archived || mapTask.mapOff) continue;
    maps.push({ mapTask, map: normalizeMap(mapTask, lookupTask) });
  }
  return maps;
}

// The card, as the model reads it at the top of every turn: the description
// is what the tab is for, the tools say how each is used, the skill's rules
// come along, and a hand-over rule says when to send and what. It is
// guidance from the person, and it says so; the send is the section 26 tool.
export function tabBrief({ task, tab, maps, lookupTask = null, lookupPlay = null }) {
  const key = cardKey(task.id, tab.id);
  const nameOf = (ref) => {
    const owner = ref.threadId === task.id ? task : (lookupTask ? lookupTask(ref.threadId) : null);
    return `${titleOf(owner)} / ${tabNameOf(owner, ref.tabId)}`;
  };
  const sections = [];
  for (const { mapTask, map } of maps || []) {
    const card = map.cards[key];
    if (!card) continue;
    const outgoing = map.edges.filter((edge) => refKey(edge.from) === key);
    const incoming = map.edges.filter((edge) => refKey(edge.to) === key);
    if (!card.description && !card.tools.length && !card.skill && !outgoing.length && !incoming.length) continue;
    const lines = [`On the map of ${titleOf(mapTask)}:`];
    if (card.description) lines.push(`This tab: ${card.description}`);
    for (const tool of card.tools) lines.push(`Uses ${tool.name}${tool.context ? `: ${tool.context}` : ''}.`);
    if (card.skill) {
      const play = card.skill.id && lookupPlay ? lookupPlay(card.skill.id) : null;
      const rules = play ? String(play.rulesText || '').trim().slice(0, 1500) : '';
      lines.push(`Skill: ${card.skill.name}.${rules ? ` Its rules:\n${rules}` : ''}`);
    }
    for (const edge of outgoing) {
      lines.push(`Hands over to ${nameOf(edge.to)} when ${lower(edge.rule.trigger || edge.rule.when)}: send ${lower(edge.rule.with)} with the send_to_tab tool, tab "${nameOf(edge.to)}". The person's words: "${edge.words}".`);
    }
    for (const edge of incoming) {
      lines.push(`Starts from ${nameOf(edge.from)} when ${lower(edge.rule.trigger || edge.rule.when)}; a message from that tab then carries ${lower(edge.rule.with)}.`);
    }
    sections.push(lines.join('\n'));
  }
  if (!sections.length) return '';
  return [
    '<connected_tab>',
    'This tab has a card on a map of connected tabs. The card is the person\'s standing guidance for every turn here, not a task by itself. A hand-over rule fires only when its condition really happened in this turn, and then sends one message, once; when nothing happened, send nothing.',
    ...sections,
    '</connected_tab>',
  ].join('\n');
}
