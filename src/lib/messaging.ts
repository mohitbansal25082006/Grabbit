// Typed request/response messaging between extension contexts.
//
// Routing: every message carries a `target`. The background service worker handles `bg`
// messages and proxies `offscreen` messages (creating the offscreen document on demand).
// Live job progress is fanned out over a BroadcastChannel so it doesn't wake the worker.

export type Target = 'bg' | 'offscreen' | 'offscreen-direct';

export interface Envelope<T = unknown> {
  target: Target;
  type: string;
  payload?: T;
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export class RemoteError extends Error {}

export async function send<R = unknown, P = unknown>(target: Target, type: string, payload?: P): Promise<R> {
  const res = (await chrome.runtime.sendMessage({ target, type, payload } satisfies Envelope<P>)) as Reply<R> | undefined;
  if (!res) throw new RemoteError(`No handler for ${target}:${type}`);
  if (!res.ok) throw new RemoteError(res.error);
  return res.data;
}

export const bg = <R = unknown, P = unknown>(type: string, payload?: P) => send<R, P>('bg', type, payload);

export type Handler = (payload: any, sender: chrome.runtime.MessageSender) => unknown | Promise<unknown>;

/** Register handlers for messages addressed to `target`. */
export function listen(target: Target | Target[], handlers: Record<string, Handler>) {
  const targets = Array.isArray(target) ? target : [target];
  const listener = (msg: Envelope, sender: chrome.runtime.MessageSender, sendResponse: (r: Reply<unknown>) => void) => {
    if (!msg || typeof msg !== 'object' || !targets.includes(msg.target)) return false;
    const h = handlers[msg.type];
    if (!h) return false;
    Promise.resolve()
      .then(() => h(msg.payload, sender))
      .then(
        (data) => sendResponse({ ok: true, data: data as unknown }),
        (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

// ───────────── Broadcast (progress fan-out) ─────────────

export const CHANNEL = 'grabbit';

export type BroadcastMsg =
  | { type: 'job'; job: import('./types').Job }
  | { type: 'job-removed'; id: string }
  | { type: 'media'; tabId: number };

export function broadcast(msg: BroadcastMsg) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(msg);
  ch.close();
}

export function onBroadcast(cb: (msg: BroadcastMsg) => void) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => cb(e.data as BroadcastMsg);
  return () => ch.close();
}

// ───────────── Page ⇄ content-script bridge ─────────────

/** Event name used between the MAIN-world hook and the isolated content script. */
export const PAGE_EVENT = '__grabbit_evt__';
export const PAGE_CMD = '__grabbit_cmd__';
