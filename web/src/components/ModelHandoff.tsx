import { Icon } from '../icons';
import { modelLabel } from '../store';
import type { ModelHandoff, Provider } from '../types';
import { ModelMark } from './bits';

export function providerLabel(provider: Provider | null | undefined, model: string): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'GPT';
  if (provider === 'openrouter') return 'Open model';
  if (model.startsWith('gpt-')) return 'GPT';
  return model.startsWith('or:') ? 'Open model' : 'Claude';
}

// The cause clause of the composer's session notice (Fold.tsx) when a model
// switch is pending. Always the models: the user picked a model from the
// chip below, never a provider, and one rule is easier to keep true than two.
export function modelSwitchCause(fromModel: string, toModel: string): string {
  return `${modelLabel(fromModel)} → ${modelLabel(toModel)}`;
}

export function CapacityMarker({ fromModel, toModel }: { fromModel: string; toModel: string }) {
  const from = modelLabel(fromModel);
  const to = modelLabel(toModel);
  return (
    <div className="model-handoff completed" role="note" aria-label={`${from} was at capacity, ${to} finished this turn`} data-capacity-switch>
      <span className="handoff-line" />
      <span className="handoff-chip">
        <ModelMark id={fromModel} />
        <span>{from}</span>
        <Icon name="arrowRight" size={9} />
        <ModelMark id={toModel} />
        <b>{to}</b>
        <i>·</i>
        <small>at capacity</small>
      </span>
      <span className="handoff-line" />
    </div>
  );
}

export function ModelHandoffMarker({ handoff }: { handoff: ModelHandoff }) {
  const count = Math.max(0, Number(handoff.messageCount) || 0);
  const receipt = handoff.status === 'preparing'
    ? `carrying ${count} ${count === 1 ? 'message' : 'messages'}`
    : handoff.status === 'failed'
      ? 'handoff failed'
      : `carrying ${count} ${count === 1 ? 'message' : 'messages'}`;
  const from = modelLabel(handoff.fromModel);
  const to = modelLabel(handoff.toModel);

  return (
    <div className={`model-handoff ${handoff.status}`} role="note" aria-label={`${from} to ${to} model handoff, ${receipt}`}>
      <span className="handoff-line" />
      <span className="handoff-chip">
        <ModelMark id={handoff.fromModel} />
        <span>{from}</span>
        <Icon name="arrowRight" size={9} />
        <ModelMark id={handoff.toModel} />
        <b>{to}</b>
        <i>·</i>
        <small>{receipt}</small>
      </span>
      <span className="handoff-line" />
    </div>
  );
}
