// Small formatters ported from the vanilla app.

export function relativeTime(value: string | number | undefined): string {
  const ms = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'now';
  if (min < 60) return min + 'm';
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

export function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(Number(ms))) return '';
  const seconds = Number(ms) / 1000;
  return seconds < 10 ? seconds.toFixed(1) + 's' : Math.round(seconds) + 's';
}
