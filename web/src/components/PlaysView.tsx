import { useEffect, useState } from 'react';
import { useApp, projectLabel } from '../store';
import { TopBar } from './bits';
import { PlayPanel } from './PlayPanel';
import { loadPlays, openPlay } from '../actions';

// Paper 17.3: the Plays page. Things you have taught Supreme to do the same
// way every time; click one to read it or change it in the same panel the
// thread uses. There is no other editor and nothing here runs on its own.
export function PlaysView() {
  const s = useApp();
  const [query, setQuery] = useState('');
  useEffect(() => { if (!s.playsLoaded) void loadPlays(); }, []);
  const panel = s.playPanels.page;
  const needle = query.trim().toLowerCase();
  const rows = s.plays.filter((play) => !needle || `${play.name} ${play.useWhen} ${play.repoName || ''}`.toLowerCase().includes(needle));

  return (
    <>
      <TopBar><span className="crumb">Plays</span><i /></TopBar>
      <div className="plays-split">
        <main className="plays-page">
          <header className="plays-head">
            <div>
              <h1>Plays</h1>
              <p>Things you have taught Supreme to do the same way every time. Click one to read it or change it.</p>
            </div>
            <input aria-label="Search plays" placeholder="Search plays" value={query} onChange={(event) => setQuery(event.target.value)} />
          </header>
          {rows.length ? (
            <div className="plays-list">
              {rows.map((play) => (
                <button type="button" key={play.id} className={`play-row${panel?.open && panel.playId === play.id ? ' sel' : ''}`} onClick={() => openPlay('page', play.id)}>
                  <u />
                  <b>{play.name}</b>
                  <span>{play.useWhen ? `when ${play.useWhen}` : play.steps.length ? `${play.steps.length} rules` : 'no rules yet'}</span>
                  <em>{play.repo ? projectLabel(play.repo, play.repoName || undefined) : play.repoName || ''}</em>
                </button>
              ))}
            </div>
          ) : (
            <div className="plays-empty">
              {s.playsLoaded
                ? (needle ? 'No plays match that search.' : 'No plays yet. When a thread has gone well, press ⚡ at the end of its tab strip and Supreme will write it up.')
                : 'Loading…'}
            </div>
          )}
        </main>
        {panel?.open ? <PlayPanel panelKey="page" modelId={s.homeModel} /> : null}
      </div>
    </>
  );
}
