import { useApp, state, set, projectLabel } from '../store';
import { Icon } from '../icons';
import { contextMatches } from '../lib/mention';
import { insertContextMention, newContextBlock } from '../actions';
import type { Task } from '../types';

// Ported from vanilla contextPanel(): project context drawer with search + Use.
export function ContextPanel({ task, idx }: { task: Task; idx: number }) {
  const s = useApp();
  const projectName = projectLabel(task.repo, task.repoName);
  const query = s.contextQuery[idx] || '';
  const items = contextMatches(task, query);
  return (
    <div className="context-panel">
      <div className="context-title">
        <div><h2>Project context</h2><p>Available to every workstream and model in {projectName}.</p></div>
        <button className="btn" onClick={() => newContextBlock(idx)}><Icon name="plus" size={13} /> New block</button>
      </div>
      <label className="context-search">
        <Icon name="sliders" size={14} />
        <input
          value={query}
          placeholder="Search context"
          onChange={(e) => { state.contextQuery[idx] = e.target.value; set(); }}
        />
      </label>
      <div className="context-list">
        {items.length ? items.map((item) => (
          <div key={item.id} className="context-row">
            <span className="context-icon"><Icon name={item.kind === 'block' ? 'fileText' : 'message'} size={15} /></span>
            <div><b>{item.name}</b><p>{item.desc}</p><small>{item.uses}</small></div>
            <button className="btn" onClick={() => insertContextMention(idx, item.name)}>Use</button>
          </div>
        )) : <div className="empty"><div className="sub">No context matches that search.</div></div>}
      </div>
    </div>
  );
}
