// Decide whether a URL / response is downloadable media, a stream manifest, or a segment.
import type { MediaKind } from '../types';
import { extFromUrl, isBlockedUrl } from '../util';

export type Classification = { kind: MediaKind; audioOnly?: boolean } | { segment: true } | null;

const HLS_MIME = /^(application|audio)\/(x-)?(vnd\.apple\.)?mpegurl$/i;
const DASH_MIME = /^application\/dash\+xml$/i;
const SEGMENT_MIME = /^(video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/i;
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'ogv', '3gp', 'avi', 'wmv', 'f4v']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'aac']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'cmfv', 'cmfa', 'm4f', 'mp4a', 'm4v_seg', 'fmp4']);

/** Fragments in the URL path that mark a chunk of a larger stream. */
const SEGMENT_PATH = /(^|[/_\-.])(seg|segment|chunk|frag|fragment)[-_]?\d+|\/range\/\d+-\d+|(^|[/_\-.])init\.(mp4|m4s|webm)(\?|$)|[?&](range|bytestart)=/i;

export function normalizeMime(ct?: string | null): string {
  return (ct || '').split(';')[0].trim().toLowerCase();
}

export function classify(url: string, contentType?: string | null): Classification {
  if (!/^https?:/i.test(url) || isBlockedUrl(url)) return null;
  const mime = normalizeMime(contentType);
  const ext = extFromUrl(url);

  if (HLS_MIME.test(mime) || ext === 'm3u8') return { kind: 'hls' };
  if (DASH_MIME.test(mime) || ext === 'mpd') return { kind: 'dash' };
  if (SEGMENT_MIME.test(mime) || SEGMENT_EXT.has(ext)) return { segment: true };

  const isVideoMime = mime.startsWith('video/');
  const isAudioMime = mime.startsWith('audio/');
  if (isVideoMime || isAudioMime || VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
    // A generic binary mime with a non-media extension is not media.
    if (!isVideoMime && !isAudioMime && mime && !/octet-stream|binary|force-download|x-download/.test(mime)) return null;
    // Pieces of a stream a player fetches itself (seg-001.webm, init.mp4, chunk_12.mp4…).
    if (SEGMENT_PATH.test(url)) return { segment: true };
    const audioOnly = isAudioMime || (!isVideoMime && AUDIO_EXT.has(ext));
    return { kind: 'direct', audioOnly };
  }
  return null;
}

/** Query params that change per-request but don't identify the resource. */
const VOLATILE = new Set([
  'range', 'bytestart', 'byteend', 'rn', 'rbuf', '_', 'cb', 'cachebuster', 't', 'time', 'timestamp', 'ts',
  'token', 'expires', 'exp', 'e', 'st', 'sig', 'signature', 'hdnts', 'hdntl', 'hdnea', 'policy', 'key-pair-id',
  'hash', 'h', 'auth', 'acl', 'hmac', 'x-amz-signature', 'x-amz-date', 'x-amz-credential', 'x-amz-expires',
  'x-amz-security-token', 'x-amz-algorithm', 'x-amz-signedheaders', 'oe', 'oh', '_nc_ohc', '_nc_ht', '_nc_rid',
  'efg', 'ccb', 'dl', 'nc_cat', '_nc_sid', '_nc_cat', 'ssl',
]);

/** Stable identity for a media URL (ignores tokens and range parameters). */
export function identityOf(url: string): string {
  try {
    const u = new URL(url);
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !VOLATILE.has(k.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    const q = keep.map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.host}${u.pathname}${q ? '?' + q : ''}`;
  } catch {
    return url;
  }
}

/** Parse `Content-Range: bytes 0-1/12345` → 12345. */
export function totalFromContentRange(v?: string | null): number | undefined {
  const m = v?.match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** Headers we replay on download so CDNs accept our requests like the page's own. */
const REPLAY = /^(referer|origin|authorization|x-(?!client-data|browser|goog)[\w-]+)$/i;

export function pickReplayHeaders(headers?: chrome.webRequest.HttpHeader[]): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (h.value != null && REPLAY.test(h.name)) out[h.name.toLowerCase()] = h.value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Scan arbitrary text (JSON API responses, inline scripts) for media URLs. */
export function extractMediaUrls(text: string, base?: string): string[] {
  const out = new Set<string>();
  const re = /https?:(?:\\?\/){2}[^\s"'<>`]+?\.(?:m3u8|mpd|mp4|webm|m4v|mov|m4a|mp3)(?:\?[^\s"'<>`\\]*)?(?=["'\s<>`\\]|$)/gi;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) && n < 200) {
    let u = m[0].replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
    try {
      u = new URL(u, base).href;
      out.add(u);
      n++;
    } catch {
      /* ignore */
    }
  }
  return [...out];
}
