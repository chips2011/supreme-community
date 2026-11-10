#!/usr/bin/env node
// Supreme's own MCP server (section 26, and recall from the fold work).
// Spawned by the model CLI for each run with the calling tab in its
// environment, it turns tool calls into requests to the local service. It is
// the one implementation every model family shares: claude and codex load it
// as an MCP server, so a GPT tab and a Claude tab reach each other the same
// way. JSON-RPC over stdio, one message per line.

import { createInterface } from 'node:readline';

const PORT = process.env.SUPREME_PORT || '4747';
const TASK_ID = process.env.SUPREME_TASK_ID || '';
const TAB_ID = process.env.SUPREME_TAB_ID || '';

// Section 27: the orchestrator's roster tools, only for a tab of that type
// (Supreme sets SUPREME_TAB_TYPE for the run). The roster is the map of the
// orchestrator's workstream; every write lands in traffic with an undo.
const ROSTER_TOOLS = [
  {
    name: 'roster_add',
    description: 'Put a tab that already exists on your roster, the map of this workstream, so it shows in your network and reads your line for it. Say in one line why, for the traffic record the person reads.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'The tab, as "Workstream / Tab" from list_tabs.' },
        line: { type: 'string', description: 'What this tab is for, one line.' },
        owes: { type: 'string', description: 'What it owes you, short: "150", "preflight", "the shortlist".' },
        why: { type: 'string', description: 'One line on why, for the traffic record.' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'roster_new_tab',
    description: 'Make a new tab in this workstream for work that has no home yet, and put it on your roster. Then send it its first message with send_to_tab.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tab\'s name, short.' },
        line: { type: 'string', description: 'What this tab is for, one line.' },
        owes: { type: 'string', description: 'What it owes you, short.' },
        why: { type: 'string', description: 'One line on why, for the traffic record.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'roster_remove',
    description: 'Take a tab you put on the roster off it again. A tab the person put on the map, or connected, stays; ask them instead.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'The tab, as "Workstream / Tab".' },
        why: { type: 'string', description: 'One line on why, for the traffic record.' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'roster_write',
    description: 'Write a roster tab\'s line, the number it owes you, or both, as they stand now.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'The tab, as "Workstream / Tab".' },
        line: { type: 'string', description: 'What this tab is for, one line.' },
        owes: { type: 'string', description: 'What it owes you, short.' },
        why: { type: 'string', description: 'One line on why, for the traffic record.' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
];

const TOOLS = [
  {
    name: 'read_slack_context',
    description: 'Read-only lookup of earlier messages in the Slack channel or group chat attached to this tab, through Supreme\'s own bot connection. Use this before separate Slack connectors, including when another connector reports token_revoked. Cannot select another conversation. Returns message timestamps and nextBefore for paging, at most three calls per request. Query filters this page only, not the entire archive. Never repeat credentials in your answer.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 100, description: 'Words to find in this page of messages.' },
      before: { type: 'string', description: 'A nextBefore timestamp returned by the last page to look further back.' },
      message_ts: { type: 'string', description: 'Read this exact older message and its thread, in the same conversation.' },
    }, additionalProperties: false },
  },
  {
    name: 'read_slack_people',
    description: 'Read-only lookup of member names and visible profile emails in the Slack channel or group chat attached to this tab, through Supreme\'s own bot connection. Use before asking the user who someone is or what email to use. Limited to 20 members per page and three calls per request. Cannot choose a channel or arbitrary user. Query filters this page only. Missing email, especially in Slack Connect, is not permission to guess one. Does not invite anyone or grant access.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 100, description: 'Name or email to match within this member page. Omit to see all people in the page.' },
      cursor: { type: 'string', maxLength: 500, description: 'A nextCursor returned by this tool for the same request.' },
    }, additionalProperties: false },
  },
  {
    name: 'list_tabs',
    description: 'The other tabs in this app you can message, as "Workstream / Tab" with what each is doing. Tabs in this workstream come first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_to_tab',
    description: 'Send a message to another tab in this app; the model working there reads it on its next turn. Use it to hand over a finding or a result, or to ask for something only that tab knows and that you need to finish your own task. Do not send acknowledgments, thanks, status updates, reminders, or requests to be told when something is done: the other tab has its own work and a message costs it a turn. One message per tab per turn; if you are waiting on a tab, finish what you can and stop rather than asking again. Nothing comes back from this call: a reply, if the other tab sends one, arrives as a message on a later turn of yours. Six messages between two tabs without a person end the exchange.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The tab, as "Workstream / Tab" from list_tabs (a tab in this workstream can be named alone).' },
        message: { type: 'string', description: 'What to say, in full; the other tab has none of your context.' },
        reply_to: { type: 'string', description: 'When answering a specific tab message, its id.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_tab',
    description: 'Read the most recent messages of another tab in this app, to see where its work stands before you write to it.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'The tab, as "Workstream / Tab" from list_tabs.' },
        limit: { type: 'integer', description: 'How many recent messages, up to 20.', minimum: 1, maximum: 20 },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description: 'Bring back messages from the summarized (folded) part of this conversation that match a few words. Use it when the summary above mentions something you need the exact wording, number or link for.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A few words that appear in what you are looking for.' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
if (process.env.SUPREME_TAB_TYPE === 'orchestrator') TOOLS.push(...ROSTER_TOOLS);

async function call(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/tabmail/${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: TASK_ID, tabId: TAB_ID, ...body }),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
  if (!response.ok) throw new Error(parsed.error || `Supreme answered ${response.status}`);
  return parsed;
}

function result(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function runTool(name, args) {
  const input = args && typeof args === 'object' ? args : {};
  if (name === 'read_slack_context') {
    const context = await call('slack-context', { query: String(input.query || ''), before: String(input.before || ''), messageTs: String(input.message_ts || '') });
    return result(JSON.stringify(context));
  }
  if (name === 'read_slack_people') {
    const people = await call('slack-people', { query: String(input.query || ''), cursor: String(input.cursor || '') });
    return result(JSON.stringify(people));
  }
  if (name === 'list_tabs') {
    const { tabs } = await call('tabs', {});
    if (!tabs?.length) return result('No other tabs right now.');
    return result(tabs.map((row) => `${row.name} (${row.status}${row.sameWorkstream ? ', this workstream' : ''})`).join('\n'));
  }
  if (name === 'send_to_tab') {
    const sent = await call('send', { to: { name: String(input.to || '') }, text: String(input.message || ''), ...(input.reply_to ? { replyTo: String(input.reply_to) } : {}) });
    return result(`Sent to ${sent.to}.`);
  }
  if (name === 'read_tab') {
    const { name: tabName, messages } = await call('read', { to: { name: String(input.tab || '') }, limit: Number(input.limit) || 8 });
    if (!messages?.length) return result(`${tabName} has no messages yet.`);
    return result([`${tabName}, most recent last:`, ...messages.map((row) => `${row.who}: ${row.text}`)].join('\n\n'));
  }
  if (name.startsWith('roster_')) {
    const action = name === 'roster_new_tab' ? 'new' : name.slice('roster_'.length);
    const out = await call('roster', { action, tab: input.tab, name: input.name, line: input.line, owes: input.owes, why: input.why });
    return result(out.text || 'Done.');
  }
  if (name === 'recall') {
    const { messages } = await call('recall', { query: String(input.query || '') });
    if (!messages?.length) return result('Nothing in the folded part of this conversation matches that.');
    return result(messages.map((row) => `[${row.id}] ${row.who}: ${row.text}`).join('\n\n'));
  }
  return result(`Unknown tool ${name}.`, true);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const reply = (payload) => { if (id !== undefined) write({ jsonrpc: '2.0', id, result: payload }); };
  try {
    if (method === 'initialize') {
      reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'supreme', version: '1.0.0' } });
    } else if (method === 'tools/list') {
      reply({ tools: TOOLS });
    } else if (method === 'tools/call') {
      let payload;
      try {
        payload = await runTool(params?.name, params?.arguments);
      } catch (error) {
        payload = result(String(error?.message || error), true);
      }
      reply(payload);
    } else if (method === 'ping') {
      reply({});
    } else if (method === 'resources/list') {
      reply({ resources: [] });
    } else if (method === 'prompts/list') {
      reply({ prompts: [] });
    } else if (String(method || '').startsWith('notifications/')) {
      // Nothing to answer.
    } else if (id !== undefined) {
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message || error) } });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (Array.isArray(message)) message.forEach((item) => void handle(item));
  else void handle(message);
});
lines.on('close', () => process.exit(0));
