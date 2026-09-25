// Media analysis in the offscreen document: fetch + parse manifests, probe direct files.
import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import { parseDash, isDashText } from '../parsers/dash';
import { parseHls, isHlsText, type HlsMaster, type HlsMedia } from '../parsers/hls';
import { dashToInfo, hlsMasterToInfo, hlsMediaToInfo } from '../quality';
import type { DetectedMedia, MediaInfo } from '../types';
import { extFromMime, extFromUrl, qualityLabel } from '../util';
import { fetchText, HeaderScope, probe } from './net';

const withTimeout = <T>(p: Promise<T>, ms: number, msg = 'Timed out'): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

export async function analyze(media: DetectedMedia): Promise<MediaInfo> {
  const scope = new HeaderScope(`an:${media.id}`, media.pageUrl, media.headers);
  try {
    await scope.cover([media.url]);
    if (media.kind === 'hls') return await analyzeHls(media.url, scope);
    if (media.kind === 'dash') return await analyzeDash(media.url, scope);
    return await analyzeDirect(media, scope);
  } finally {
    void scope.dispose();
  }
}

async function analyzeHls(url: string, scope: HeaderScope): Promise<MediaInfo> {
  const { text, url: finalUrl } = await withTimeout(fetchText(url), 25_000, 'Manifest request timed out');
  if (!isHlsText(text)) {
    if (isDashText(text)) return analyzeDashText(text, finalUrl);
    throw new Error('Not an HLS playlist');
  }
  const pl = parseHls(text, finalUrl);
  if (pl.type === 'media') {
    const info = hlsMediaToInfo(pl, url);
    info.childUrls = segmentUrls(pl);
    return info;
  }
  const master = pl as HlsMaster;
  const children = [...master.variants.map((v) => v.uri), ...master.renditions.filter((r) => r.uri).map((r) => r.uri!)];
  // Sample one variant for duration, live-ness and encryption.
  let sample: HlsMedia | undefined;
  const pick = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (pick) {
    try {
      await scope.cover([pick.uri]);
      const r = await withTimeout(fetchText(pick.uri), 20_000);
      const p = parseHls(r.text, r.url);
      if (p.type === 'media') {
        sample = p;
        children.push(...segmentUrls(p));
      }
    } catch {
      /* duration unknown is fine */
    }
  }
  const info = hlsMasterToInfo(master, sample);
  info.childUrls = children;
  return info;
}

function segmentUrls(p: HlsMedia): string[] {
  const set = new Set<string>();
  for (const s of p.segments) {
    set.add(s.uri);
    if (s.map) set.add(s.map.uri);
    if (set.size > 150) break;
  }
  return [...set];
}

async function analyzeDash(url: string, _scope: HeaderScope): Promise<MediaInfo> {
  const { text, url: finalUrl } = await withTimeout(fetchText(url), 25_000, 'Manifest request timed out');
  if (!isDashText(text)) {
    if (isHlsText(text)) return analyzeHls(url, _scope);
    throw new Error('Not a DASH manifest');
  }
  return analyzeDashText(text, finalUrl);
}

function analyzeDashText(text: string, url: string): MediaInfo {
  const m = parseDash(text, url);
  const info = dashToInfo(m);
  const children = new Set<string>();
  for (const r of m.representations) {
    if (r.singleFile) children.add(r.singleFile);
    if (r.init) children.add(r.init.url);
    for (const s of r.segments.slice(0, 20)) children.add(s.url);
  }
  info.childUrls = [...children].slice(0, 300);
  return info;
}

async function analyzeDirect(media: DetectedMedia, _scope: HeaderScope): Promise<MediaInfo> {
  const p = await probe(media.url);
  const container = extFromMime(p.mime) || extFromUrl(p.url) || extFromUrl(media.url) || undefined;
  const info: MediaInfo = {
    kind: 'direct',
    live: false,
    drm: false,
    videos: [],
    audios: [],
    subtitles: [],
    size: p.size ?? media.size,
    rangeSupported: p.ranges,
    container,
    analyzedAt: Date.now(),
  };
  // Read container metadata via ranged reads (a few KB) — only when ranges work.
  if (p.ranges) {
    const input = new Input({
      source: new UrlSource(p.url, { requestInit: { credentials: 'include', cache: 'no-store' }, maxCacheSize: 4 * 1024 * 1024 }),
      formats: ALL_FORMATS,
    });
    try {
      await withTimeout(
        (async () => {
          const v = await input.getPrimaryVideoTrack();
          const a = await input.getPrimaryAudioTrack();
          const duration = (await input.getDurationFromMetadata().catch(() => null)) ?? undefined;
          info.duration = duration ?? undefined;
          if (v) {
            const hdr = await v.hasHighDynamicRange().catch(() => false);
            const codecs = (await v.getCodecParameterString().catch(() => null)) ?? v.codec ?? undefined;
            const h = v.displayHeight;
            info.videos.push({
              id: 'v:main',
              url: p.url,
              width: v.displayWidth,
              height: h,
              codecs,
              hdr,
              label: qualityLabel(h, undefined, hdr),
              size: info.size,
              hasAudio: !!a,
            });
          }
          if (a) {
            info.audios.push({
              id: 'a:main',
              codecs: a.codec ?? undefined,
              channels: a.numberOfChannels,
              name: [a.codec?.toUpperCase(), a.numberOfChannels > 2 ? `${a.numberOfChannels}ch` : ''].filter(Boolean).join(' '),
            });
          }
        })(),
        9000,
      );
    } catch {
      /* metadata optional */
    } finally {
      input.dispose();
    }
  }
  if (info.duration && info.size && !info.videos[0]?.bandwidth && info.videos[0]) {
    info.videos[0].bandwidth = Math.round((info.size * 8) / info.duration);
  }
  return info;
}
