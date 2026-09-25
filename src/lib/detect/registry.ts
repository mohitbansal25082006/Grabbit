// Per-tab registry of detected media. Lives in the service worker, persisted to
// chrome.storage.session so it survives worker restarts.
import type { DetectedMedia, MediaInfo } from '../types';
import { groupKeyFor, hash, isBlockedUrl, resolutionHint } from '../util';
import { identityOf } from './classify';

export interface PageMeta {
  title?: string;
  image?: string;
  favicon?: string;
  description?: string;
}

export interface TabState {
  url?: string;
  title?: string;
  items: DetectedMedia[];
  drm?: boolean;
  mse?: boolean;
  meta?: PageMeta;
  /** Captured video-element thumbnails keyed by media src (or '*' for the main player). */
  thumbs?: Record<string, string>;
  childIds?: string[];
}

const MAX_ITEMS = 80;
const cache = new Map<number, TabState>();
const dirty = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(tabId: number) => void>();

const keyOf = (tabId: number) => `tab:${tabId}`;

export function onRegistryChange(cb: (tabId: number) => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function getTab(tabId: number): Promise<TabState> {
  let s = cache.get(tabId);
  if (s) return s;
  try {
    const r = await chrome.storage.session.get(keyOf(tabId));
    s = (r[keyOf(tabId)] as TabState) ?? { items: [] };
  } catch {
    s = { items: [] };
  }
  const existing = cache.get(tabId);
  if (existing) return existing;
  cache.set(tabId, s);
  return s;
}

function markDirty(tabId: number) {
  dirty.add(tabId);
  for (const l of listeners) l(tabId);
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
}

async function flush() {
  flushTimer = undefined;
  const ids = [...dirty];
  dirty.clear();
  const data: Record<string, TabState> = {};
  for (const id of ids) {
    const s = cache.get(id);
    if (s) data[keyOf(id)] = s;
  }
  try {
    await chrome.storage.session.set(data);
  } catch {
    // Quota exceeded (thumbnails) → drop thumbnails and retry once.
    for (const s of Object.values(data)) {
      s.thumbs = {};
      for (const it of s.items) if (it.thumbnail?.startsWith('data:')) it.thumbnail = undefined;
    }
    await chrome.storage.session.set(data).catch(() => {});
  }
}

export async function resetTab(tabId: number, url?: string) {
  cache.set(tabId, { items: [], url });
  markDirty(tabId);
}

export async function removeTab(tabId: number) {
  cache.delete(tabId);
  await chrome.storage.session.remove(keyOf(tabId)).catch(() => {});
}

export type AddInput = Omit<DetectedMedia, 'id' | 'tabId' | 'detectedAt'> & { detectedAt?: number };

/** Add or merge a detected item. Returns the item and whether it's new. */
export async function addMedia(tabId: number, input: AddInput): Promise<{ item: DetectedMedia; isNew: boolean } | null> {
  if (isBlockedUrl(input.url) || isBlockedUrl(input.pageUrl)) return null;
  const s = await getTab(tabId);
  const identity = identityOf(input.url);
  const id = hash(`${tabId}|${identity}`);
  const existing = s.items.find((i) => i.id === id);
  if (existing) {
    // Refresh URL (fresh tokens) and fill missing fields; keep analysis.
    const merged: DetectedMedia = { ...existing };
    merged.url = input.source === 'network' || !existing.url ? input.url : existing.url;
    for (const k of ['mime', 'size', 'title', 'thumbnail', 'duration', 'width', 'height', 'headers', 'pageTitle'] as const) {
      if (input[k] != null && (merged[k] == null || k === 'size' || k === 'headers')) (merged as any)[k] = input[k];
    }
    if (input.source === 'network' && existing.source !== 'network') merged.source = 'network';
    Object.assign(existing, merged);
    markDirty(tabId);
    return { item: existing, isNew: false };
  }
  const hint = input.kind === 'direct' ? resolutionHint(input.url) : {};
  const item: DetectedMedia = {
    ...input,
    width: input.width ?? hint.width,
    height: input.height ?? hint.height,
    id,
    tabId,
    detectedAt: input.detectedAt ?? Date.now(),
    groupKey: input.kind === 'direct' ? groupKeyFor(input.url) : undefined,
    hidden: s.childIds?.includes(id) || undefined,
  };
  if (s.drm && item.kind !== 'direct') item.drm = true;
  s.items.push(item);
  if (s.items.length > MAX_ITEMS) {
    const idx = s.items.findIndex((i) => i.kind === 'direct' && !i.info);
    s.items.splice(idx >= 0 ? idx : 0, 1);
  }
  markDirty(tabId);
  return { item, isNew: true };
}

export async function updateMedia(tabId: number, id: string, patch: Partial<DetectedMedia>) {
  const s = await getTab(tabId);
  const it = s.items.find((i) => i.id === id);
  if (!it) return undefined;
  Object.assign(it, patch);
  markDirty(tabId);
  return it;
}

/** Apply an analysis result: store info and hide child resources (variant playlists etc.). */
export async function applyInfo(tabId: number, id: string, info: MediaInfo) {
  const s = await getTab(tabId);
  const it = s.items.find((i) => i.id === id);
  if (!it) return undefined;
  it.info = info;
  it.analyzing = false;
  it.error = undefined;
  if (info.duration) it.duration = info.duration;
  if (info.drm) it.drm = true;
  if (info.live) it.live = true;
  if (info.size) it.size = info.size;
  const top = info.videos[0];
  if (it.kind === 'direct' && top) {
    it.width = top.width ?? it.width;
    it.height = top.height ?? it.height;
    if (!info.videos.some((v) => v.height) && info.audios.length) it.audioOnly = true;
  }
  if (info.childUrls?.length) {
    const childIds = info.childUrls.map((u) => hash(`${tabId}|${identityOf(u)}`));
    s.childIds = [...new Set([...(s.childIds ?? []), ...childIds])].slice(-500);
    for (const other of s.items) if (other.id !== id && childIds.includes(other.id)) other.hidden = true;
  }
  markDirty(tabId);
  return it;
}

export async function setTabFlags(tabId: number, flags: Partial<Pick<TabState, 'drm' | 'mse' | 'meta' | 'url' | 'title'>>) {
  const s = await getTab(tabId);
  Object.assign(s, flags);
  if (flags.drm) for (const it of s.items) if (it.kind !== 'direct' || it.source !== 'network') it.drm = it.drm || it.kind !== 'direct';
  markDirty(tabId);
}

export async function setThumb(tabId: number, src: string, dataUrl: string) {
  const s = await getTab(tabId);
  s.thumbs = s.thumbs ?? {};
  s.thumbs[src] = dataUrl;
  const keys = Object.keys(s.thumbs);
  if (keys.length > 12) delete s.thumbs[keys[0]];
  markDirty(tabId);
}

/** Fill in a thumbnail from captured frames or the page's og:image when the item has none. */
export function withThumb(s: TabState, i: DetectedMedia): DetectedMedia {
  const thumb = i.thumbnail || s.thumbs?.[i.url] || s.thumbs?.['*'] || s.meta?.image;
  return thumb && thumb !== i.thumbnail ? { ...i, thumbnail: thumb } : i;
}

/** Visible, sorted items for the UI (manifests first, then biggest files). */
export function visibleItems(s: TabState, minSize = 0): DetectedMedia[] {
  const items = s.items.filter((i) => !i.hidden && !(i.kind === 'direct' && i.size != null && i.size < minSize && !i.info));
  const rank = (i: DetectedMedia) => (i.drm ? 0 : i.kind === 'direct' ? (i.audioOnly ? 1 : 2) : 3);
  return items
    .map((i) => withThumb(s, i))
    .sort((a, b) => rank(b) - rank(a) || (b.size ?? 0) - (a.size ?? 0) || b.detectedAt - a.detectedAt);
}
