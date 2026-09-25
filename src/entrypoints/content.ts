// Isolated-world content script: DOM/metadata scanning, thumbnails, the in-page "Grab" overlay,
// and the relay for "record while playing".
import { defineContentScript } from 'wxt/utils/define-content-script';
import { classify, extractMediaUrls } from '@/lib/detect/classify';
import { bg } from '@/lib/messaging';
import { mountOverlay } from '@/lib/ui/overlay';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: [
    '*://*.youtube.com/*',
    '*://youtube.com/*',
    '*://*.youtube-nocookie.com/*',
    '*://youtu.be/*',
    '*://*.youtubekids.com/*',
  ],
  runAt: 'document_start',
  allFrames: true,
  main() {
    const w = window as unknown as { __grabbitContent?: boolean };
    if (w.__grabbitContent) return;
    w.__grabbitContent = true;
    new ContentAgent().start();
  },
});

interface ItemIn {
  url: string;
  kind: 'direct' | 'hls' | 'dash';
  mime?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
  audioOnly?: boolean;
  source: 'dom' | 'hook' | 'json' | 'meta';
}

class ContentAgent {
  private port: MessagePort | null = null;
  private pending: ItemIn[] = [];
  private flags: { drm?: boolean; mse?: boolean } = {};
  private thumbs: { src: string; dataUrl: string }[] = [];
  private sent = new Set<string>();
  private thumbed = new Map<string, number>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private metaSent = false;
  private recorder: RecorderRelay | null = null;
  private mseSeen = false;
  readonly isTop = window === window.top;

  start() {
    this.connectHook();
    chrome.runtime.onMessage.addListener((msg, _s, reply) => {
      if (msg?.target !== 'content') return false;
      if (msg.type === 'record') {
        void this.toggleRecord(!!msg.on, !!msg.turbo).then(
          () => reply({ ok: true }),
          (e: Error) => reply({ ok: false, error: e.message }),
        );
        return true;
      }
      return false;
    });
    const onReady = () => {
      this.scan();
      if (this.isTop) this.sendMeta();
      const mo = new MutationObserver(() => this.scheduleScan());
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      setInterval(() => this.scan(), 4000);
      document.addEventListener('play', (e) => this.onMediaEvent(e), true);
      document.addEventListener('loadedmetadata', (e) => this.onMediaEvent(e), true);
      // In-page button follows the settings live (no reload needed).
      type OverlayPrefs = { overlay?: boolean; disabledOverlayHosts?: string[] } | undefined;
      const host = location.hostname.replace(/^www\./, '');
      const wanted = (s: OverlayPrefs) => s?.overlay !== false && !s?.disabledOverlayHosts?.includes(host);
      let overlay: ReturnType<typeof mountOverlay>;
      const apply = (s: OverlayPrefs) => {
        if (wanted(s)) {
          if (overlay) overlay.setEnabled(true);
          else overlay = mountOverlay();
        } else overlay?.setEnabled(false);
      };
      chrome.storage.local.get('settings').then((r) => apply(r.settings as OverlayPrefs));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) apply(changes.settings.newValue as OverlayPrefs);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
  }

  // ── MAIN-world bridge ──
  private connectHook() {
    const handshake = () => {
      const ch = new MessageChannel();
      this.port = ch.port1;
      ch.port1.onmessage = (e) => this.onHook(e.data);
      window.postMessage({ __grabbitPort: true }, '*', [ch.port2]);
    };
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data?.__grabbitHello === true) handshake();
    });
    handshake();
  }

  private onHook(m: { t: string; url?: string; kind?: string; mime?: string; source?: 'hook' | 'json'; sb?: number; data?: ArrayBuffer }) {
    if (m.t === 'media' && m.url && m.kind) {
      this.queue({ url: m.url, kind: m.kind as ItemIn['kind'], mime: m.mime, source: m.source ?? 'hook' });
    } else if (m.t === 'mse') {
      this.mseSeen = true;
      this.flags.mse = true;
      this.scheduleFlush();
    } else if (m.t === 'drm') {
      this.flags.drm = true;
      this.scheduleFlush();
    } else if (m.t === 'rec') {
      this.recorder?.push(m as { sb: number; mime: string; data: ArrayBuffer });
    }
  }

  // ── Batching ──
  private queue(it: ItemIn) {
    const key = `${it.url}|${it.thumbnail ? 't' : ''}|${it.duration ? 'd' : ''}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    this.pending.push(it);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 400);
  }

  private flush() {
    this.flushTimer = undefined;
    const items = this.pending.splice(0);
    const thumbs = this.thumbs.splice(0);
    const flags = this.flags;
    this.flags = {};
    if (!items.length && !thumbs.length && !flags.drm && !flags.mse) return;
    bg('detect', { items, thumbs, ...flags }).catch(() => {});
  }

  // ── DOM scanning ──
  private scanTimer?: ReturnType<typeof setTimeout>;
  private scheduleScan() {
    if (!this.scanTimer) this.scanTimer = setTimeout(() => ((this.scanTimer = undefined), this.scan()), 800);
  }

  private scan() {
    const media = collectMedia(document);
    for (const el of media) this.inspectElement(el);
  }

  private onMediaEvent(e: Event) {
    const el = e.target;
    if (el instanceof HTMLMediaElement) {
      this.inspectElement(el);
      if (el instanceof HTMLVideoElement) setTimeout(() => this.captureThumb(el), 1200);
    }
  }

  private inspectElement(el: HTMLMediaElement) {
    const srcs = new Set<string>();
    if (el.currentSrc) srcs.add(el.currentSrc);
    if (el.src) srcs.add(el.src);
    el.querySelectorAll('source[src]').forEach((s) => srcs.add((s as HTMLSourceElement).src));
    const isVideo = el instanceof HTMLVideoElement;
    for (const src of srcs) {
      if (!/^https?:/i.test(src)) continue;
      const c = classify(src, (el.querySelector(`source[src="${CSS.escape(src)}"]`) as HTMLSourceElement | null)?.type);
      const kind = c && 'kind' in c ? c.kind : 'direct';
      if (c && 'segment' in c) continue;
      this.queue({
        url: src,
        kind,
        source: 'dom',
        title: this.isTop ? document.title : undefined,
        duration: isFinite(el.duration) ? el.duration : undefined,
        width: isVideo ? (el as HTMLVideoElement).videoWidth || undefined : undefined,
        height: isVideo ? (el as HTMLVideoElement).videoHeight || undefined : undefined,
        thumbnail: isVideo && (el as HTMLVideoElement).poster ? (el as HTMLVideoElement).poster : undefined,
        audioOnly: !isVideo,
      });
    }
    if (isVideo && !el.paused) this.captureThumb(el as HTMLVideoElement);
  }

  private captureThumb(v: HTMLVideoElement) {
    const src = /^https?:/i.test(v.currentSrc) ? v.currentSrc : '*';
    const last = this.thumbed.get(src) ?? 0;
    if (Date.now() - last < 30_000 || v.readyState < 2 || !v.videoWidth) return;
    const r = v.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) return;
    this.thumbed.set(src, Date.now());
    try {
      const W = 320;
      const H = Math.round((W * v.videoHeight) / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, W, H);
      const dataUrl = c.toDataURL('image/jpeg', 0.72);
      if (dataUrl.length > 1000) {
        this.thumbs.push({ src, dataUrl });
        this.scheduleFlush();
      }
    } catch {
      // Cross-origin video without CORS taints the canvas — fall back to poster/og:image.
    }
  }

  // ── Page metadata (Open Graph, JSON-LD) ──
  private sendMeta() {
    if (this.metaSent) return;
    this.metaSent = true;
    const q = (sel: string) => (document.querySelector(sel) as HTMLMetaElement | null)?.content || undefined;
    const abs = (u?: string) => {
      try {
        return u ? new URL(u, location.href).href : undefined;
      } catch {
        return undefined;
      }
    };
    const meta = {
      title: q('meta[property="og:title"]') || q('meta[name="twitter:title"]') || document.title || undefined,
      image: abs(q('meta[property="og:image"]') || q('meta[name="twitter:image"]')),
      description: q('meta[property="og:description"]'),
      favicon: (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href,
    };
    const urls = new Set<string>();
    for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]']) {
      const v = q(sel);
      if (v && /^https?:/.test(v)) urls.add(new URL(v, location.href).href);
    }
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const walk = (o: unknown): void => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) return o.forEach(walk);
          const obj = o as Record<string, unknown>;
          if (/VideoObject/i.test(String(obj['@type'] ?? '')) && typeof obj.contentUrl === 'string') urls.add(new URL(obj.contentUrl, location.href).href);
          Object.values(obj).forEach(walk);
        };
        walk(JSON.parse(s.textContent || 'null'));
      } catch {
        for (const u of extractMediaUrls(s.textContent || '', location.href)) urls.add(u);
      }
    });
    for (const u of urls) {
      const c = classify(u, undefined);
      if (c && 'kind' in c) this.queue({ url: u, kind: c.kind, source: 'meta', title: meta.title, thumbnail: meta.image });
    }
    bg('detect', { meta }).catch(() => {});
  }

  // ── Record while playing ──
  private async toggleRecord(on: boolean, turbo: boolean) {
    if (on) {
      if (this.recorder) return;
      const video = largestVideo();
      // Only frames that actually run a MediaSource player record (embeds usually live in iframes).
      if (!this.mseSeen || !video) return;
      this.recorder = new RecorderRelay(document.title, location.href);
      await this.recorder.open();
      this.port?.postMessage({ cmd: 'record', on: true });
      bg('record.state', { on: true }).catch(() => {});
      if (video) {
        try {
          if (video.currentTime > 1) video.currentTime = 0;
          if (turbo) {
            video.muted = true;
            video.playbackRate = 8;
          }
          await video.play().catch(() => {});
          video.addEventListener('ended', () => void this.toggleRecord(false, false), { once: true });
        } catch {
          /* ignore */
        }
      }
    } else if (this.recorder) {
      this.port?.postMessage({ cmd: 'record', on: false });
      const v = largestVideo();
      if (v && v.playbackRate > 2) {
        v.playbackRate = 1;
      }
      const r = this.recorder;
      this.recorder = null;
      bg('record.state', { on: false }).catch(() => {});
      await r.finish();
    }
  }
}

/** All media elements including those inside open shadow roots and same-origin iframes. */
function collectMedia(root: Document | ShadowRoot, out: HTMLMediaElement[] = [], depth = 0): HTMLMediaElement[] {
  root.querySelectorAll('video, audio').forEach((m) => out.push(m as HTMLMediaElement));
  if (depth > 3) return out;
  const all = root.querySelectorAll('*');
  if (all.length < 6000) {
    all.forEach((el) => {
      if (el.shadowRoot) collectMedia(el.shadowRoot, out, depth + 1);
    });
  }
  return out;
}

function largestVideo(): HTMLVideoElement | undefined {
  let best: HTMLVideoElement | undefined;
  let area = 0;
  for (const m of collectMedia(document)) {
    if (!(m instanceof HTMLVideoElement)) continue;
    const r = m.getBoundingClientRect();
    if (r.width * r.height > area) {
      area = r.width * r.height;
      best = m;
    }
  }
  return best;
}

/** Streams captured SourceBuffer data into an extension-origin iframe that writes to OPFS. */
class RecorderRelay {
  private frame?: HTMLIFrameElement;
  private ready?: Promise<void>;
  private buffered: { sb: number; mime: string; data: ArrayBuffer }[] = [];
  private isReady = false;
  readonly session = Math.random().toString(36).slice(2, 10);

  constructor(
    private title: string,
    private pageUrl: string,
  ) {}

  open() {
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL(`recorder.html?s=${this.session}`);
    f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-10px;top:-10px;';
    f.setAttribute('aria-hidden', 'true');
    this.ready = new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.source === f.contentWindow && e.data?.grabbitRecorder === 'ready') {
          window.removeEventListener('message', onMsg);
          this.isReady = true;
          for (const m of this.buffered.splice(0)) this.post(m);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
    });
    (document.body || document.documentElement).appendChild(f);
    this.frame = f;
    return Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, 4000))]);
  }

  private post(m: { sb: number; mime: string; data: ArrayBuffer }) {
    this.frame?.contentWindow?.postMessage({ grabbitRec: 'data', ...m }, '*', [m.data]);
  }

  push(m: { sb: number; mime: string; data: ArrayBuffer }) {
    if (this.isReady) this.post(m);
    else this.buffered.push(m);
  }

  async finish() {
    await this.ready;
    const done = new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.source === this.frame?.contentWindow && e.data?.grabbitRecorder === 'finished') {
          window.removeEventListener('message', onMsg);
          resolve();
        }
      };
      window.addEventListener('message', onMsg);
      setTimeout(resolve, 60_000);
    });
    this.frame?.contentWindow?.postMessage({ grabbitRec: 'finish', title: this.title, pageUrl: this.pageUrl }, '*');
    await done;
    this.frame?.remove();
  }
}
