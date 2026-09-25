// Grabbit service worker: network sniffing, media registry, routing, DNR header rules,
// downloads bookkeeping, context menus, commands and notifications.
import { defineBackground } from 'wxt/utils/define-background';
import { classify, normalizeMime, pickReplayHeaders, totalFromContentRange, identityOf } from '@/lib/detect/classify';
import {
  addMedia,
  applyInfo,
  getTab,
  onRegistryChange,
  removeTab,
  resetTab,
  setTabFlags,
  setThumb,
  updateMedia,
  visibleItems,
  withThumb,
  type AddInput,
  type PageMeta,
} from '@/lib/detect/registry';
import { listen, send } from '@/lib/messaging';
import { buildRequest, type Choice } from '@/lib/request';
import { getSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import type { DetectedMedia, Job, JobRequest, MediaInfo, MediaKind } from '@/lib/types';
import { hash, isBlockedUrl, isHttpUrl, originOf } from '@/lib/util';

export default defineBackground({
  type: 'module',
  main() {
    main();
  },
});

// ───────────────────────── Offscreen engine ─────────────────────────

const OFFSCREEN_PATH = 'offscreen.html';
let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  return ctx.length > 0;
}

let engineReady = false;

async function waitForEngine() {
  for (let i = 0; i < 100; i++) {
    try {
      await send('offscreen-direct', 'ping');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error('The download engine did not start');
}

async function ensureOffscreen() {
  if (engineReady && (await hasOffscreen())) return;
  if (!creating) {
    creating = (async () => {
      // A document may exist but not have registered its listeners yet (or we restarted).
      if (!(await hasOffscreen())) {
        await chrome.offscreen
          .createDocument({
            url: OFFSCREEN_PATH,
            reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
            justification: 'Runs the parallel download, decryption (AES-128 HLS) and remux engine.',
          })
          .catch((e: unknown) => {
            if (!/single offscreen|already/i.test(String(e))) throw e;
          });
      }
      await waitForEngine();
      await send('offscreen-direct', 'settings', await getSettings()).catch(() => {});
      engineReady = true;
    })().finally(() => (creating = null));
  }
  await creating;
}

async function engine<R = unknown>(type: string, payload?: unknown): Promise<R> {
  await ensureOffscreen();
  try {
    return await send<R>('offscreen-direct', type, payload);
  } catch (e) {
    // The engine document went away (e.g. closed by the browser) — recreate it once and retry.
    if (!/Receiving end does not exist|No handler/i.test(String(e))) throw e;
    engineReady = false;
    await ensureOffscreen();
    return send<R>('offscreen-direct', type, payload);
  }
}

// ───────────────────────── DNR header rules ─────────────────────────
// Downloads come from the extension (tabId -1). We replay the page's Referer/Origin (and any
// captured auth headers) for the CDN domains of each job so servers treat us like the player.

interface RuleScope {
  id: number;
  domains: string[];
  headers: Record<string, string>;
}

async function getScopes(): Promise<Record<string, RuleScope>> {
  return ((await chrome.storage.session.get('dnrScopes')).dnrScopes as Record<string, RuleScope>) ?? {};
}

let dnrLock: Promise<unknown> = Promise.resolve();
function withDnrLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = dnrLock.then(fn, fn);
  dnrLock = p.catch(() => {});
  return p;
}

function buildHeaders(pageUrl: string, captured?: Record<string, string>, firstUrl?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (captured) Object.assign(h, captured);
  if (!h.referer && isHttpUrl(pageUrl)) h.referer = pageUrl;
  if (!h.origin && isHttpUrl(pageUrl) && firstUrl && originOf(firstUrl) !== originOf(pageUrl)) h.origin = originOf(pageUrl);
  return h;
}

async function setHeaderRule(scope: string, urls: string[], pageUrl: string, captured?: Record<string, string>) {
  return withDnrLock(async () => {
    const scopes = await getScopes();
    const domains = new Set(scopes[scope]?.domains ?? []);
    for (const u of urls) {
      try {
        domains.add(new URL(u).hostname);
      } catch {
        /* skip */
      }
    }
    const headers = buildHeaders(pageUrl, captured, urls[0]);
    if (!Object.keys(headers).length || !domains.size) return;
    const used = new Set(Object.values(scopes).map((s) => s.id));
    let id = scopes[scope]?.id;
    if (!id) {
      id = 1000;
      while (used.has(id)) id++;
    }
    const prev = scopes[scope];
    if (prev && prev.domains.length === domains.size && JSON.stringify(prev.headers) === JSON.stringify(headers)) return;
    scopes[scope] = { id, domains: [...domains], headers };
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 2,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders: Object.entries(headers).map(([header, value]) => ({
              header,
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value,
            })),
          },
          condition: { requestDomains: [...domains], tabIds: [chrome.tabs.TAB_ID_NONE] },
        },
      ],
    });
    await chrome.storage.session.set({ dnrScopes: scopes });
  });
}

async function clearHeaderRule(scope: string) {
  return withDnrLock(async () => {
    const scopes = await getScopes();
    const s = scopes[scope];
    if (!s) return;
    delete scopes[scope];
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [s.id] });
    await chrome.storage.session.set({ dnrScopes: scopes });
  });
}

// ───────────────────────── Detection ─────────────────────────

const pendingHeaders = new Map<string, chrome.webRequest.HttpHeader[]>();
const tabUrls = new Map<number, string>();
let settings: Settings;

async function tabInfo(tabId: number): Promise<{ url?: string; title?: string }> {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t.url) tabUrls.set(tabId, t.url);
    return { url: t.url, title: t.title };
  } catch {
    return {};
  }
}

const analyzing = new Map<string, Promise<DetectedMedia | undefined>>();
const analyzeQueue: (() => void)[] = [];
let analyzeActive = 0;

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      analyzeActive++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          analyzeActive--;
          analyzeQueue.shift()?.();
        });
    };
    if (analyzeActive < 3) run();
    else analyzeQueue.push(run);
  });
}

async function analyzeItem(tabId: number, id: string, force = false): Promise<DetectedMedia | undefined> {
  const key = `${tabId}:${id}`;
  const running = analyzing.get(key);
  if (running) return running;
  const s = await getTab(tabId);
  const item = s.items.find((i) => i.id === id);
  if (!item) return undefined;
  if (item.info && !force) return item;
  const p = schedule(async () => {
    await updateMedia(tabId, id, { analyzing: true, error: undefined });
    try {
      const info = await engine<MediaInfo>('analyze', { media: item });
      return await applyInfo(tabId, id, info);
    } catch (e) {
      return await updateMedia(tabId, id, { analyzing: false, error: e instanceof Error ? e.message : String(e) });
    }
  }).finally(() => analyzing.delete(key));
  analyzing.set(key, p);
  return p;
}

async function detect(tabId: number, input: AddInput) {
  if (tabId < 0) return;
  let pageUrl = input.pageUrl || tabUrls.get(tabId);
  const t = await getTab(tabId);
  if (!t.url || !t.title) {
    const info = await tabInfo(tabId);
    t.url = t.url || info.url;
    t.title = info.title;
  }
  pageUrl = pageUrl || t.url || '';
  if (isBlockedUrl(pageUrl) || isBlockedUrl(t.url)) return;
  const res = await addMedia(tabId, {
    ...input,
    pageUrl,
    pageTitle: input.pageTitle || t.meta?.title || t.title,
  });
  if (res?.isNew && res.item.kind !== 'direct' && !res.item.hidden) {
    void analyzeItem(tabId, res.item.id);
  }
}

function header(details: { responseHeaders?: chrome.webRequest.HttpHeader[] }, name: string) {
  return details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
}

function setupWebRequest() {
  const filter: chrome.webRequest.RequestFilter = {
    urls: ['<all_urls>'],
    types: ['media', 'xmlhttprequest', 'other', 'object', 'main_frame', 'sub_frame'],
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.type === 'main_frame' && d.tabId >= 0) {
        tabUrls.set(d.tabId, d.url);
        void resetTab(d.tabId, d.url);
      }
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  chrome.webRequest.onSendHeaders.addListener(
    (d) => {
      if (d.tabId < 0 || d.type === 'main_frame') return;
      const picked = d.requestHeaders?.filter((h) => /^(referer|origin|authorization|x-)/i.test(h.name));
      if (picked?.length) {
        pendingHeaders.set(d.requestId, picked);
        if (pendingHeaders.size > 2000) pendingHeaders.delete(pendingHeaders.keys().next().value!);
      }
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
    ['requestHeaders', 'extraHeaders'],
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      const headers = pendingHeaders.get(d.requestId);
      pendingHeaders.delete(d.requestId);
      if (d.tabId < 0 || d.statusCode >= 400 || d.statusCode < 200) return undefined;
      const ct = header(d, 'content-type');
      const c = classify(d.url, ct);
      if (!c || 'segment' in c) return undefined;
      const mime = normalizeMime(ct);
      if (mime.startsWith('text/html') || mime.startsWith('image/')) return undefined;
      let size: number | undefined;
      if (c.kind === 'direct') {
        size = totalFromContentRange(header(d, 'content-range'));
        if (size == null && d.statusCode === 200) {
          const len = parseInt(header(d, 'content-length') || '', 10);
          if (isFinite(len)) size = len;
        }
        if (size != null && size < 64 * 1024) return undefined;
      }
      const pageUrl = d.type === 'main_frame' ? d.url : (d as any).documentUrl || tabUrls.get(d.tabId) || d.initiator || '';
      void detect(d.tabId, {
        url: d.url,
        kind: c.kind,
        mime: mime || undefined,
        size,
        audioOnly: c.kind === 'direct' ? c.audioOnly : undefined,
        pageUrl,
        headers: pickReplayHeaders(headers),
        source: 'network',
        frameId: d.frameId,
      });
      return undefined;
    },
    filter,
    ['responseHeaders'],
  );

  chrome.webRequest.onErrorOccurred.addListener((d) => void pendingHeaders.delete(d.requestId), { urls: ['<all_urls>'] });
}

// ───────────────────────── Badge ─────────────────────────

const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();
function refreshBadge(tabId: number) {
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.set(
    tabId,
    setTimeout(async () => {
      badgeTimers.delete(tabId);
      const s = await getTab(tabId);
      const n = visibleItems(s, (settings?.minSizeKB ?? 0) * 1024).filter((i) => !i.drm).length;
      const blocked = isBlockedUrl(s.url);
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF6B1A' }).catch(() => {});
      await chrome.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' }).catch(() => {});
      await chrome.action.setBadgeText({ tabId, text: blocked || !n ? '' : n > 99 ? '99+' : String(n) }).catch(() => {});
    }, 150),
  );
}

// ───────────────────────── Jobs ─────────────────────────

async function startJob(request: JobRequest): Promise<string> {
  if (isBlockedUrl(request.url) || isBlockedUrl(request.pageUrl)) throw new Error('This site is not supported.');
  const jobId = await engine<string>('job.start', { request });
  return jobId;
}

async function quickGrab(tabId: number, opts: { itemId?: string; url?: string; choice?: Choice } = {}) {
  const s = await getTab(tabId);
  if (isBlockedUrl(s.url)) throw new Error('Grabbit does not download from YouTube.');
  let item: DetectedMedia | undefined;
  if (opts.itemId) item = s.items.find((i) => i.id === opts.itemId);
  if (!item && opts.url && isHttpUrl(opts.url)) {
    const c = classify(opts.url, undefined);
    const kind: MediaKind = c && 'kind' in c ? c.kind : 'direct';
    await detect(tabId, { url: opts.url, kind, pageUrl: s.url || '', source: 'dom' });
    const id = hash(`${tabId}|${identityOf(opts.url)}`);
    item = (await getTab(tabId)).items.find((i) => i.id === id);
  }
  if (!item) {
    const visible = visibleItems(s, settings.minSizeKB * 1024).filter((i) => !i.drm);
    item = visible[0];
  }
  if (!item) throw new Error('No video found on this page yet — try playing it first.');
  if (item.drm) throw new Error('This video is DRM-protected and cannot be downloaded.');
  const analyzed = (await analyzeItem(tabId, item.id)) ?? item;
  if (analyzed.info?.drm) throw new Error('This video is DRM-protected and cannot be downloaded.');
  const request = buildRequest(withThumb(await getTab(tabId), analyzed), settings, opts.choice);
  return startJob(request);
}

function notify(id: string, title: string, message: string) {
  if (!settings?.notifications) return;
  chrome.notifications
    .create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title, message, priority: 0 })
    .catch(() => {});
}

async function openHub(hash = '') {
  const url = chrome.runtime.getURL(`hub.html${hash ? '#' + hash : ''}`);
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('hub.html') + '*' });
  if (tabs[0]?.id != null) {
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else await chrome.tabs.create({ url });
}

function asciiPath(path: string): string {
  return path
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\/\s+|\s+\//g, '/');
}

// Map downloadId → jobId (persisted so it survives worker restarts).
type DlMap = Record<string, { jobId: string; part: string }>;

async function trackDownload(downloadId: number, jobId: string, part: string) {
  const r = ((await chrome.storage.session.get('dl')).dl ?? {}) as DlMap;
  r[downloadId] = { jobId, part };
  await chrome.storage.session.set({ dl: r });
}

async function takeDownload(downloadId: number): Promise<{ jobId: string; part: string } | undefined> {
  const r = ((await chrome.storage.session.get('dl')).dl ?? {}) as DlMap;
  const v = r[downloadId];
  if (v) {
    delete r[downloadId];
    await chrome.storage.session.set({ dl: r });
  }
  return v;
}

// ───────────────────────── Messages ─────────────────────────

function setupMessages() {
  listen('bg', {
    ping: () => 'pong',

    // From content scripts.
    detect: async (p: { items?: AddInput[]; meta?: PageMeta; thumbs?: { src: string; dataUrl: string }[]; drm?: boolean; mse?: boolean }, sender) => {
      const tabId = sender.tab?.id;
      if (tabId == null || tabId < 0) return;
      const pageUrl = sender.url || sender.tab?.url || '';
      if (isBlockedUrl(pageUrl) || isBlockedUrl(sender.tab?.url)) return;
      if (p.meta && sender.frameId === 0) await setTabFlags(tabId, { meta: p.meta, url: sender.tab?.url, title: sender.tab?.title });
      if (p.drm) await setTabFlags(tabId, { drm: true });
      if (p.mse) await setTabFlags(tabId, { mse: true });
      for (const t of p.thumbs ?? []) await setThumb(tabId, t.src, t.dataUrl);
      for (const it of p.items ?? []) {
        if (!isHttpUrl(it.url)) continue;
        await detect(tabId, { ...it, pageUrl: it.pageUrl || pageUrl, frameId: sender.frameId });
      }
    },

    'media.list': async (p: { tabId?: number }, sender) => {
      const tabId = p?.tabId ?? sender.tab?.id ?? -1;
      const s = await getTab(tabId);
      const t = await tabInfo(tabId);
      return {
        items: visibleItems(s, settings.minSizeKB * 1024),
        tab: { url: t.url ?? s.url, title: t.title, drm: !!s.drm, mse: !!s.mse, meta: s.meta, blocked: isBlockedUrl(t.url ?? s.url) },
      };
    },

    'media.analyze': (p: { tabId?: number; id: string; force?: boolean }, sender) =>
      analyzeItem(p.tabId ?? sender.tab?.id ?? -1, p.id, p.force),

    'media.add': async (p: { tabId: number; url: string }) => {
      const s = await getTab(p.tabId);
      const c = classify(p.url, undefined);
      await detect(p.tabId, { url: p.url, kind: c && 'kind' in c ? c.kind : 'direct', pageUrl: s.url || '', source: 'dom' });
      const id = hash(`${p.tabId}|${identityOf(p.url)}`);
      return analyzeItem(p.tabId, id);
    },

    'job.start': (p: { request: JobRequest }) => startJob(p.request),
    'quick.grab': (p: { tabId?: number; itemId?: string; url?: string; choice?: Choice }, sender) =>
      quickGrab(p.tabId ?? sender.tab?.id ?? -1, p),
    'job.action': (p: { id: string; action: string }) => engine('job.action', p),
    'jobs.list': () => engine<Job[]>('jobs.list'),
    'jobs.clear': () => engine('jobs.clear'),

    'download.open': (p: { downloadId: number }) => chrome.downloads.open(p.downloadId),
    'download.show': (p: { downloadId?: number }) => (p.downloadId != null ? chrome.downloads.show(p.downloadId) : chrome.downloads.showDefaultFolder()),
    'hub.open': (p: { hash?: string } = {}) => openHub(p.hash),

    'record.toggle': async (p: { tabId: number; on: boolean; turbo?: boolean }) => {
      const s = await getTab(p.tabId);
      if (p.on && s.drm) throw new Error('This video is DRM-protected and can’t be recorded.');
      if (p.on && !s.mse) throw new Error('No streaming player found yet — press play on the video first, then start recording.');
      await chrome.tabs.sendMessage(p.tabId, { target: 'content', type: 'record', on: p.on, turbo: p.turbo });
      if (!p.on) await chrome.storage.session.set({ [`rec:${p.tabId}`]: false });
    },
    // Content scripts report the real recording state (e.g. auto-stop when the video ends).
    'record.state': async (p: { on: boolean }, sender) => {
      if (sender.tab?.id != null) await chrome.storage.session.set({ [`rec:${sender.tab.id}`]: p.on });
    },

    // From the offscreen engine.
    'dnr.set': (p: { scope: string; urls: string[]; pageUrl: string; headers?: Record<string, string> }) =>
      setHeaderRule(p.scope, p.urls, p.pageUrl, p.headers),
    'dnr.clear': (p: { scope: string }) => clearHeaderRule(p.scope),
    'download.save': async (p: { jobId: string; part: string; url: string; filename: string; saveAs?: boolean }) => {
      // Some systems (e.g. Linux without a UTF-8 locale) reject non-ASCII names — never fail a
      // finished download over its name: retry with an ASCII-safe name, then a generic one.
      const ext = p.filename.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '';
      const candidates = [p.filename, asciiPath(p.filename), `Grabbit/video-${Date.now()}${ext}`];
      let id: number | undefined;
      let lastErr: unknown;
      for (const filename of [...new Set(candidates)]) {
        try {
          id = await chrome.downloads.download({ url: p.url, filename, saveAs: p.saveAs ?? settings.saveAs, conflictAction: 'uniquify' });
          break;
        } catch (e) {
          lastErr = e;
          if (!/filename/i.test(String(e))) break;
        }
      }
      if (id == null) throw lastErr instanceof Error ? lastErr : new Error('Download was blocked');
      await trackDownload(id, p.jobId, p.part);
      return id;
    },
    'job.finished': (p: { job: Job }) => {
      const j = p.job;
      if (j.status === 'done') notify(`done:${j.id}`, 'Grabbed! 🥕', `${j.filename}`);
      else if (j.status === 'error') notify(`err:${j.id}`, 'Download failed', `${j.request.title}: ${j.error ?? 'Unknown error'}`);
    },
    'settings.get': () => getSettings(),
    'record.finish': (p: Record<string, unknown>, sender) => engine('record.finish', { ...p, tabId: sender.tab?.id }),
  });

  // Proxy UI → engine calls, creating the offscreen document on demand.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return false;
    engine(msg.type, msg.payload).then(
      (data) => sendResponse({ ok: true, data }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });
}

// ───────────────────────── Menus & commands ─────────────────────────

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'grab-media', title: 'Grab this video with Grabbit', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'grab-media-audio', title: 'Grab audio only', contexts: ['video'] });
    chrome.contextMenus.create({
      id: 'grab-link',
      title: 'Grab linked media with Grabbit',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.mp4*', '*://*/*.webm*', '*://*/*.m3u8*', '*://*/*.mpd*', '*://*/*.mov*', '*://*/*.mkv*', '*://*/*.mp3*', '*://*/*.m4a*'],
    });
    chrome.contextMenus.create({ id: 'grab-page', title: 'Grab the best video on this page', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'open-hub', title: 'Open Grabbit downloads', contexts: ['action'] });
  });
}

async function onMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (info.menuItemId === 'open-hub') return openHub();
  const tabId = tab?.id;
  if (tabId == null) return;
  try {
    if (info.menuItemId === 'grab-media' || info.menuItemId === 'grab-media-audio') {
      const src = isHttpUrl(info.srcUrl) ? info.srcUrl : undefined;
      await quickGrab(tabId, { url: src, choice: { audioOnly: info.menuItemId === 'grab-media-audio' } });
    } else if (info.menuItemId === 'grab-link') {
      await quickGrab(tabId, { url: info.linkUrl });
    } else if (info.menuItemId === 'grab-page') {
      await quickGrab(tabId);
    }
    notify(`start:${Date.now()}`, 'Grabbing…', 'Download started. Open Grabbit to watch progress.');
  } catch (e) {
    notify(`err:${Date.now()}`, 'Grabbit', e instanceof Error ? e.message : String(e));
  }
}

// ───────────────────────── Downloads ─────────────────────────

function setupDownloads() {
  chrome.downloads.onChanged.addListener(async (delta) => {
    const state = delta.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const tracked = await takeDownload(delta.id);
    if (!tracked) return;
    let filename: string | undefined;
    if (state === 'complete') {
      const [d] = await chrome.downloads.search({ id: delta.id });
      filename = d?.filename;
    }
    await engine('saved', {
      jobId: tracked.jobId,
      part: tracked.part,
      downloadId: delta.id,
      ok: state === 'complete',
      filename,
      error: delta.error?.current,
    }).catch(() => {});
  });
}

// ───────────────────────── Main ─────────────────────────

function main() {
  setupWebRequest();
  setupMessages();
  setupDownloads();

  void getSettings().then((s) => (settings = s));
  onSettingsChanged(async (s) => {
    settings = s;
    if (await hasOffscreen()) await send('offscreen-direct', 'settings', s).catch(() => {});
  });

  onRegistryChange((tabId) => refreshBadge(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId);
    void removeTab(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) tabUrls.set(tabId, info.url);
    if (info.status === 'complete') refreshBadge(tabId);
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => void onMenu(info, tab));
  chrome.commands.onCommand.addListener(async (cmd, tab) => {
    if (cmd !== 'grab-best') return;
    const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (t?.id == null) return;
    try {
      await quickGrab(t.id);
      notify(`start:${Date.now()}`, 'Grabbing…', 'Best quality download started.');
    } catch (e) {
      notify(`err:${Date.now()}`, 'Grabbit', e instanceof Error ? e.message : String(e));
    }
  });
  chrome.notifications.onClicked.addListener((id) => {
    if (id.startsWith('done:') || id.startsWith('err:') || id.startsWith('start:')) void openHub();
    chrome.notifications.clear(id);
  });

  chrome.runtime.onInstalled.addListener(async (details) => {
    setupMenus();
    await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
    // Inject into already-open tabs so detection works without a reload.
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    const manifest = chrome.runtime.getManifest();
    for (const t of tabs) {
      if (t.id == null || isBlockedUrl(t.url)) continue;
      for (const cs of manifest.content_scripts ?? []) {
        chrome.scripting
          .executeScript({
            target: { tabId: t.id, allFrames: true },
            files: cs.js ?? [],
            world: (cs as { world?: 'MAIN' | 'ISOLATED' }).world === 'MAIN' ? 'MAIN' : 'ISOLATED',
          })
          .catch(() => {});
      }
    }
    if (details.reason === 'install') void openHub('welcome');
  });
  chrome.runtime.onStartup.addListener(() => setupMenus());
}
