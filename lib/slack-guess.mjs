const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'they', 'them', 'their', 'there', 'what', 'when', 'which', 'would', 'could', 'should', 'about', 'into', 'just', 'like', 'more', 'some', 'than', 'then', 'these', 'those', 'will', 'your', 'yours', 'ours', 'were', 'also', 'here', 'only', 'over', 'such', 'very', 'else', 'does', 'done', 'each', 'other', 'please', 'thanks', 'thank', 'reply', 'subject', 'email', 'message', 'today', 'hello', 'regards', 'best', 'sent', 'show', 'unless', 'since', 'anything', 'something', 'might', 'part', 'deal', 'fund', 'supreme', 'slack', 'new', 'html', 'http', 'https', 'mailto', 'gmail', 'com', 'www']);

const SAME = { reply: ['responses'], replies: ['responses'], replied: ['responses'], response: ['responses'], responses: ['reply'] };

export function guessWords(text) {
  const out = new Set();
  const words = [];
  for (const word of String(text || '').toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || []) {
    const bare = word.replace(/['-]/g, '');
    for (const same of SAME[bare] || []) out.add(same);
    if (bare.length < 4 || STOP.has(bare)) continue;
    out.add(bare);
    words.push(bare);
  }
  // "Mizzen Capital" in a tab and "lender-two.example.com" in an email are the
  // same company: adjacent words are also kept joined.
  for (let index = 0; index + 1 < words.length; index += 1) out.add(words[index] + words[index + 1]);
  return out;
}

function tabText(tab, keep = 60) {
  const messages = (tab.messages || []).slice(-keep);
  return messages.map((message) => String(message.content || '')).join('\n');
}

// The best tabs for a thread, likeliest first. `tasks` are whole task
// records (transcripts included); archived tasks, done tabs and duels are
// never offered. A word counts by how few tabs use it: a lead's name or a
// company picks one tab out, "company" or "invest" picks nothing, and a
// long tab does not win just by having more words in it.
export function guessTabs({ text, tasks, limit = 4, now = Date.now() }) {
  const wanted = guessWords(text);
  const tabs = [];
  for (const task of tasks || []) {
    if (!task || task.archived) continue;
    const workstream = task.title || task.repoName || 'Untitled';
    for (const tab of task.tabs || []) {
      if (!tab || tab.done || tab.type === 'duel' || tab.archived) continue;
      const name = tab.name || 'Untitled';
      const last = (tab.messages || []).at(-1);
      const lastAt = Date.parse(last?.ts || '') || Date.parse(task.lastActivity || '') || 0;
      tabs.push({ threadId: task.id, tabId: tab.id, tab: name, workstream, lastAt, nameWords: guessWords(`${workstream} ${name}`), bodyWords: guessWords(tabText(tab)) });
    }
  }
  const uses = new Map();
  for (const word of wanted) {
    let count = 0;
    for (const row of tabs) if (row.nameWords.has(word) || row.bodyWords.has(word)) count += 1;
    uses.set(word, count);
  }
  const weight = (word) => {
    const count = uses.get(word) || 0;
    if (!count) return 0;
    // One tab: 1. Half of them: about a tenth. Every tab: nothing.
    return Math.max(0, Math.log((tabs.length + 1) / count) / Math.log(tabs.length + 1));
  };
  const rows = tabs.map((row) => {
    let score = 0;
    let hits = 0;
    for (const word of wanted) {
      const inName = row.nameWords.has(word);
      if (!inName && !row.bodyWords.has(word)) continue;
      hits += 1;
      score += weight(word) * (inName ? 2 : 1);
    }
    const age = now - row.lastAt;
    const recency = age < 3 * 86_400_000 ? 0.3 : age < 14 * 86_400_000 ? 0.15 : 0;
    return { threadId: row.threadId, tabId: row.tabId, tab: row.tab, workstream: row.workstream, score: score + recency, hits, lastAt: row.lastAt };
  });
  rows.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  return rows.slice(0, limit);
}
