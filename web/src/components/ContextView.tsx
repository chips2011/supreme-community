import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../store';
import {
  closePlatformContext,
  dismissPlatformContextSuggestions,
  loadPlatformContexts,
  lockPlatformContext,
  openPlatformContext,
  stagePlatformContextHistory,
  stagePlatformContextSuggestions,
  stopPlatformContextRun,
  submitPlatformContext,
  togglePlatformContextExamples,
  updatePlatformContextDraft,
} from '../actions';
import { Icon } from '../icons';
import { WorkNotes } from '../lib/writtenText';
import { TopBar } from './bits';
import { ContextualUserTurn } from './TerminalContext';
import { RunCard, hasRunActivity } from './RunCard';
import type { PlatformContextDetail, PlatformContextEntry, PlatformContextMessage } from '../types';

function AssistantMark({ saved = false }: { saved?: boolean }) {
  return <span aria-hidden="true" className={`context-assistant-mark${saved ? ' saved' : ''}`}>{saved ? <Icon name="check" size={13} /> : 'S'}</span>;
}

function EntryList({ entries }: { entries: PlatformContextEntry[] }) {
  return (
    <div className="platform-context-entries">
      {entries.map((entry) => (
        <div className="platform-context-entry" key={entry.id}><span /> <p>{entry.text}</p></div>
      ))}
    </div>
  );
}

function SourceReceipt({ detail }: { detail: PlatformContextDetail }) {
  const s = useApp();
  const source = detail.draftSource;
  if (source?.kind !== 'history') return null;
  const count = source.exampleCount;
  const examples = source.examples || [];
  return (
    <section className="platform-context-source" aria-label="Context source">
      <div>
        <span className="context-source-mark">{detail.mark}</span>
        <b>{source.label}</b>
        <small>{count == null ? 'Examples reviewed' : `${count} historical ${count === 1 ? 'example' : 'examples'}`}</small>
        {examples.length ? (
          <button type="button" onClick={togglePlatformContextExamples}>
            {s.contextConcierge.showExamples ? 'Hide examples' : `View ${count ?? examples.length} examples`}
          </button>
        ) : null}
      </div>
      {s.contextConcierge.showExamples && examples.length ? (
        <div className="platform-context-examples">
          {examples.map((example, index) => (
            <div key={example.id}>
              <em>{index + 1}</em>
              <p>{example.excerpt}</p>
              {example.url ? <a href={example.url} target="_blank" rel="noreferrer">Open</a> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SavedState({ detail, justSaved }: { detail: PlatformContextDetail; justSaved: boolean }) {
  const count = detail.entries.length;
  const sourceCount = detail.source?.exampleCount;
  return (
    <div className="platform-context-saved-state">
      <div className="context-assistant-row">
        <AssistantMark saved={justSaved} />
        <div>
          <h2>{justSaved ? `${detail.name} context saved` : `This is the context Supreme uses with ${detail.name}.`}</h2>
          {justSaved ? (
            <p>{detail.source?.kind === 'history' && sourceCount != null
              ? `Saved from ${sourceCount} ${detail.name} ${sourceCount === 1 ? 'example' : 'examples'}. Supreme will use these entries whenever it uses ${detail.name}.`
              : `Supreme will use these ${count === 1 ? 'entry' : 'entries'} whenever it uses ${detail.name}.`}</p>
          ) : null}
        </div>
      </div>
      <EntryList entries={detail.entries} />
      <div className="context-saved-followup">
        {justSaved
          ? `I’ll keep using new ${detail.name} examples and suggest changes here.`
          : `Tell me what to change, or pull fresh examples from your history.`}
      </div>
      {!justSaved && detail.access?.ready ? (
        <button className="context-history-button" type="button" onClick={stagePlatformContextHistory}>
          <Icon name="refresh" size={12} /> Pull from History
        </button>
      ) : null}
    </div>
  );
}

function ContextMessage({ message }: { message: PlatformContextMessage }) {
  if (message.role === 'user') return <ContextualUserTurn>{message.content}</ContextualUserTurn>;
  return (
    <div className={`context-assistant-row context-message${message.kind === 'access' ? ' access' : ''}`}>
      <AssistantMark />
      <p>{message.content}</p>
    </div>
  );
}

function DraftState({ detail }: { detail: PlatformContextDetail }) {
  const s = useApp();
  const stream = s.contextConcierge.stream;
  const messages = detail.messages || [];
  const showStreamPrompt = !!stream && !messages.some((message) => message.role === 'user' && message.content === stream.prompt);
  const hasActivity = !!stream && hasRunActivity({ tools: stream.tools, computer: stream.computer, connectors: stream.connectors });
  return (
    <>
      <div className="context-assistant-row context-opening">
        <AssistantMark />
        <div>
          <h2>What should Supreme keep in mind when it uses {detail.name}?</h2>
          <p>{s.contextConcierge.historyStaged ? 'Add what Supreme should look for in your history.' : 'Tell me in your own words.'}</p>
          {!detail.draftEntries.length && !stream && detail.access?.ready ? (
            <button className="context-history-button" type="button" onClick={stagePlatformContextHistory}>
              <Icon name="refresh" size={12} /> Pull from History
            </button>
          ) : null}
        </div>
      </div>
      <div className="platform-context-messages">
        {messages.map((message) => <ContextMessage message={message} key={message.id} />)}
        {showStreamPrompt ? <ContextualUserTurn>{stream!.prompt}</ContextualUserTurn> : null}
      </div>
      {stream ? (
        <div className="context-live-run">
          <div className="context-assistant-row">
            <AssistantMark />
            <div className="context-running-copy">
              <b>{stream.model ? 'Working through your examples' : 'Preparing Context'}</b>
              <button type="button" onClick={() => void stopPlatformContextRun()}><kbd>Esc</kbd> to interrupt</button>
            </div>
          </div>
          <WorkNotes notes={stream.workNotes || []} live />
          {hasActivity ? (
            <RunCard
              tools={stream.tools}
              statusText={stream.statusText}
              error={stream.error}
              computer={stream.computer}
              connectors={stream.connectors}
            />
          ) : null}
        </div>
      ) : null}
      {!stream && detail.draftEntries.length ? (
        <div className="platform-context-draft">
          <SourceReceipt detail={detail} />
          <div className="context-draft-heading"><span>Updated. I would save:</span></div>
          <EntryList entries={detail.draftEntries} />
          <button className="context-lock-button" type="button" onClick={() => void lockPlatformContext()}>Lock in</button>
        </div>
      ) : null}
    </>
  );
}

function ContextComposer({ detail }: { detail: PlatformContextDetail }) {
  const s = useApp();
  const concierge = s.contextConcierge;
  const hasDraft = detail.draftEntries.length > 0;
  const hasSaved = detail.entries.length > 0 && !hasDraft;
  const placeholder = concierge.historyStaged
    ? `For example, replies to warm introductions`
    : hasDraft ? 'Reply with a change...'
      : hasSaved ? `Update ${detail.name} context...`
        : 'Tell Context what to learn...';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void submitPlatformContext();
  };
  return (
    <form className={`platform-context-composer${concierge.stream ? ' running' : ''}`} onSubmit={submit}>
      <textarea
        data-platform-context-composer
        aria-label={`${detail.name} Context message`}
        rows={2}
        value={concierge.draft}
        disabled={!!concierge.stream}
        placeholder={placeholder}
        onChange={(event) => updatePlatformContextDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            void submitPlatformContext();
          }
        }}
      />
      <footer>
        <span>in <b>{detail.name}</b></span>
        <button
          className={concierge.draft.trim() && !concierge.stream ? 'on' : ''}
          type="submit"
          disabled={!concierge.draft.trim() || !!concierge.stream}
          aria-label="Send Context message"
        >↑</button>
      </footer>
    </form>
  );
}

function SuggestionPanel({ detail }: { detail: PlatformContextDetail }) {
  const suggestions = detail.suggestions || [];
  return (
    <section className="platform-context-suggestion-panel" aria-label={`${detail.name} suggestions`}>
      <div className="context-assistant-row">
        <AssistantMark />
        <div>
          <h2>From recent {detail.name} work, I noticed {suggestions.length === 1 ? 'something' : `${suggestions.length} things`} worth saving.</h2>
          <p>Nothing changes until you review and lock it in.</p>
        </div>
      </div>
      <EntryList entries={suggestions} />
      <div className="context-suggestion-actions">
        <button className="context-lock-button" type="button" onClick={() => void stagePlatformContextSuggestions()}>Review as draft</button>
        <button className="context-history-button" type="button" onClick={() => void dismissPlatformContextSuggestions()}>Dismiss</button>
      </div>
    </section>
  );
}

function ContextDetailView({ detail }: { detail: PlatformContextDetail }) {
  const s = useApp();
  const savedOnly = detail.entries.length > 0
    && !detail.draftEntries.length
    && !s.contextConcierge.stream
    && !s.contextConcierge.historyStaged
    && !detail.messages.some((message) => message.at > (detail.savedAt || ''));
  return (
    <>
      <TopBar>
        <button className="context-back" type="button" onClick={closePlatformContext}>Context</button>
        <span className="crumb-separator">/</span>
        <span className="crumb">{detail.name}</span>
        {detail.entries.length ? <span className="context-saved-count">{detail.entries.length} saved</span> : null}
        <i />
      </TopBar>
      <main className="platform-context-chat ph-no-capture">
        <div className="platform-context-transcript">
          {savedOnly ? <SavedState detail={detail} justSaved={s.contextConcierge.justSaved} /> : <DraftState detail={detail} />}
          {detail.suggestions?.length && !detail.draftEntries.length && !s.contextConcierge.stream ? <SuggestionPanel detail={detail} /> : null}
          {s.contextConcierge.error ? <div className="platform-context-error" role="alert">{s.contextConcierge.error}</div> : null}
          <i className="context-chat-spacer" />
          <ContextComposer detail={detail} />
        </div>
      </main>
    </>
  );
}

function ContextOverview() {
  const s = useApp();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const platforms = s.contextConcierge.platforms.filter((platform) => !needle || `${platform.name} ${platform.access.label}`.toLowerCase().includes(needle));
  return (
    <>
      <TopBar><span className="crumb">Context</span><i /></TopBar>
      <main className="platform-context-overview">
        <header><h1>Context</h1><p>Choose a tool to add or update its context.</p></header>
        <label className="platform-context-search">
          <Icon name="sparkles" size={13} />
          <input aria-label="Search Context tools" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools" />
        </label>
        <div className="platform-context-tools">
          {platforms.map((platform) => (
            <button type="button" key={platform.key} onClick={() => void openPlatformContext(platform.key)}>
              <span className={`platform-context-mark ${platform.key}`}>{platform.mark}</span>
              <span><b>{platform.name}</b><small>{platform.savedCount ? `${platform.savedCount} saved ${platform.savedCount === 1 ? 'entry' : 'entries'}` : platform.draftCount ? `${platform.draftCount} draft ${platform.draftCount === 1 ? 'entry' : 'entries'}` : 'No saved context'}</small></span>
              {platform.hasSuggestions ? <em>suggested</em> : platform.savedCount ? <em>saved</em> : platform.draftCount ? <em>draft</em> : null}
              <Icon name="arrowRight" size={13} />
            </button>
          ))}
          {!platforms.length && !s.contextConcierge.loading ? <div className="platform-context-empty">No tools match that search.</div> : null}
        </div>
        {s.contextConcierge.loading ? <div className="platform-context-loading">Loading Context…</div> : null}
        {s.contextConcierge.error ? <div className="platform-context-error" role="alert">{s.contextConcierge.error}</div> : null}
      </main>
    </>
  );
}

export function ContextView() {
  const s = useApp();
  useEffect(() => {
    if (!s.contextConcierge.platforms.length && !s.contextConcierge.loading) void loadPlatformContexts();
  }, []);
  if (s.contextConcierge.selected) {
    if (s.contextConcierge.detail) return <ContextDetailView detail={s.contextConcierge.detail} />;
    return <><TopBar><span className="crumb">Context</span><i /></TopBar><main className="platform-context-loading">Loading Context…</main></>;
  }
  return <ContextOverview />;
}
