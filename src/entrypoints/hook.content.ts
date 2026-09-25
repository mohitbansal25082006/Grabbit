// MAIN-world hook: sees what the page's player actually loads — fetch/XHR responses
// (manifests hidden behind API URLs, JSON with media links), MediaSource usage and EME (DRM).
// Also powers the "record while playing" fallback by tapping SourceBuffer appends.
import { defineContentScript } from 'wxt/utils/define-content-script';
import { classify, extractMediaUrls } from '@/lib/detect/classify';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: [
    '*://*.youtube.com/*',
    '*://youtube.com/*',
    '*://*.youtube-nocookie.com/*',
    '*://youtu.be/*',
    '*://*.youtubekids.com/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    installHook();
  },
});

type Out =
  | { t: 'media'; url: string; kind?: string; mime?: string; source: 'hook' | 'json' }
  | { t: 'mse' }
  | { t: 'drm' }
  | { t: 'rec'; sb: number; mime: string; data: ArrayBuffer; ts: number };

function installHook() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__grabbitHooked) return;
  w.__grabbitHooked = true;

  let port: MessagePort | null = null;
  const queue: Out[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  let recording = false;
  // Latest init segment per SourceBuffer: players append it once up front, long before the
  // user presses "Record", so we replay it when a recording starts.
  const inits = new Map<number, { mime: string; data: Uint8Array }>();
  const looksLikeInit = (b: Uint8Array) =>
    (b.length >= 8 && /^(ftyp|moov)$/.test(String.fromCharCode(b[4], b[5], b[6], b[7]))) ||
    (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3);

  const post = (m: Out, transfer?: Transferable[]) => {
    if (port) port.postMessage(m, transfer ?? []);
    else if (m.t !== 'rec') queue.push(m);
  };

  // Private channel with the isolated content script (keeps our traffic off window.postMessage).
  window.addEventListener(
    'message',
    (e) => {
      if (e.source !== window || !e.data || e.data.__grabbitPort !== true || !e.ports[0]) return;
      e.stopImmediatePropagation();
      port = e.ports[0];
      port.onmessage = (ev) => {
        const d = ev.data as { cmd: string; on?: boolean };
        if (d.cmd === 'record') {
          if (d.on && !recording) {
            for (const [sb, i] of inits) {
              const copy = i.data.slice().buffer;
              post({ t: 'rec', sb, mime: i.mime, data: copy, ts: performance.now() }, [copy]);
            }
          }
          recording = !!d.on;
        }
      };
      for (const m of queue.splice(0)) port.postMessage(m);
    },
    true,
  );
  window.postMessage({ __grabbitHello: true }, '*');

  const report = (url: string, contentType: string | null, source: 'hook' | 'json' = 'hook') => {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    const c = classify(url, contentType);
    if (!c || 'segment' in c) return;
    const key = url.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    post({ t: 'media', url: key, kind: c.kind, mime: contentType ?? undefined, source });
  };

  const inspectText = (url: string, text: string) => {
    const head = text.slice(0, 256).trimStart();
    if (head.startsWith('#EXTM3U')) {
      if (!seen.has(url)) {
        seen.add(url);
        post({ t: 'media', url, kind: 'hls', source: 'hook' });
      }
      return;
    }
    if (/<MPD[\s>]/.test(text.slice(0, 2048))) {
      if (!seen.has(url)) {
        seen.add(url);
        post({ t: 'media', url, kind: 'dash', source: 'hook' });
      }
      return;
    }
    if (head[0] === '{' || head[0] === '[') {
      for (const u of extractMediaUrls(text, url)) report(u, null, 'json');
    }
  };

  const worthReading = (ct: string, len: number | null) =>
    inspected < 400 &&
    (len == null || len < 3_000_000) &&
    /json|mpegurl|dash|text\/plain|octet-stream|xml|javascript/.test(ct) &&
    !/html|css|image|font|video\/|audio\//.test(ct);

  // ── fetch ──
  const origFetch = window.fetch;
  if (origFetch) {
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const p = origFetch.call(this ?? window, input, init);
      p.then((res) => {
        try {
          const url = res.url || (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          report(url, ct);
          const len = res.headers.get('content-length');
          if (res.ok && !res.bodyUsed && worthReading(ct, len ? +len : null)) {
            inspected++;
            res
              .clone()
              .text()
              .then((t) => inspectText(url, t))
              .catch(() => {});
          }
        } catch {
          /* never break the page */
        }
      }).catch(() => {});
      return p;
    };
    try {
      Object.defineProperty(wrapped, 'name', { value: 'fetch' });
      wrapped.toString = () => origFetch.toString();
    } catch {
      /* ignore */
    }
    window.fetch = wrapped as typeof fetch;
  }

  // ── XHR ──
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  XHR.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      this.addEventListener('load', function (this: XMLHttpRequest) {
        try {
          const url = this.responseURL;
          const ct = (this.getResponseHeader('content-type') || '').toLowerCase();
          report(url, ct);
          if (this.status >= 200 && this.status < 300 && worthReading(ct, null)) {
            inspected++;
            if (this.responseType === '' || this.responseType === 'text') inspectText(url, this.responseText);
            else if (this.responseType === 'json' && this.response) {
              const s = JSON.stringify(this.response);
              if (s.length < 3_000_000) inspectText(url, s);
            }
          }
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XHR.open;

  // ── MediaSource / SourceBuffer ──
  const MS = (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
  if (MS) {
    const sbIds = new WeakMap<SourceBuffer, { id: number; mime: string }>();
    let nextId = 1;
    let mseReported = false;
    const origAdd = MS.prototype.addSourceBuffer;
    MS.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
      if (!mseReported) {
        mseReported = true;
        post({ t: 'mse' });
      }
      const sb = origAdd.call(this, mime);
      sbIds.set(sb, { id: nextId++, mime });
      return sb;
    };
    const SB = (window as unknown as { SourceBuffer?: typeof SourceBuffer }).SourceBuffer;
    if (SB) {
      const origAppend = SB.prototype.appendBuffer;
      SB.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
        try {
          const meta = sbIds.get(this);
          if (meta) {
            const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (looksLikeInit(view) && view.byteLength < 2_000_000) inits.set(meta.id, { mime: meta.mime, data: view.slice() });
            if (recording) {
              const copy = view.slice().buffer;
              post({ t: 'rec', sb: meta.id, mime: meta.mime, data: copy, ts: performance.now() }, [copy]);
            }
          }
        } catch {
          /* ignore */
        }
        return origAppend.call(this, data);
      };
    }
  }

  // ── EME (DRM) ──
  const HME = HTMLMediaElement.prototype as HTMLMediaElement & { setMediaKeys?: (k: MediaKeys | null) => Promise<void> };
  if (HME.setMediaKeys) {
    const origSet = HME.setMediaKeys;
    HME.setMediaKeys = function (this: HTMLMediaElement, keys: MediaKeys | null) {
      if (keys) post({ t: 'drm' });
      return origSet.call(this, keys);
    };
  }
}
