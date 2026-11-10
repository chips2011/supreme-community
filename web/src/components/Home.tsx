import { useApp, state, set, modelLabel } from '../store';
import { RECOMMENDED_MODEL } from '../constants';
import { Icon } from '../icons';
import { EffortBars } from '../lib/effort';
import { TopBar, ModelMark } from './bits';
import { openPop } from '../lib/ui';
import { addPastedImages, homeSend, removePendingImage } from '../actions';
import { ImageAttachments } from './ImageAttachments';

export function Home() {
  const s = useApp();
  const draft = s.drafts.home || '';
  const images = s.pendingImages.home || [];
  const proj = s.projects.find((p) => p.path === s.homeProject);
  const projLabel = proj ? proj.name : (s.projects.length ? 'Pick a project' : 'Add a project');

  return (
    <>
      <TopBar><i /></TopBar>
      <div className="hero">
        <div className="home-stack">
          <div className="c home-empty-copy">
            <div>Nothing open</div>
            <div className="sub">Pick a thread on the left, or start something here.</div>
          </div>
          <div className="comp home-composer">
            <ImageAttachments attachments={images} pending onRemove={(attachment) => removePendingImage('home', attachment.id)} />
            <textarea
              rows={2}
              placeholder="What do you need done?"
              data-draft="home"
              value={draft}
              onChange={(event) => { state.drafts.home = event.target.value; set(); }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => !!file);
                if (!files.length) return;
                event.preventDefault();
                void addPastedImages('home', files);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                  event.preventDefault();
                  void homeSend();
                }
              }}
            />
            <div className="bt">
              <button className="chip" onClick={(event) => openPop(event.currentTarget, 'homeproj')}>
                <Icon name="folder" size={12} /> {projLabel} <Icon name="chevronDown" size={11} />
              </button>
              <button
                className={`chip mdl ${s.homeModel === RECOMMENDED_MODEL.id ? 'recommended' : ''}`}
                onClick={(event) => openPop(event.currentTarget, 'homemodel')}
              >
                <ModelMark id={s.homeModel} />{modelLabel(s.homeModel)} <Icon name="chevronDown" size={11} />
              </button>
              <button className="chip" title="Connectors new threads can use" onClick={(event) => openPop(event.currentTarget, 'connectors')}>
                <Icon name="zap" size={12} /> Connectors
              </button>
              <button className="eff" onClick={(event) => openPop(event.currentTarget, 'effort')}>
                <EffortBars value={s.effort} /> {s.effort}
              </button>
              <i />
              <button className={`send ${draft.trim() || images.length ? 'on' : ''}`} type="button" aria-label="Send" title="Send" onClick={() => { void homeSend(); }}><Icon name="arrowUp" size={15} /></button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
