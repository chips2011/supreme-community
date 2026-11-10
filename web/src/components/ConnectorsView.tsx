import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Icon } from '../icons';
import { TopBar } from './bits';
import { CompanyLogo } from './CompanyLogo';
import { loadConnectorsOverview, refreshConnectorsOverview, openConnectorSettings, signInCodexServer, loadSettings, saveSlackSettings, startSlackConnect } from '../actions';
import type { ConnectorRow } from '../types';

// The Connectors page (Paper section 15): everything Supreme can reach and
// which model reaches it. Rows group by connector across providers, Most used
// first (seeded once from local model histories, then counted per turn), the
// rest alphabetical. The only colour is a sign-in that actually lapsed.

const PROVIDER_LABEL = { claude: 'Claude', codex: 'ChatGPT' } as const;

function lastUsed(at: string | null): string {
  if (!at) return 'a while ago';
  const then = new Date(at);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: 'long' });
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function usesLine(row: ConnectorRow): string {
  if (row.uses > 0) return `${row.uses} ${row.uses === 1 ? 'use' : 'uses'} · last ${lastUsed(row.lastUsedAt)}`;
  if (row.seededUses > 0) return `${row.seededUses} ${row.seededUses === 1 ? 'use' : 'uses'} before Supreme`;
  return 'Never used';
}

function checkedLine(at: string | null): string {
  if (!at) return 'Not checked yet';
  const min = Math.floor((Date.now() - Date.parse(at)) / 60_000);
  if (min < 1) return 'Checked just now';
  if (min < 60) return `Checked ${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  return `Checked ${Math.floor(hours / 24)} d ago`;
}

function Row({ row }: { row: ConnectorRow }) {
  const providers = (['claude', 'codex'] as const).filter((provider) => row.providers[provider]);
  return (
    <div className="connector-row" data-key={row.key}>
      <span className="platform-context-mark">{row.name.slice(0, 1).toUpperCase()}</span>
      <span><b>{row.name}</b><small>{usesLine(row)}</small></span>
      <span className="connector-state">
        {row.signIn.map((provider) => {
          // A Codex remote server signs in through its CLI, not chatgpt.com.
          const server = provider === 'codex' ? row.providers.codex?.server || '' : '';
          return (
            <span key={provider} className="connector-signin">
              <i>{providers.length > 1 ? `${PROVIDER_LABEL[provider]} needs sign-in` : 'Needs sign-in'}</i>
              <button type="button" onClick={() => void (server ? signInCodexServer(server, row.name) : openConnectorSettings(provider))}>Sign in</button>
            </span>
          );
        })}
        {(row.install || []).map((provider) => (
          <span key={`install-${provider}`} className="connector-signin">
            <i>{providers.length > 1 ? `${PROVIDER_LABEL[provider]} needs its Chrome extension` : 'Needs the Chrome extension'}</i>
            <button type="button" onClick={() => { const url = row.providers[provider]?.url; if (url) window.open(url, '_blank', 'noopener'); }}>Install</button>
          </span>
        ))}
        {row.isNew ? <em className="new">new</em> : null}
        <span className="connector-providers">
          {providers.map((provider) => (
            <em
              key={provider}
              className={row.providers[provider]?.connected ? '' : 'off'}
              title={`${PROVIDER_LABEL[provider]} · ${row.providers[provider]?.status || ''}`}
            >
              <CompanyLogo company={provider} size={11} />{PROVIDER_LABEL[provider]}
            </em>
          ))}
        </span>
      </span>
    </div>
  );
}

type SlackHealth = { state?: string; team?: string; error?: string };
type SlackPrefs = { botToken: string; appToken?: string; listening?: { state: string; error?: string }; startNewThreads: boolean; notifyMentions: boolean; notifyCompleted: boolean; notifyFailures: boolean; minRunSeconds: number; health?: SlackHealth; oauth?: boolean; source?: string; team?: string; selfEmail?: string };

function SlackCard() {
  const [prefs, setPrefs] = useState<SlackPrefs | null>(null);
  const [token, setToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [pasting, setPasting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [selfEmail, setSelfEmail] = useState('');
  useEffect(() => {
    const load = () => loadSettings().then((settings) => {
      const raw = (settings.slack || {}) as Partial<SlackPrefs>;
      setPrefs({
        botToken: raw.botToken || '',
        appToken: raw.appToken || '',
        listening: raw.listening,
        startNewThreads: raw.startNewThreads !== false,
        notifyMentions: raw.notifyMentions !== false,
        notifyCompleted: raw.notifyCompleted !== false,
        notifyFailures: raw.notifyFailures !== false,
        minRunSeconds: Number.isFinite(Number(raw.minRunSeconds)) ? Number(raw.minRunSeconds) : 120,
        health: raw.health,
        oauth: !!raw.oauth,
        source: raw.source || '',
        team: raw.team || '',
        selfEmail: raw.selfEmail || '',
      });
      setSelfEmail(raw.selfEmail || '');
    }).catch(() => {});
    void load();
    // Add to Slack lands through a deep link; the card refreshes when it does.
    const onChanged = () => { void load(); };
    window.addEventListener('supreme:slack-changed', onChanged);
    return () => window.removeEventListener('supreme:slack-changed', onChanged);
  }, []);
  if (!prefs) return null;
  const save = (patch: Partial<SlackPrefs>) => {
    setPrefs({ ...prefs, ...patch });
    void saveSlackSettings(patch).then((health) => {
      if (health) setPrefs((current) => (current ? { ...current, botToken: 'set', health } : current));
    });
  };
  const connected = prefs.botToken === 'set';
  const health = prefs.health?.state || (connected ? 'checking' : 'unset');
  // Not "connected" until Slack itself said so (the token is verified with
  // auth.test when pasted and again every ten minutes).
  const status = !connected
    ? 'Paste a bot token to get mentions and finished runs as Slack DMs.'
    : health === 'ok'
      ? `Connected${prefs.health?.team ? ` to ${prefs.health.team}` : ''}. Mentions and finished runs DM you in Slack.`
      : health === 'rejected'
        ? 'Slack rejected this token. Paste a fresh Bot User OAuth Token (xoxb-…) below.'
        : health === 'unreachable'
          ? 'Token saved. Slack could not be reached to check it; it will retry.'
          : 'Token saved. Checking it with Slack…';
  return (
    <section className="slack-card" aria-label="Slack notifications">
      <div className="slack-card-head">
        <span className="platform-context-mark">S</span>
        <span>
          <b>Slack</b>
          <small className={health === 'rejected' ? 'slack-status-bad' : undefined}>{status}</small>
        </span>
      </div>
      {prefs.oauth ? (
        <div className="slack-card-oauth">
          <button
            type="button"
            className="slack-add"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              void startSlackConnect().finally(() => setOpening(false));
            }}
          >
            {connected ? 'Reconnect Slack' : 'Add to Slack'}
          </button>
          <small>{connected && health === 'ok' ? 'Teammates on your shared projects are connected through you.' : 'One click. Slack asks once, then mentions and finished runs DM you.'}</small>
          {!pasting ? <button type="button" className="slack-paste-toggle" onClick={() => setPasting(true)}>Paste a token instead</button> : null}
        </div>
      ) : null}
      {!prefs.oauth || pasting ? (
        <>
          <div className="slack-card-token">
            <input
              type="password"
              placeholder={connected ? 'Replace the bot token (xoxb-…)' : 'Bot token (xoxb-…)'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="button" disabled={!token.trim()} onClick={() => { save({ botToken: token.trim() }); setToken(''); }}>
              {connected ? 'Replace' : 'Connect'}
            </button>
          </div>
          <small className="slack-card-help">One token covers the whole workspace: api.slack.com/apps → your Supreme app → OAuth &amp; Permissions → Bot User OAuth Token. Teammates on your shared projects get it through you.</small>
        </>
      ) : null}
      {/* @Supreme in Slack (2026-09-16): the app-level token opens the
          socket the mentions arrive on; the line under it says whether
          Supreme is listening. */}
      {connected ? (
        <>
          <div className="slack-card-token" data-slack-app-token>
            <input
              type="password"
              placeholder={prefs.appToken === 'set' ? 'Replace the app token (xapp-…)' : 'App token (xapp-…), for @Supreme in Slack'}
              value={appToken}
              onChange={(event) => setAppToken(event.target.value)}
            />
            <button type="button" disabled={!appToken.trim()} onClick={() => { save({ appToken: appToken.trim() }); setAppToken(''); }}>
              {prefs.appToken === 'set' ? 'Replace' : 'Listen'}
            </button>
          </div>
          <small className="slack-card-help" data-slack-listening={prefs.listening?.state || 'off'}>
            {prefs.appToken !== 'set'
              ? 'With an app token, @Supreme in any channel sends the message to the tab you name. api.slack.com/apps → your Supreme app → Basic Information → App-Level Tokens, scope connections:write; Socket Mode on, the bot subscribed to app_mention.'
              : prefs.listening?.state === 'listening'
                ? 'Listening. Mention @Supreme in Slack and the answer comes back in the same thread. Name an existing tab to use its context.'
                : prefs.listening?.state === 'connecting'
                  ? 'Connecting to Slack…'
                  : `Not listening${prefs.listening?.error ? ` (${prefs.listening.error})` : ''}. It retries on its own; check the app token and that Socket Mode is on.`}
          </small>
        </>
      ) : null}
      <div className="slack-card-prefs">
        <label><input type="checkbox" checked={prefs.startNewThreads} onChange={(event) => save({ startNewThreads: event.target.checked })} />New Slack requests start their own Supreme thread</label>
        <label><input type="checkbox" checked={prefs.notifyMentions} onChange={(event) => save({ notifyMentions: event.target.checked })} />@mentions DM the person</label>
        <label><input type="checkbox" checked={prefs.notifyCompleted} onChange={(event) => save({ notifyCompleted: event.target.checked })} />Finished runs DM me</label>
        <label><input type="checkbox" checked={prefs.notifyFailures} onChange={(event) => save({ notifyFailures: event.target.checked })} />Failed runs DM me</label>
        <label className="slack-self-email">DM me at
          <input
            type="email"
            placeholder="your Slack email, if different"
            value={selfEmail}
            onChange={(event) => setSelfEmail(event.target.value)}
            onBlur={() => { if ((prefs.selfEmail || '') !== selfEmail.trim().toLowerCase()) save({ selfEmail: selfEmail.trim().toLowerCase() }); }}
            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
          />
        </label>
        <label className="slack-threshold">Quiet under
          <input
            type="number"
            min={0}
            value={prefs.minRunSeconds}
            onChange={(event) => save({ minRunSeconds: Math.max(0, Number(event.target.value) || 0) })}
          />
          seconds
        </label>
      </div>
    </section>
  );
}

export function ConnectorsView() {
  const s = useApp();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!s.connectorsOverview && !s.connectorsOverviewLoading) void loadConnectorsOverview();
  }, []);
  const overview = s.connectorsOverview;
  const needle = query.trim().toLowerCase();
  const matches = (row: ConnectorRow) => !needle || row.name.toLowerCase().includes(needle) || row.names.some((name) => name.toLowerCase().includes(needle));
  const mostUsed = (overview?.mostUsed || []).filter(matches);
  const rest = (overview?.rest || []).filter(matches);
  const busy = s.connectorsOverviewLoading;

  return (
    <>
      <TopBar><span className="crumb">Connectors</span><i /></TopBar>
      <main className="platform-context-overview connectors-page">
        <header className="connectors-head">
          <div>
            <h1>Connectors</h1>
            <p>Everything Supreme can reach, and which model reaches it.</p>
          </div>
          <div className="connectors-refresh">
            <small>{busy ? 'Checking…' : checkedLine(overview?.checkedAt || null)}</small>
            <button type="button" disabled={busy} title="Re-ask Claude and ChatGPT for connectors, right now" onClick={() => void refreshConnectorsOverview()}>
              <Icon name="refresh" size={13} />{busy ? 'Checking Claude and ChatGPT…' : 'Refresh'}
            </button>
          </div>
        </header>
        <SlackCard />
        <label className="platform-context-search">
          <Icon name="sparkles" size={13} />
          <input aria-label="Search connectors" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search connectors" />
        </label>
        {mostUsed.length ? (
          <section className="connectors-group">
            <h2>Most used</h2>
            <div className="platform-context-tools connectors-list">{mostUsed.map((row) => <Row key={row.key} row={row} />)}</div>
          </section>
        ) : null}
        {rest.length ? (
          <section className="connectors-group">
            <h2>{mostUsed.length ? 'Everything else' : 'All connectors'}</h2>
            <div className="platform-context-tools connectors-list">{rest.map((row) => <Row key={row.key} row={row} />)}</div>
          </section>
        ) : null}
        {overview && !mostUsed.length && !rest.length ? (
          <div className="platform-context-empty">{needle ? 'No connectors match that search.' : 'No connectors yet. Add some in Claude or ChatGPT, then Refresh.'}</div>
        ) : null}
        {!overview && busy ? <div className="platform-context-loading">Checking Claude and ChatGPT…</div> : null}
        <p className="connectors-foot">
          Add connectors in <a onClick={() => void openConnectorSettings('claude')}>claude.ai</a> or the <a onClick={() => void openConnectorSettings('codex')}>ChatGPT app</a>, then Refresh. Use counts start from what each model already had on this Mac and grow with every turn a connector takes part in.
        </p>
      </main>
    </>
  );
}
