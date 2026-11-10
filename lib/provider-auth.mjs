const CODEX_SIGNED_OUT = /\b(?:not logged in|not signed in|authentication required|login required|no credentials found)\b|(?:please|run)\s+`?codex login/i;

// A CLI timeout, launch race, or temporary service error is not a sign-out.
// Only the CLI's explicit signed-out answer may replace a known-good account.
export function codexLoginAuthenticated(error, stdout = '', stderr = '') {
  if (!error) return true;
  const output = `${String(stdout || '')}\n${String(stderr || '')}`;
  return CODEX_SIGNED_OUT.test(output) ? false : null;
}

// Keep the last confirmed account while a provider refresh is in flight or a
// status probe fails temporarily. A provider must explicitly report signed
// out before a known-good account is replaced. Injecting the clock lets the
// release gate cross an hour boundary instantly instead of sleeping for one.
export class ProviderAccountCache {
  constructor({ ttlMs = 15_000, now = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.now = now;
    this.entries = new Map();
  }

  read(provider, probe) {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { at: null, value: null, pending: false };
      this.entries.set(provider, entry);
    }
    const due = entry.at === null || this.now() - entry.at >= this.ttlMs;
    if (!entry.pending && due) {
      entry.pending = true;
      Promise.resolve()
        .then(probe)
        .then(
          (value) => this.finish(provider, entry, value),
          () => this.finish(provider, entry, null),
        );
    }
    return entry.value;
  }

  finish(provider, entry, value) {
    // Ignore an old probe that finishes after OAuth invalidated or replaced it.
    if (this.entries.get(provider) !== entry) return;
    entry.pending = false;
    entry.at = this.now();
    if (value !== null && value !== undefined) entry.value = value;
  }

  invalidate(provider) {
    this.entries.delete(provider);
  }

  seed(provider, value) {
    this.entries.set(provider, { at: this.now(), value, pending: false });
  }
}
