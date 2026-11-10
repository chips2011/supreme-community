import { useApp } from '../store';
import { attachTerminalContext } from '../actions';
import { Icon } from '../icons';

export function ContextPullPicker({ paneIdx }: { paneIdx: number }) {
  const s = useApp();
  const target = s.panes[paneIdx];
  const targetTask = target && s.cache[target.threadId];
  const targetTabId = target && (target.tabId || targetTask?.activeTab);
  const choices = s.panes.flatMap((pane, index) => {
    const task = s.cache[pane.threadId];
    const tabId = pane.tabId || task?.activeTab;
    const tab = task?.tabs?.find((candidate) => candidate.id === tabId);
    if (!task || !tab || index === paneIdx || (task.id === targetTask?.id && tab.id === targetTabId)) return [];
    return [{ pane: index, task, tab }];
  });

  return (
    <>
      <div className="hd">Pull context from →</div>
      <div className="pull-context-list">
        {choices.map(({ pane, task, tab }) => (
          <button className="pull-context-choice" key={`${pane}:${task.id}:${tab.id}`} onClick={() => attachTerminalContext(paneIdx, task.id, tab.id)}>
            <span><Icon name="fileText" size={13} /></span>
            <div><b>{tab.name}</b><small>{task.repoName} › {task.title}</small></div>
          </button>
        ))}
        {!choices.length ? <div className="split-empty">Open another pane to pull its context.</div> : null}
      </div>
    </>
  );
}
