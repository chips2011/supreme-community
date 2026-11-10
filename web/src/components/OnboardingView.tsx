import { useEffect, useState, type ReactNode } from 'react';
import { useApp, type OnboardingProvider, type OnboardingRead } from '../store';
import {
  answerOnboarding,
  completeWorkbenchSignIn,
  connectProvider,
  continueToDirections,
  continueToGreeting,
  installOnboardingProvider,
  navigate,
  openConnectorSettings,
  pollOnboardingRead,
  refreshStatus,
  selectOnboardingProvider,
  setOnboardingLabScenario,
  startOnboardingDirection,
  submitOnboardingLinkedIn,
  verifyOnboardingModel,
} from '../actions';
import type { ProviderStatus } from '../types';
import { CompanyLogo, SupremeMark } from './CompanyLogo';

// Paper section 14. One connection, one read, one choice: connect the account
// they already use, add their LinkedIn, say hello and check the read, then
// two directions. The platform is not visible until they pick one.

const PROVIDER_COPY: Record<OnboardingProvider, { name: string; carries: string }> = {
  codex: { name: 'ChatGPT', carries: 'Conversations, projects, memory, connected tools' },
  claude: { name: 'Claude', carries: 'Conversations, projects, skills' },
};

function SetupFrame({ step, label, title, status = 'Waiting on you', action, children }: { step: 1 | 2; label: string; title: string; status?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="setup-card" aria-labelledby="onboarding-title">
      <header className="onboarding-run-header">
        <span className="onboarding-run-icon" aria-hidden="true"><i /></span>
        <div>
          <small>{label}</small>
          <h1 id="onboarding-title">{title}</h1>
        </div>
        <time>{step} of 2</time>
      </header>
      <div className="onboarding-run-content">{children}</div>
      <footer>{status}{action ? <span className="setup-footer-action">{action}</span> : null}</footer>
    </section>
  );
}

function LabBar() {
  const s = useApp();
  const lab = s.status?.onboardingLab;
  if (!lab?.enabled) return null;
  return (
    <aside className="onboarding-lab" aria-label="Fake user controls">
      <span><i />Fake user</span>
      <label>
        Scenario
        <select value={lab.scenario} onChange={(event) => { void setOnboardingLabScenario(event.target.value); }}>
          {lab.scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => { void setOnboardingLabScenario(lab.scenario); }}>Start over</button>
    </aside>
  );
}

function SignInStep() {
  return (
    <section className="signin-card" aria-labelledby="fake-signin-title">
      <SupremeMark size={27} />
      <h1 id="fake-signin-title">Sign in to Supreme</h1>
      <button className="google-signin" type="button" onClick={() => completeWorkbenchSignIn('friend@example.com')}><span>G</span>Continue with Google</button>
    </section>
  );
}

// The row says what comes across, not what the tool is. This is the account,
// not the CLI: the point is inheriting months of history.
function providerDetail(provider: OnboardingProvider, status: ProviderStatus | undefined): string {
  if (!status?.installed || !status.authenticated) return PROVIDER_COPY[provider].carries;
  const plan = status.plan ? `${status.plan.charAt(0).toUpperCase()}${status.plan.slice(1)}` : '';
  return [status.email, plan].filter(Boolean).join(' · ') || 'Signed in';
}

// The install can take minutes; a staged label with a running clock keeps it
// from reading as a hang.
function installDetail(status: ProviderStatus | undefined): string | null {
  const install = status?.install;
  if (!install) return null;
  if (install.error) return install.error;
  const totalSeconds = Math.max(0, Math.floor((install.elapsedMs || 0) / 1_000));
  const clock = totalSeconds < 60 ? `${totalSeconds}s` : `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  const phase = install.phase === 'installing' ? 'Installing'
    : install.phase === 'finishing' ? 'Finishing up'
      : 'Downloading';
  return [`${phase}… ${clock}`, install.note ? install.note.slice(0, 60) : ''].filter(Boolean).join(' · ');
}

function ModelCard({ provider }: { provider: OnboardingProvider }) {
  const s = useApp();
  const status = s.status?.providers[provider];
  const verified = s.onboarding.verifiedProviders.includes(provider);
  const checking = s.onboardingCheckingProvider === provider;
  const installing = !!s.installingProviders[provider];
  const connecting = !!s.connectingProviders[provider];
  const selected = s.onboarding.selectedProvider === provider;
  const copy = PROVIDER_COPY[provider];
  const action = !status?.installed ? (
    <button className="onboarding-row-action" type="button" disabled={installing} onClick={() => { selectOnboardingProvider(provider); void installOnboardingProvider(provider); }}>{installing ? 'Installing' : 'Sign in'}</button>
  ) : !status.authenticated ? (
    <button className="onboarding-row-action" type="button" disabled={connecting} onClick={() => { selectOnboardingProvider(provider); void connectProvider(provider); }}>
      {connecting ? 'Finish sign-in' : 'Sign in'}
    </button>
  ) : (
    <button className="onboarding-row-action primary" type="button" disabled={checking} onClick={() => { selectOnboardingProvider(provider); void verifyOnboardingModel(provider); }}>
      {checking ? 'Checking' : verified ? 'Continue' : 'Check'}
    </button>
  );
  return (
    <div className={`onboarding-model ${selected ? 'selected' : ''} ${verified ? 'ready' : ''}`}>
      <CompanyLogo company={provider} size={25} />
      <div>
        <b>{copy.name}{provider === 'codex' ? <em>Recommended</em> : null}</b>
        <small>{connecting ? `Finish signing in to ${copy.name}` : (installing || status?.install ? installDetail(status) || 'Installing…' : providerDetail(provider, status))}</small>
      </div>
      {verified ? <span className="onboarding-state ready">Ready</span> : null}
      {action}
    </div>
  );
}

function ModelsStep() {
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshStatus(); }, 3_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <SetupFrame step={1} label="Model" title="Connect what you already use">
      <div className="onboarding-models">
        <ModelCard provider="codex" />
        <ModelCard provider="claude" />
      </div>
    </SetupFrame>
  );
}

function CheckRow({ passed, waiting, label, value }: { passed?: boolean; waiting?: boolean; label: string; value: string }) {
  return (
    <div className={`chrome-check-row ${passed ? 'passed' : waiting ? 'waiting' : 'failed'}`}>
      <i aria-hidden="true" />
      <span>{label}</span>
      <em>{value}</em>
    </div>
  );
}

// One action next to the LinkedIn paste: connect Gmail so the read can see
// the last couple of months of sent mail — the one signal that shows how the
// user writes to people, not to a model. Optional; the read skips it cleanly.
function GmailRow() {
  const s = useApp();
  const provider = s.onboarding.selectedProvider || 'claude';
  const connected = s.connectors.some((connector) => /^gmail$/i.test(connector.name) && connector.connected);
  return (
    <div className="onboarding-gmail">
      <div className={`onboarding-model ${connected ? 'ready' : ''}`}>
        <span className="gmail-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.2" />
            <path d="m4.6 7.8 7.4 5.7 7.4-5.7" />
          </svg>
        </span>
        <div>
          <b>Gmail</b>
          <small>{connected ? 'Connected. Your sent mail joins the read.' : 'Your sent mail shows how you write. I read the last couple of months, nothing else.'}</small>
        </div>
        {connected
          ? <span className="onboarding-state ready">Ready</span>
          : <button className="onboarding-row-action" type="button" onClick={() => { void openConnectorSettings(provider, 'Gmail'); }}>Connect Gmail</button>}
      </div>
    </div>
  );
}

// 14.3 / 14.4. One paste field, then the resolved profile as check rows.
// Replaces the persona picker: what someone has actually done beats what
// they would pick from a list.
function LinkedInStep() {
  const s = useApp();
  const [url, setUrl] = useState(s.onboarding.linkedinUrl || '');
  const profile = s.onboarding.profile;
  const busy = s.onboardingLinkedInBusy;
  const error = s.onboarding.chromeError;
  const shortUrl = (value: string) => value.replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '');
  const canRead = /linkedin\.com\/in\//i.test(url) && !busy;
  const submit = () => { if (canRead) void submitOnboardingLinkedIn(url.trim()); };
  return (
    <SetupFrame
      step={2}
      label="LinkedIn"
      title="Add your LinkedIn"
      status={profile ? 'Ready' : 'Waiting on you'}
      action={profile
        ? <button className="on-btn primary" type="button" onClick={() => { void continueToGreeting(); }}>Continue</button>
        : <button className="on-btn primary" type="button" disabled={!canRead} onClick={submit}>{busy ? 'Reading profile' : 'Read profile'}</button>}
    >
      <div className="linkedin-paste">
        <input
          aria-label="Your LinkedIn profile link"
          placeholder="linkedin.com/in/yourname"
          value={url}
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
        />
      </div>
      <div className="chrome-checks">
        <CheckRow passed={!!url && /linkedin\.com\/in\//i.test(url)} waiting={!url} label="Profile" value={url ? shortUrl(url) : 'paste your link'} />
        <CheckRow passed={!!profile} waiting={!profile && (busy || !!url)} label="Match" value={profile ? `${profile.name}${profile.role || profile.headline ? `, ${profile.role || profile.headline}` : ''}${profile.company ? ` at ${profile.company}` : ''}` : busy ? 'reading' : 'waiting'} />
        <CheckRow passed={!!profile} waiting={!profile} label="Work history" value={profile ? 'read' : 'ready to read'} />
      </div>
      <GmailRow />
      {error ? <div className="onboarding-callout error" role="alert">{error}</div> : null}
      {!profile ? (
        <button type="button" className="onboarding-skip" onClick={() => { void continueToGreeting(); }}>Carry on without LinkedIn</button>
      ) : null}
    </SetupFrame>
  );
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function sourcesLine(sources: { prompts: number; sentEmails: number; transcripts: number } | undefined): string {
  if (!sources) return '';
  const parts = [];
  if (sources.sentEmails) parts.push(`${sources.sentEmails} sent emails`);
  if (sources.transcripts) parts.push(`${sources.transcripts} transcripts`);
  if (sources.prompts) parts.push(`${sources.prompts} requests you typed`);
  return parts.join(', ');
}

// 14.5 + 14.6 + 14.7 on one screen. The moment the profile resolves, say
// hello, ask the one question, offer the areas, check the voice. Nothing here
// is required: Go on then moves on, and so does saying nothing.
function GreetingStep() {
  const s = useApp();
  const { profile, answers } = s.onboarding;
  // A correction re-reads. Keep the last good read on screen while that runs
  // instead of collapsing the page: a live re-read can take half a minute.
  const [held, setHeld] = useState<OnboardingRead | null>(s.onboarding.read?.status === 'ready' ? s.onboarding.read : null);
  useEffect(() => { if (s.onboarding.read?.status === 'ready') setHeld(s.onboarding.read); }, [s.onboarding.read]);
  const read = s.onboarding.read?.status === 'ready' ? s.onboarding.read : held;
  const reading = !read && s.onboarding.read?.status !== 'failed';
  const rereading = !!held && s.onboarding.read?.status === 'reading';
  const [roleNote, setRoleNote] = useState(answers.roleNote);
  const [somethingElse, setSomethingElse] = useState(answers.somethingElse);
  const [voiceNote, setVoiceNote] = useState(answers.voiceNote);
  const [notQuite, setNotQuite] = useState(answers.role === 'not-quite');
  const [addingArea, setAddingArea] = useState(!!answers.somethingElse);
  useEffect(() => { void pollOnboardingRead(); }, []);
  const areas = read?.areas || [];
  const chosen = answers.areas.length ? answers.areas : areas.filter((area) => area.preselected).map((area) => area.label);
  const toggleArea = (label: string) => {
    const next = chosen.includes(label) ? chosen.filter((item) => item !== label) : [...chosen, label];
    void answerOnboarding({ areas: next });
  };
  const first = profile?.firstName || profile?.name?.split(' ')[0] || '';
  return (
    <section className="greeting" aria-labelledby="greeting-title">
      <div className="greeting-who">
        <span className="greeting-avatar" aria-hidden="true">{profile?.photoUrl ? <img src={profile.photoUrl} alt="" /> : profile?.name ? initials(profile.name) : ((s.onboarding.email || '').trim().charAt(0).toUpperCase() || '·')}</span>
        <div>
          <small>{profile ? 'from your LinkedIn' : 'no LinkedIn yet'}</small>
          <b>{profile ? [profile.name, profile.location].filter(Boolean).join(', ') : 'Reading what is on this Mac instead'}</b>
        </div>
      </div>
      <h1 id="greeting-title">{first ? `Good to catch you, ${first}.` : 'Good to catch you.'}</h1>
      {reading ? (
        <p className="quiet">{profile ? `${profile.headline || profile.role || ''}${profile.company && !(profile.headline || '').includes(profile.company) ? ` at ${profile.company}` : ''}. ` : ''}Still reading what you have been up to. This fills in as it lands.</p>
      ) : (
        <>
          <p className="lead">{read?.roleLine || (s.onboarding.read?.status === 'failed' ? 'I could not read much on this Mac yet. Go on then and we will work it out as we go.' : 'Here is what looks like it takes up most of your week.')}</p>
          {rereading ? <p className="quiet rereading">Rereading with that in mind.</p> : null}
          {read?.roleLine ? (
            <div className="greeting-row">
              <button type="button" className={`pill ${answers.role === 'right' ? 'on' : ''}`} onClick={() => { setNotQuite(false); void answerOnboarding({ role: 'right', roleNote: '' }); }}>That is right</button>
              <button type="button" className={`pill ${answers.role === 'not-quite' ? 'on' : ''}`} onClick={() => { setNotQuite(true); void answerOnboarding({ role: 'not-quite' }); }}>Not quite</button>
              {notQuite ? (
                <input
                  className="own"
                  aria-label="What I should have said"
                  placeholder="what should I have said?"
                  value={roleNote}
                  onChange={(event) => setRoleNote(event.target.value)}
                  onBlur={() => { if (roleNote.trim() !== answers.roleNote) void answerOnboarding({ role: 'not-quite', roleNote: roleNote.trim() }, { reread: !!roleNote.trim() }); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur(); }}
                />
              ) : null}
            </div>
          ) : null}
          {areas.length ? (
            <div className="greeting-row">
              {areas.map((area) => (
                <button key={area.label} type="button" className={`pill ${chosen.includes(area.label) ? 'on' : ''}`} title={area.evidence} onClick={() => toggleArea(area.label)}>{area.label}</button>
              ))}
              {addingArea ? (
                <input
                  className="own"
                  aria-label="Something else"
                  placeholder="something else"
                  value={somethingElse}
                  onChange={(event) => setSomethingElse(event.target.value)}
                  onBlur={() => { if (somethingElse.trim() !== answers.somethingElse) void answerOnboarding({ somethingElse: somethingElse.trim() }); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur(); }}
                />
              ) : (
                <button type="button" className="pill" onClick={() => setAddingArea(true)}>Something else</button>
              )}
            </div>
          ) : null}
          {read?.thin && read.gap ? <p className="quiet">{read.gap}</p> : null}
          {read?.voice?.summary ? (
            <>
              <hr />
              <h2>And this is roughly how you sound</h2>
              <p className="lead voice">{answers.voice === 'own' && answers.voiceNote ? answers.voiceNote : read.voice.summary}</p>
              {sourcesLine(read.voice.sources) ? <span className="sources">{sourcesLine(read.voice.sources)}</span> : null}
              <div className="greeting-row">
                <button type="button" className={`pill ${answers.voice === 'me' ? 'on' : ''}`} onClick={() => void answerOnboarding({ voice: 'me', voiceNote: '' })}>That is me</button>
                <input
                  className="own"
                  aria-label="Tell me in your own words"
                  placeholder="or tell me in your own words"
                  value={voiceNote}
                  onChange={(event) => setVoiceNote(event.target.value)}
                  onBlur={() => { if (voiceNote.trim() && voiceNote.trim() !== answers.voiceNote) void answerOnboarding({ voice: 'own', voiceNote: voiceNote.trim() }); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur(); }}
                />
              </div>
            </>
          ) : null}
        </>
      )}
      <div className="go">
        <button type="button" className="on-btn primary" onClick={() => continueToDirections()}>Go on then</button>
        <small>or say nothing and let it run with what it has</small>
      </div>
    </section>
  );
}

// 14.8. Still onboarding: the platform is not visible until they pick one.
function DirectionsStep() {
  const s = useApp();
  const read = s.onboarding.read;
  const reading = !read || read.status === 'reading';
  const directions = read?.directions || [];
  const [custom, setCustom] = useState('');
  const [asking, setAsking] = useState(false);
  const busy = s.onboardingStarting;
  useEffect(() => { if (reading) void pollOnboardingRead(); }, [reading]);
  return (
    <section className="directions" aria-labelledby="directions-title">
      <p className="stance">You set direction. I take the big things, not the errands.</p>
      {read?.thin && read.gap ? <p className="quiet">{read.gap}</p> : null}
      <div className="direction-card">
        <header>
          <i aria-hidden="true" />
          <div><small>Where to start</small><b id="directions-title">How I could make you faster</b></div>
          <em>pick one</em>
        </header>
        {reading ? (
          <div className="direction-row"><div><b>Still reading</b><small>The two directions land as soon as the read does. You can name one below in the meantime.</small></div></div>
        ) : directions.map((direction, index) => (
          <div className="direction-row" key={direction.title}>
            <div>
              <b>{direction.title}</b>
              <small>{direction.detail}{direction.needs?.length ? <> <span className="needs">· needs {direction.needs.join(', ')}</span></> : null}</small>
            </div>
            <button type="button" className={`on-btn ${index === 0 ? 'primary' : ''}`} disabled={busy || !direction.prompt} onClick={() => void startOnboardingDirection({ direction: index })}>{busy ? 'Starting' : 'Start here'}</button>
          </div>
        ))}
        <footer>
          {asking ? (
            <>
              <input
                className="own"
                aria-label="The right task"
                placeholder="What should I pick up instead?"
                value={custom}
                autoFocus
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && custom.trim()) void startOnboardingDirection({ custom: custom.trim() }); }}
              />
              <button type="button" className="on-btn primary" disabled={busy || !custom.trim()} onClick={() => void startOnboardingDirection({ custom: custom.trim() })}>{busy ? 'Starting' : 'Go again'}</button>
            </>
          ) : (
            <>
              <small>Not the exact task?</small>
              <button type="button" className="on-btn" onClick={() => setAsking(true)}>Tell me the right one</button>
            </>
          )}
        </footer>
      </div>
    </section>
  );
}

function CompleteStep() {
  return (
    <section className="onboarding-complete" aria-labelledby="onboarding-complete-title">
      <SupremeMark size={30} />
      <h1 id="onboarding-complete-title">Supreme is ready.</h1>
      <button className="onboarding-primary" type="button" onClick={() => navigate('home')}>Open Supreme</button>
    </section>
  );
}

export function OnboardingView() {
  const s = useApp();
  const step = s.onboarding.step;
  return (
    <main className="onboarding-shell">
      <LabBar />
      <section className="onboarding-window">
        <header className="onboarding-titlebar"><span>Supreme</span></header>
        <div className={`onboarding-stage onboarding-stage-${step}`}>
          {step === 'signin' ? <SignInStep /> : null}
          {step === 'models' ? <ModelsStep /> : null}
          {step === 'linkedin' ? <LinkedInStep /> : null}
          {step === 'greeting' ? <GreetingStep /> : null}
          {step === 'directions' ? <DirectionsStep /> : null}
          {step === 'complete' ? <CompleteStep /> : null}
        </div>
      </section>
    </main>
  );
}
