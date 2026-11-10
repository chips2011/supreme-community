import { useEffect } from 'react';
import { useApp } from '../store';
import { TopBar } from './bits';
import { ModelAccountRow, type AccountProvider } from './ModelAccounts';
import { refreshModelUsage, refreshStatus, setProviderBrowserControl } from '../actions';
import type { ModelUsageCredits, ModelUsageWindow, ProviderUsage } from '../types';

const PROVIDERS: AccountProvider[] = ['claude', 'codex', 'grok'];

function resetLabel(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((target - start) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Resets today, ${time}`;
  if (days === 1) return `Resets tomorrow, ${time}`;
  const day = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `Resets ${day}, ${time}`;
}

function money(minor: number | null | undefined, currency = 'USD', exponent = 2): string {
  if (minor == null || !Number.isFinite(Number(minor))) return '';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(minor) / (10 ** exponent));
}

function UsageBar({ window, provider }: { window: ModelUsageWindow; provider: AccountProvider }) {
  const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const display = provider === 'codex' ? `${Math.round(100 - used)}% remaining` : `${Math.round(used)}% used`;
  return (
    <div className="usage-limit">
      <div className="usage-limit-head">
        <b>{window.label}</b>
        <span>{display}</span>
      </div>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${window.label}: ${Math.round(used)}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used)}
      >
        <i style={{ width: `${used}%` }} />
      </div>
      {window.resetsAt ? <small>{resetLabel(window.resetsAt)}</small> : null}
    </div>
  );
}

function ClaudeCredits({ credits }: { credits: ModelUsageCredits }) {
  const used = money(credits.usedMinor, credits.currency, credits.exponent);
  const limit = money(credits.limitMinor, credits.currency, credits.exponent);
  const detail = used && limit ? `${used} of ${limit} used` : '';
  return (
    <div className="usage-fact">
      <span>Usage credits</span>
      <b>{credits.enabled ? 'On' : 'Off'}{detail ? <small> · {detail}</small> : null}</b>
    </div>
  );
}

function CodexCredits({ usage }: { usage: ProviderUsage }) {
  const credits = usage.credits;
  const reset = usage.resetCredits;
  const availableReset = reset?.credits?.find((credit) => credit.status === 'available') || reset?.credits?.[0];
  return (
    <>
      {credits ? (
        <div className="usage-fact">
          <span>Credits</span>
          <b>{credits.unlimited ? 'Unlimited' : credits.hasCredits ? `${credits.balance || '0'} available` : 'None'}</b>
        </div>
      ) : null}
      {reset ? (
        <div className="usage-fact">
          <span>{availableReset?.title || 'Full reset'}</span>
          <b>
            {reset.availableCount > 0 ? `${reset.availableCount} available` : 'None available'}
            {availableReset?.expiresAt ? <small> · Expires {new Date(availableReset.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small> : null}
          </b>
        </div>
      ) : null}
    </>
  );
}

function ProviderSection({ provider }: { provider: AccountProvider }) {
  const s = useApp();
  const usage = s.modelUsage?.providers[provider];
  const connected = provider === 'grok'
    ? !!s.status?.providers.grok?.webConnected
    : !!s.status?.providers[provider]?.ready;
  const chromeOn = s.status?.chrome.byProvider?.[provider] ?? s.status?.chrome.enabled !== false;

  return (
    <section className={`model-provider-section ${connected ? 'connected' : ''}`}>
      <ModelAccountRow provider={provider} />
      <div className="model-provider-body">
        {!connected ? (
          <div className="usage-unavailable">
            {provider === 'grok'
              ? 'Connect your Grok web account for browser workflows. Grok does not expose live subscription usage here yet.'
              : 'Connect this account to see its live limits and use it in Supreme.'}
          </div>
        ) : usage?.available ? (
          <>
            <div className="usage-limits">
              {usage.windows.map((window) => <UsageBar key={`${provider}:${window.id}:${window.label}`} window={window} provider={provider} />)}
            </div>
            {provider === 'claude' && usage.credits ? <ClaudeCredits credits={usage.credits} /> : null}
            {provider === 'codex' ? <CodexCredits usage={usage} /> : null}
          </>
        ) : (
          <div className="usage-unavailable">
            {s.modelUsageLoading && !usage ? 'Loading live usage…' : usage?.message || 'Live usage is unavailable right now.'}
          </div>
        )}
        <div className="provider-chrome-row">
          <div>
            <b>Use your Chrome</b>
            <small>{provider === 'grok' ? 'Lets Supreme use this signed-in web account.' : 'Lets this model work in your signed-in sites.'}</small>
          </div>
          <button
            className={`chrome-toggle ${chromeOn ? 'on' : ''}`}
            aria-pressed={chromeOn}
            onClick={() => setProviderBrowserControl(provider, !chromeOn)}
          >
            {chromeOn ? 'On' : 'Off'}
          </button>
        </div>
      </div>
    </section>
  );
}

export function ModelsView() {
  const s = useApp();
  const chrome = s.status?.chrome;
  const installUrl = chrome?.installUrl || 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';

  useEffect(() => {
    const refreshAccountStatus = () => {
      if (!document.hidden) void refreshStatus();
    };
    refreshAccountStatus();
    void refreshModelUsage();
    const timer = window.setInterval(refreshAccountStatus, 3_000);
    document.addEventListener('visibilitychange', refreshAccountStatus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshAccountStatus);
    };
  }, []);

  return (
    <>
      <TopBar><span className="crumb">Models</span><i /></TopBar>
      <main className="models-page">
        <div className="settings-heading models-heading">
          <div>
            <h1>Models</h1>
            <p>The accounts that do your work.</p>
          </div>
          <button className="usage-refresh" disabled={s.modelUsageLoading} onClick={() => {
            void refreshStatus();
            void refreshModelUsage({ fresh: true });
          }}>
            {s.modelUsageLoading ? 'Updating…' : 'Refresh usage'}
          </button>
        </div>
        {s.modelUsageError ? <div className="model-usage-error">Could not refresh usage · {s.modelUsageError}</div> : null}
        <div className="model-account-list">
          {PROVIDERS.map((provider) => <ProviderSection key={provider} provider={provider} />)}
        </div>
        <section className="chrome-setup">
          <div className="chrome-setup-copy">
            <h2>Chrome extension</h2>
            <p>Models with Chrome turned on can work in the sites where you are already signed in. You can watch every step; Esc takes over.</p>
            <small>{chrome?.installed ? 'Installed ✓' : 'Not installed'}</small>
          </div>
          <a className="chrome-install-link" href={installUrl} target="_blank" rel="noreferrer">
            {chrome?.installed ? 'Reinstall' : 'Install extension'}
          </a>
        </section>
      </main>
    </>
  );
}
