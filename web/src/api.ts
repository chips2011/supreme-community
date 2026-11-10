// Same JSON fetch helper as the vanilla app: parse JSON, throw on non-2xx with
// the server's { error } message. Requests are same-origin (dev proxies /api to
// the backend on :4747).
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const txt = await res.text();
  let data: any = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = { raw: txt };
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}
