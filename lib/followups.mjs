const DIRECTIVE = /:codex-followup\[([^\]\n]{0,200})\]\{prompt="((?:[^"\\\n]|\\.){0,4000})"\}/g;
const LINE = /^\s*(?:[-*+]|\d+[.)])?\s*(?::codex-followup\[[^\]\n]{0,200}\]\{prompt="(?:[^"\\\n]|\\.){0,4000}"\}\s*)+$/;

export function takeFollowups(content) {
  const text = String(content ?? '');
  if (!text.includes(':codex-followup[')) return { content: text, followups: [] };
  const followups = [];
  for (const match of text.matchAll(DIRECTIVE)) {
    const label = match[1].trim();
    const prompt = match[2].replace(/\\(.)/g, '$1').trim();
    if (label && prompt && !followups.some((row) => row.label === label)) followups.push({ label, prompt });
  }
  // A line that is only follow-ups goes; one mid sentence loses the
  // directive and keeps the rest.
  const kept = text.split('\n')
    .filter((line) => !LINE.test(line))
    .map((line) => line.replace(DIRECTIVE, '').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { content: kept, followups };
}
