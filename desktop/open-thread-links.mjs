// Desktop links only select an existing local conversation; they never run a turn.
export function parseOpenThreadLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['supreme-community:', 'supreme:'].includes(url.protocol) || url.hostname !== 'open'
      || !['', '/'].includes(url.pathname) || url.username || url.password
      || url.port || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'thread' && key !== 'tab')
      || url.searchParams.getAll('thread').length !== 1
      || url.searchParams.getAll('tab').length !== 1) return null;
    const taskId = url.searchParams.get('thread');
    const tabId = url.searchParams.get('tab');
    const localId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
    if (!localId.test(taskId) || !localId.test(tabId)) return null;
    return { taskId, tabId };
  } catch { return null; }
}

// Keep a cold-start link through authentication and renderer loading. A newer
// click supersedes an older undelivered link; successful delivery happens once.
export function createOpenThreadLinks(deliver) {
  let ready = false;
  let pending = null;
  function flush() {
    if (!ready || !pending) return false;
    const ref = pending;
    if (!deliver(ref)) return false;
    if (pending === ref) pending = null;
    return true;
  }
  return {
    queue(value) {
      const ref = parseOpenThreadLink(value);
      if (!ref) return false;
      pending = ref;
      flush();
      return true;
    },
    setReady(value) { ready = value === true; flush(); },
    flush,
  };
}
