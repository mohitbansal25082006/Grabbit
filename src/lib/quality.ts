// Quality selection & manifest → MediaInfo mapping (pure functions, unit-tested).
import type { DashManifest, DashRepresentation } from './parsers/dash';
import type { HlsMaster, HlsMedia } from './parsers/hls';
import { isClearKey, isHdrRange } from './parsers/hls';
import type { AudioTrackInfo, CodecPreference, MediaInfo, QualityPreset, SubtitleTrackInfo, VideoVariant } from './types';
import { formatBitrate, hash, qualityLabel } from './util';

export type CodecFamily = 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8' | 'other' | 'unknown';

export function videoCodecFamily(codecs?: string): CodecFamily {
  if (!codecs) return 'unknown';
  const c = codecs.toLowerCase();
  if (/avc1|avc3|h264/.test(c)) return 'avc';
  if (/hvc1|hev1|dvh1|dvhe|h265/.test(c)) return 'hevc';
  if (/vp09|vp9/.test(c)) return 'vp9';
  if (/av01|av1/.test(c)) return 'av1';
  if (/vp8/.test(c)) return 'vp8';
  if (/mp4a|ac-3|ec-3|opus|flac|mp3/.test(c) && !/avc|hvc|hev|vp0|av01/.test(c)) return 'other';
  return 'other';
}

export const hasAudioCodec = (codecs?: string) => !codecs || /mp4a|ac-3|ec-3|opus|vorbis|flac|mp3|\.40\./i.test(codecs);
export const hasVideoCodec = (codecs?: string) => !codecs || /avc|hvc|hev|dvh|vp0|vp8|vp9|av01|mp4v/i.test(codecs);

const COMPAT_RANK: Record<CodecFamily, number> = { avc: 5, vp9: 3, hevc: 2, av1: 3, vp8: 2, other: 1, unknown: 4 };
const QUALITY_RANK: Record<CodecFamily, number> = { av1: 5, hevc: 4, vp9: 4, avc: 3, vp8: 1, other: 1, unknown: 2 };

const PRESET_CAP: Partial<Record<QualityPreset, number>> = { '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480, '360': 360 };

/** Choose the variant matching a preset + codec preference. */
export function pickVariant(videos: VideoVariant[], preset: QualityPreset, codec: CodecPreference = 'compatible'): VideoVariant | undefined {
  if (!videos.length) return undefined;
  const rank = codec === 'compatible' ? COMPAT_RANK : QUALITY_RANK;
  const h = (v: VideoVariant) => v.height ?? 0;
  const score = (v: VideoVariant) => [h(v), Math.round(v.fps ?? 30), rank[videoCodecFamily(v.codecs)], v.bandwidth ?? v.size ?? 0];
  const cmp = (a: VideoVariant, b: VideoVariant) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return 0;
  };
  if (preset === 'smallest') return [...videos].sort((a, b) => (a.bandwidth ?? a.size ?? 0) - (b.bandwidth ?? b.size ?? 0) || h(a) - h(b))[0];
  const cap = PRESET_CAP[preset];
  let pool = cap ? videos.filter((v) => h(v) <= cap + 8) : videos;
  if (!pool.length) pool = [[...videos].sort((a, b) => h(a) - h(b))[0]];
  const sorted = [...pool].sort(cmp);
  // Under "compatible", don't pick a lesser codec at the same height if an AVC one exists.
  return sorted[0];
}

export function pickAudio(audios: AudioTrackInfo[], group?: string, lang?: string): AudioTrackInfo | undefined {
  let pool = group ? audios.filter((a) => a.groupId === group) : audios;
  if (!pool.length) pool = audios;
  if (!pool.length) return undefined;
  const langPref = (lang || navigatorLang()).slice(0, 2).toLowerCase();
  const byLang = pool.filter((a) => a.lang?.toLowerCase().startsWith(langPref));
  const defaults = pool.filter((a) => a.isDefault);
  const cands = defaults.length ? defaults : byLang.length ? byLang : pool;
  return [...cands].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}

function navigatorLang() {
  try {
    return (globalThis.navigator?.language as string) || 'en';
  } catch {
    return 'en';
  }
}

// ───────────────────────── HLS → MediaInfo ─────────────────────────

/** Stable, collision-free id for an HLS variant (several variants may share one playlist URL). */
export const hlsVariantId = (v: { uri: string; bandwidth: number; width?: number; height?: number; codecs?: string; frameRate?: number }) =>
  `v:${hash([v.uri, v.bandwidth, v.width, v.height, v.codecs, v.frameRate].join('|'))}`;

export function hlsMasterToInfo(master: HlsMaster, sample?: HlsMedia): MediaInfo {
  const duration = sample?.totalDuration || undefined;
  const live = sample ? !sample.endList : false;
  const drm =
    master.sessionKeys.some((k) => !isClearKey(k)) || (sample ? sample.segments.some((s) => !isClearKey(s.key)) : false);

  const audios: AudioTrackInfo[] = master.renditions
    .filter((r) => r.type === 'AUDIO' && r.uri)
    .map((r) => {
      const variantBw = master.variants.filter((v) => v.audio === r.groupId && v.codecs && !hasVideoCodec(v.codecs))[0]?.bandwidth;
      return {
        id: `a:${hash(r.groupId + '|' + r.name + '|' + r.uri)}`,
        url: r.uri,
        lang: r.language,
        name: r.name,
        isDefault: r.isDefault,
        groupId: r.groupId,
        channels: r.channels ? parseInt(r.channels, 10) : undefined,
        bandwidth: variantBw,
      };
    });

  const subtitles: SubtitleTrackInfo[] = master.renditions
    .filter((r) => r.type === 'SUBTITLES' && r.uri)
    .map((r) => ({ id: `s:${hash(r.uri!)}`, url: r.uri, lang: r.language, name: r.name, format: 'vtt', groupId: r.groupId }));

  const seen = new Set<string>();
  const videos: VideoVariant[] = [];
  const audioOnlyVariants: AudioTrackInfo[] = [];
  for (const v of master.variants) {
    const isAudioOnly = !v.height && v.codecs && !hasVideoCodec(v.codecs);
    if (isAudioOnly) {
      audioOnlyVariants.push({ id: `a:${hash(v.uri)}`, url: v.uri, codecs: v.codecs, bandwidth: v.bandwidth, name: formatBitrate(v.bandwidth) });
      continue;
    }
    const dedupe = `${v.width}x${v.height}|${v.bandwidth}|${v.codecs}|${v.uri}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const bw = v.averageBandwidth || v.bandwidth;
    const hdr = isHdrRange(v.videoRange);
    const hasSepAudio = !!v.audio && audios.some((a) => a.groupId === v.audio);
    videos.push({
      id: hlsVariantId(v),
      url: v.uri,
      width: v.width,
      height: v.height,
      fps: v.frameRate,
      bandwidth: v.bandwidth,
      codecs: v.codecs,
      hdr,
      label: v.height ? qualityLabel(v.height, v.frameRate, hdr) : formatBitrate(v.bandwidth) || 'Stream',
      size: duration && bw ? Math.round((bw * duration) / 8) : undefined,
      audioGroup: v.audio,
      subtitleGroup: v.subtitles,
      hasAudio: !hasSepAudio && hasAudioCodec(v.codecs),
    });
  }
  const allAudios = [...audios, ...audioOnlyVariants];
  for (const a of allAudios) {
    if (a.bandwidth && duration) a.size = Math.round((a.bandwidth * duration) / 8);
  }
  return { kind: 'hls', duration, live, drm, videos, audios: allAudios, subtitles, analyzedAt: Date.now() };
}

export function hlsMediaToInfo(media: HlsMedia, url: string): MediaInfo {
  const drm = media.segments.some((s) => !isClearKey(s.key));
  return {
    kind: 'hls',
    duration: media.totalDuration || undefined,
    live: !media.endList,
    drm,
    videos: [{ id: `v:${hash(url)}`, url, label: 'Original', hasAudio: true }],
    audios: [],
    subtitles: [],
    analyzedAt: Date.now(),
  };
}

// ───────────────────────── DASH → MediaInfo ─────────────────────────

function langName(code?: string) {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function dashToInfo(m: DashManifest): MediaInfo {
  const firstPeriod = (r: DashRepresentation) => r.periodIndex === 0;
  const reps = m.representations.filter(firstPeriod);
  const duration = m.duration || undefined;
  const size = (bw: number) => (duration && bw ? Math.round((bw * duration) / 8) : undefined);
  const videos: VideoVariant[] = reps
    .filter((r) => r.contentType === 'video' && !r.isProtected)
    .map((r) => ({
      id: r.key,
      width: r.width,
      height: r.height,
      fps: r.frameRate,
      bandwidth: r.bandwidth,
      codecs: r.codecs,
      hdr: r.hdr,
      label: qualityLabel(r.height, r.frameRate, r.hdr),
      size: size(r.bandwidth),
      hasAudio: false,
    }));
  const audios: AudioTrackInfo[] = reps
    .filter((r) => r.contentType === 'audio' && !r.isProtected)
    .map((r) => ({
      id: r.key,
      lang: r.lang,
      name: [r.label || langName(r.lang), formatBitrate(r.bandwidth)].filter(Boolean).join(' · '),
      codecs: r.codecs,
      bandwidth: r.bandwidth,
      channels: r.channels,
      size: size(r.bandwidth),
    }));
  const subtitles: SubtitleTrackInfo[] = reps
    .filter((r) => r.contentType === 'text')
    .map((r) => ({
      id: r.key,
      lang: r.lang,
      name: r.label || langName(r.lang) || r.id,
      format: /vtt/.test(`${r.mimeType} ${r.codecs}`) ? 'vtt' : /ttml|stpp|xml/.test(`${r.mimeType} ${r.codecs}`) ? 'ttml' : 'unknown',
    }));
  const drmOnly = m.drm && !videos.length && !audios.length;
  return {
    kind: 'dash',
    duration,
    live: m.type === 'dynamic',
    drm: drmOnly || (m.drm && !videos.length),
    videos,
    audios,
    subtitles,
    analyzedAt: Date.now(),
  };
}

/** Estimated total bytes for a variant + optional separate audio. */
export function estimateSize(v?: VideoVariant, a?: AudioTrackInfo, audioOnly = false): number | undefined {
  if (audioOnly) return a?.size;
  if (!v?.size) return undefined;
  return v.size + (v.hasAudio === false && a?.size ? a.size : 0);
}
