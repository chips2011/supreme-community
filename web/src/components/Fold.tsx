import { useState } from 'react';
import { Icon } from '../icons';
import type { Fold } from '../types';

// Paper 12.2 to 12.4: the one surface auto-contextualize has. A hairline in
// the thread where the folded messages end, saying what happened; behind it,
// the summary the model now reads, with the facts it kept. A fact the check
// replaced shows the source's own words and says so.
// Board 12.6: one notice for the one event both features cause, a fresh
// provider session on the next send. Composed as cause, then what carries
// over, then cost, so no combination can lie: a model switch names itself,
// otherwise "Fresh session"; a tab with a fold carries the summary and
// recent messages, otherwise its transcript; either way one slower turn.
// The glyph follows the cause. Quiet on purpose, gone when that turn lands.
export function SessionNotice({ cause, folded }: { cause: string | null; folded: boolean }) {
  const carries = folded ? 'the summary and recent messages carry over' : 'this tab’s transcript carries over';
  return (
    <div className={`comp-notice ${cause ? 'model' : 'fold'}`} role="status">
      <span className="notice-glyph" aria-hidden>{cause ? <Icon name="arrowRight" size={13} /> : '\u2261'}</span>
      <span className="notice-text">{cause || 'Fresh session'} on next send, {carries}, one slower turn.</span>
    </div>
  );
}

export function FoldMark({ fold, onUnfold }: { fold: Fold; onUnfold: () => void }) {
  const [open, setOpen] = useState(false);
  const count = fold.count;
  return (
    <div className={`fold-mark${open ? ' open' : ''}`} data-fold={fold.id} data-fold-count={count}>
      <button type="button" className="fold-line" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="fold-glyph" aria-hidden>{'\u2261'}</span>
        <span className="fold-text">Summarized {count} earlier {count === 1 ? 'message' : 'messages'}</span>
        <i />
      </button>
      {open ? (
        <div className="fold-summary">
          <p>{fold.narrative}</p>
          {fold.facts.length ? (
            <ul>
              {fold.facts.map((fact, index) => (
                <li key={`${fold.id}-${index}`} className={fact.verbatim ? 'verbatim' : fact.verified === false ? 'unverified' : ''}>
                  {fact.text}
                  {fact.verbatim ? <small>kept in the original words</small> : fact.verified === false ? <small>source not found</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="fold-undo" onClick={onUnfold}>Bring the messages back</button>
        </div>
      ) : null}
    </div>
  );
}
