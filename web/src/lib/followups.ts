// Codex's suggested next asks, kept out of the answer while it streams in;
// the saved answer has them lifted already (lib/followups.mjs).
const DIRECTIVE = /:codex-followup\[[^\]\n]{0,200}\]\{prompt="(?:[^"\\\n]|\\.){0,4000}"\}/g;
const LINE = /^\s*(?:[-*+]|\d+[.)])?\s*(?::codex-followup\[[^\]\n]{0,200}\]\{prompt="(?:[^"\\\n]|\\.){0,4000}"\}\s*)+$/;
// A directive still being written, at the very end of the stream.
const PARTIAL = /\n?\s*(?:[-*+]\s*)?:codex-followup\[[^\n]*$/;

export function withoutFollowups(text: string): string {
  if (!text.includes(':codex-followup')) return text;
  return text.split('\n').filter((line) => !LINE.test(line)).map((line) => line.replace(DIRECTIVE, '')).join('\n').replace(PARTIAL, '').replace(/\n{3,}/g, '\n\n');
}
