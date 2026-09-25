// HLS (RFC 8216) playlist parser — master & media playlists.
import { resolveUrl } from '../util';

export interface HlsKey {
  method: string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface HlsByteRange {
  offset: number;
  length: number;
}

export interface HlsMap {
  uri: string;
  byteRange?: HlsByteRange;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  seq: number;
  byteRange?: HlsByteRange;
  key?: HlsKey;
  map?: HlsMap;
  discontinuity: boolean;
  title?: string;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codecs?: string;
  audio?: string;
  subtitles?: string;
  videoRange?: string;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name: string;
  language?: string;
  isDefault: boolean;
  autoselect: boolean;
  uri?: string;
  channels?: string;
}

export interface HlsMaster {
  type: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
  sessionKeys: HlsKey[];
}

export interface HlsMedia {
  type: 'media';
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  playlistType?: string;
  segments: HlsSegment[];
  totalDuration: number;
  iFramesOnly: boolean;
}

export type HlsPlaylist = HlsMaster | HlsMedia;

export const isHlsText = (text: string) => text.trimStart().startsWith('#EXTM3U');

/** Parse `KEY=VALUE,KEY="quoted, value"` attribute lists. */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/** Default AES-128 IV = media sequence number as a 128-bit big-endian integer. */
export function seqToIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  let n = seq;
  for (let i = 15; i >= 8 && n > 0; i--) {
    iv[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return iv;
}

function parseByteRange(s: string, prevEnd: number): HlsByteRange {
  const [len, off] = s.split('@');
  return { length: parseInt(len, 10), offset: off != null ? parseInt(off, 10) : prevEnd };
}

function parseKey(attrs: Record<string, string>, base: string): HlsKey {
  return {
    method: (attrs.METHOD || 'NONE').toUpperCase(),
    uri: attrs.URI ? resolveUrl(attrs.URI, base) : undefined,
    iv: attrs.IV ? hexToBytes(attrs.IV) : undefined,
    keyFormat: attrs.KEYFORMAT,
  };
}

/** A key we can legally & technically decrypt (plain AES-128 with identity key format). */
export const isClearKey = (k?: HlsKey) =>
  !k || k.method === 'NONE' || (k.method === 'AES-128' && (!k.keyFormat || k.keyFormat === 'identity'));

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], base: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const sessionKeys: HlsKey[] = [];
  let pending: Record<string, string> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      renditions.push({
        type: (a.TYPE || '').toUpperCase(),
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || a.LANGUAGE || 'Track',
        language: a.LANGUAGE,
        isDefault: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        uri: a.URI ? resolveUrl(a.URI, base) : undefined,
        channels: a.CHANNELS,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      sessionKeys.push(parseKey(parseAttributes(line.slice(19)), base));
    } else if (!line.startsWith('#') && pending) {
      const res = pending.RESOLUTION?.split('x');
      variants.push({
        uri: resolveUrl(line, base),
        bandwidth: parseInt(pending.BANDWIDTH || '0', 10),
        averageBandwidth: pending['AVERAGE-BANDWIDTH'] ? parseInt(pending['AVERAGE-BANDWIDTH'], 10) : undefined,
        width: res ? parseInt(res[0], 10) : undefined,
        height: res ? parseInt(res[1], 10) : undefined,
        frameRate: pending['FRAME-RATE'] ? parseFloat(pending['FRAME-RATE']) : undefined,
        codecs: pending.CODECS,
        audio: pending.AUDIO,
        subtitles: pending.SUBTITLES,
        videoRange: pending['VIDEO-RANGE'],
      });
      pending = null;
    }
  }
  return { type: 'master', variants, renditions, sessionKeys };
}

function parseMedia(lines: string[], base: string): HlsMedia {
  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType: string | undefined;
  let iFramesOnly = false;
  let key: HlsKey | undefined;
  let map: HlsMap | undefined;
  let duration = 0;
  let title: string | undefined;
  let byteRange: HlsByteRange | undefined;
  let discontinuity = false;
  let prevEnd = 0;
  let prevUri = '';
  let total = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        const v = line.slice(8);
        const c = v.indexOf(',');
        duration = parseFloat(c >= 0 ? v.slice(0, c) : v) || 0;
        title = c >= 0 ? v.slice(c + 1) || undefined : undefined;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = parseFloat(line.slice(22)) || 0;
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = parseInt(line.slice(22), 10) || 0;
      else if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = line.slice(21).trim().toUpperCase();
      else if (line.startsWith('#EXT-X-I-FRAMES-ONLY')) iFramesOnly = true;
      else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) discontinuity = true;
      else if (line.startsWith('#EXT-X-KEY:')) {
        const k = parseKey(parseAttributes(line.slice(11)), base);
        key = k.method === 'NONE' ? undefined : k;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttributes(line.slice(11));
        if (a.URI) {
          map = {
            uri: resolveUrl(a.URI, base),
            byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined,
          };
        }
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        byteRange = line.slice(17).trim() ? parseByteRange(line.slice(17).trim(), 0) : undefined;
        if (byteRange && !/@/.test(line)) byteRange.offset = -1; // resolved when URI is known
      }
      continue;
    }
    const uri = resolveUrl(line, base);
    if (byteRange && byteRange.offset < 0) byteRange.offset = uri === prevUri ? prevEnd : 0;
    const seg: HlsSegment = {
      uri,
      duration,
      seq: mediaSequence + segments.length,
      byteRange,
      key,
      map,
      discontinuity,
      title,
    };
    segments.push(seg);
    total += duration;
    if (byteRange) prevEnd = byteRange.offset + byteRange.length;
    prevUri = uri;
    duration = 0;
    title = undefined;
    byteRange = undefined;
    discontinuity = false;
  }
  return {
    type: 'media',
    targetDuration,
    mediaSequence,
    endList: endList || playlistType === 'VOD',
    playlistType,
    segments,
    totalDuration: total,
    iFramesOnly,
  };
}

export function isHdrRange(range?: string) {
  return !!range && /PQ|HLG/i.test(range);
}
