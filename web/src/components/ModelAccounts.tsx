import { useApp } from '../store';
import { connectProvider, disconnectProvider, installOnboardingProvider } from '../actions';
import { CompanyLogo, type Company } from './CompanyLogo';

export type AccountProvider = 'claude' | 'codex' | 'grok';

const LABEL: Record<AccountProvider, string> = { claude: 'Claude', codex: 'ChatGPT', grok: 'Grok' };

function accountLine(provider: AccountProvider, email: string, plan: string): string {
  if (provider === 'grok') return email ? `${email} · signed in on the web` : 'Signed in on the web';
  const planLabel = plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : '';
  return [email, planLabel].filter(Boolean).join(' · ') || 'Connected on this Mac';
}

export function ModelAccountRow({ provider, onboarding = false }: { provider: AccountProvider; onboarding?: boolean }) {
  const s = useApp();
  const status = s.status?.providers[provider];
  const connected = provider === 'grok' ? !!status?.webConnected : !!status?.ready;
  const connecting = !!s.connectingProviders[provider];
  const installing = !!s.installingProviders[provider];
  const needsInstall = provider !== 'grok' && status?.installed === false;
  const email = status?.email || s.onboarding.email;
  const plan = status?.plan || '';
  return (
    <div className={`model-account-row ${connected ? 'connected' : ''}`}>
      <CompanyLogo company={provider as Company} size={22} />
      <div className="model-account-copy">
        <b>{LABEL[provider]}</b>
        {connected ? <small>{accountLine(provider, email, plan)}</small> : null}
      </div>
      {connected ? (
        onboarding ? <span className="model-connected-dot" aria-label="Connected" /> : (
          <button className="model-signout" disabled={connecting} onClick={() => disconnectProvider(provider)}>
            {connecting ? 'Disconnecting…' : provider === 'grok' ? 'Disconnect' : 'Sign out'}
          </button>
        )
      ) : (
        <button
          className="model-connect"
          disabled={connecting || installing}
          onClick={() => needsInstall
            ? installOnboardingProvider(provider)
            : connectProvider(provider)}
        >
          {installing
            ? 'Installing…'
            : needsInstall
              ? `Install ${provider === 'claude' ? 'Claude Code' : 'Codex'}`
              : connecting
                ? 'Finishing sign-in…'
                : provider === 'grok' ? 'Connect' : 'Sign in'}
        </button>
      )}
    </div>
  );
}
