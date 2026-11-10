import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useApp, projectLabel } from '../store';
import { landedDeck, landedKey } from '../lib/landed';
import { landedExit, landedSearch, landedShow } from '../actions';
import { toggleRail } from '../lib/ui';
import { Icon } from '../icons';

export function LandedHeader() {
  const s = useApp();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const { rows } = landedDeck();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = rows.filter((row) => {
    const label = `${projectLabel(row.thread.repo, row.thread.repoName)} ${row.thread.title} ${row.tab.name}`.toLocaleLowerCase();
    return words.every((word) => label.includes(word));
  });
  const active = Math.min(selected, Math.max(0, matches.length - 1));

  useEffect(() => {
    if (!s.landedSearchOpen) return;
    setQuery('');
    setSelected(0);
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!search.current?.contains(event.target as Node)) landedSearch(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [s.landedSearchOpen]);
  useEffect(() => {
    search.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const close = () => { landedSearch(false); toggle.current?.focus(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    // Buttons keep their own Enter/Space behavior; only the combobox owns
    // result selection. Options are reached through its arrow keys.
    if (event.target !== input.current) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))));
    }
    if (event.key === 'Enter' && matches[active]) { event.preventDefault(); void landedShow(landedKey(matches[active])); }
  };

  return (
    <div className="paneh landed-head">
      {!s.railOpen ? <button className="rail-toggle" aria-label="Show sidebar" onClick={toggleRail}><Icon name="panelLeft" size={16} /></button> : null}
      <span className="landed-title" data-landed-title>Landed</span><i />
      <div className="landed-search" ref={search}>
        <button ref={toggle} type="button" className="landed-tool" data-landed-search-toggle aria-expanded={s.landedSearchOpen} aria-controls="landed-search-panel" aria-keyshortcuts="/" onClick={() => landedSearch(!s.landedSearchOpen)}><Icon name="search" size={14} />Search<kbd>/</kbd></button>
        {s.landedSearchOpen ? (
          <div className="landed-search-panel" id="landed-search-panel" data-landed-search onKeyDown={onKey}>
            <label className="landed-search-input">
              <Icon name="search" size={15} />
              <input ref={input} role="combobox" aria-label="Search Landed" aria-expanded="true" aria-controls="landed-results" aria-activedescendant={matches[active] ? `landed-result-${landedKey(matches[active])}` : undefined} autoComplete="off" placeholder="Projects, workstreams, or tabs" value={query} onChange={(event) => { setQuery(event.target.value); setSelected(0); }} />
              <button type="button" aria-label="Close search" title="Close search (Escape)" onClick={close}><Icon name="x" size={14} /></button>
            </label>
            <div className="landed-search-results" id="landed-results" role="listbox" aria-label="Landed results">
              {matches.map((row, index) => <button type="button" role="option" tabIndex={-1} id={`landed-result-${landedKey(row)}`} aria-selected={index === active} className="landed-search-result" key={landedKey(row)} onClick={() => void landedShow(landedKey(row))}><span>{row.thread.title} / <b>{row.tab.name}</b></span><small>{projectLabel(row.thread.repo, row.thread.repoName)}</small></button>)}
              {!matches.length ? <div className="landed-search-empty" role="status">No matching results.</div> : null}
            </div>
          </div>
        ) : null}
      </div>
      <button type="button" className="landed-tool" data-landed-exit aria-keyshortcuts="Escape" title="Close Landed (Esc)" onClick={landedExit}>Close<kbd>Esc</kbd></button>
    </div>
  );
}
