import { useEffect } from 'react';
import { useApp, draftKey } from '../store';
import { Icon } from '../icons';
import { insertPlayPick, loadPlays, playPickerQuery, playsMatching, resolvePlayCommand } from '../actions';

// Paper 17.4: /plays in the composer. Shows while the command is being typed;
// once a play's full name is in, it steps aside so the rest of the line can
// say what to apply it to.
export function PlayPicker({ idx }: { idx: number }) {
  const s = useApp();
  const draft = s.drafts[draftKey(idx)] || '';
  const query = playPickerQuery(draft);
  useEffect(() => { if (query !== null && !s.playsLoaded) void loadPlays(); }, [query !== null]);
  if (query === null) return null;
  const resolved = resolvePlayCommand(draft);
  if (resolved && resolved !== 'unknown') return null;
  const items = playsMatching(query);
  const selected = Math.min(Math.max(0, s.playPick[idx]?.selected || 0), Math.max(0, items.length - 1));
  return (
    <div className="mention-pop play-pop" role="listbox" aria-label="Run a play">
      <div className="mention-head">Run a play<span>{items.length}</span></div>
      {items.length ? items.map((play, index) => (
        <button
          key={play.id}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={`mention-item ${index === selected ? 'sel' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insertPlayPick(idx, play)}
        >
          <span><Icon name="zap" size={13} /></span>
          <div><b>{play.name}</b><p>{play.useWhen ? `when ${play.useWhen}` : `${play.steps.length} rules`} · {play.runs} {play.runs === 1 ? 'run' : 'runs'}</p></div>
        </button>
      )) : (
        <div className="mention-empty">{s.playsLoaded ? 'No plays yet. Press ⚡ at the end of a tab strip to find one in a thread.' : 'Loading plays…'}</div>
      )}
    </div>
  );
}
