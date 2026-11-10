export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
export const UPDATE_FOCUS_DELAY_MS = 1_500;
export const UPDATE_WAKE_DELAY_MS = 15_000;
export const UPDATE_RECENT_CHECK_GAP_MS = 60_000;

export function scheduledUpdateDelay({
  delay = 0,
  lastCheckAt = 0,
  now = Date.now(),
  respectRecentCheck = false,
} = {}) {
  const requestedDelay = Math.max(0, Number(delay) || 0);
  if (!respectRecentCheck || !lastCheckAt) return requestedDelay;
  const sinceLastCheck = Math.max(0, now - lastCheckAt);
  return Math.max(requestedDelay, UPDATE_RECENT_CHECK_GAP_MS - sinceLastCheck);
}
