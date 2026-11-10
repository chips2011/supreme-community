// Durable model-handoff receipts. These live beside a tab's transcript instead
// of inside it: users can see the boundary, while providers receive only the
// ordinary readable user/assistant history.

// A turn its stand-in finished after a capacity switch still belongs to the
// model that was asked: the tab never moved, and its thread carries on.
export function lastAssistantModel(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.model) return message.fellBackFrom || message.model;
  }
  return null;
}

export function createModelHandoff({
  id,
  messages = [],
  fromModel = lastAssistantModel(messages),
  toModel,
  fromProvider = null,
  toProvider = null,
  now = new Date().toISOString(),
} = {}) {
  if (!fromModel || !toModel || fromModel === toModel) return null;
  return {
    id,
    type: 'model_handoff',
    fromModel,
    toModel,
    fromProvider,
    toProvider,
    mode: 'transcript_replay',
    status: 'preparing',
    atMessageCount: messages.length,
    messageCount: messages.length,
    startedAt: now,
  };
}

export function finalizeModelHandoff(tab, handoffId, {
  ok,
  stopped = false,
  error = null,
  completedAt = new Date().toISOString(),
} = {}) {
  if (!tab || !handoffId) return null;
  const handoff = (tab.handoffs || []).find((candidate) => candidate.id === handoffId);
  if (!handoff) return null;
  handoff.status = ok || stopped ? 'completed' : 'failed';
  handoff.completedAt = completedAt;
  if (handoff.status === 'failed' && error) handoff.error = String(error);
  else delete handoff.error;
  return handoff;
}
