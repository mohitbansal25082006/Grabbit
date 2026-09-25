// Turn a JobRequest into concrete download tracks/parts.
import { parseDash, stitchPeriods, type DashRepresentation } from '../parsers/dash';
import { isClearKey, parseHls, seqToIv, type HlsMaster, type HlsMedia } from '../parsers/hls';
import { hasVideoCodec, hlsVariantId } from '../quality';
import type { JobRequest } from '../types';
import { extFromMime, extFromUrl, hash } from '../util';
import { fetchText, HeaderScope, probe } from './net';
import { chunkPlan } from './scheduler';

export interface KeyRef {
  uri: string;
  iv: Uint8Array;
}

export interface PlannedPart {
  url: string;
  range?: [number, number];
  key?: KeyRef;
  /** Positional tracks: absolute file offset. */
  offset?: number;
  size?: number;
  seq?: number;
  duration?: number;
  isInit?: boolean;
}

export interface LiveState {
  playlistUrl: string;
  lastSeq: number;
  targetDuration: number;
}

export type TrackRole = 'video' | 'audio' | 'av';

export interface PlannedTrack {
  name: string;
  role: TrackRole;
  mode: 'sequential' | 'positional';
  parts: PlannedPart[];
  totalSize?: number;
  live?: LiveState;
  /** Re-resolve part URLs (expired tokens). Returns parts indexed like the original list. */
  refresh?: () => Promise<PlannedPart[] | null>;
  ext?: string;
}

export interface PlannedSubtitle {
  name: string;
  lang?: string;
  /** Ordered URLs to concatenate (VTT segments or a single file). */
  urls: string[];
  format: 'vtt' | 'ttml' | 'srt' | 'unknown';
}

export interface Plan {
  tracks: PlannedTrack[];
  subtitles: PlannedSubtitle[];
  duration?: number;
  live: boolean;
  /** For direct downloads without muxing, the natural extension. */
  rawExt?: string;
  mime?: string;
}

export interface PlanContext {
  scope: HeaderScope;
  maxConnections: number;
  signal: AbortSignal;
}

export async function planJob(req: JobRequest, ctx: PlanContext): Promise<Plan> {
  if (req.kind === 'hls') return planHls(req, ctx);
  if (req.kind === 'dash') return planDash(req, ctx);
  return planDirect(req, ctx);
}

// ───────────────────────── HLS ─────────────────────────

function hlsParts(media: HlsMedia): PlannedPart[] {
  const parts: PlannedPart[] = [];
  let lastMap = '';
  for (const s of media.segments) {
    if (!isClearKey(s.key)) throw new Error('This stream is DRM-protected and cannot be downloaded.');
    if (s.map) {
      const mapKey = `${s.map.uri}|${s.map.byteRange?.offset}`;
      if (mapKey !== lastMap) {
        lastMap = mapKey;
        const br = s.map.byteRange;
        parts.push({ url: s.map.uri, range: br ? [br.offset, br.offset + br.length - 1] : undefined, isInit: true, seq: s.seq - 0.5 });
      }
    }
    const br = s.byteRange;
    parts.push({
      url: s.uri,
      range: br ? [br.offset, br.offset + br.length - 1] : undefined,
      key: s.key && s.key.method === 'AES-128' ? { uri: s.key.uri!, iv: s.key.iv ?? seqToIv(s.seq) } : undefined,
      seq: s.seq,
      duration: s.duration,
    });
  }
  return parts;
}

async function loadMedia(url: string, ctx: PlanContext): Promise<HlsMedia> {
  await ctx.scope.cover([url]);
  const { text, url: finalUrl } = await fetchText(url, ctx.signal);
  const pl = parseHls(text, finalUrl);
  if (pl.type !== 'media') throw new Error('Expected a media playlist');
  return pl;
}

function hlsTrack(name: string, role: TrackRole, url: string, media: HlsMedia, ctx: PlanContext): PlannedTrack {
  const parts = hlsParts(media);
  const track: PlannedTrack = {
    name,
    role,
    mode: 'sequential',
    parts,
    refresh: async () => {
      const fresh = await loadMedia(url, ctx);
      return hlsParts(fresh);
    },
  };
  if (!media.endList) {
    const last = media.segments[media.segments.length - 1];
    track.live = { playlistUrl: url, lastSeq: last ? last.seq : media.mediaSequence - 1, targetDuration: media.targetDuration || 6 };
  }
  return track;
}

async function planHls(req: JobRequest, ctx: PlanContext): Promise<Plan> {
  await ctx.scope.cover([req.url]);
  const { text, url: finalUrl } = await fetchText(req.url, ctx.signal);
  const pl = parseHls(text, finalUrl);
  const tracks: PlannedTrack[] = [];
  const subtitles: PlannedSubtitle[] = [];
  let videoUrl: string | undefined;
  let audioUrl: string | undefined;
  let videoHasAudio = true;

  if (pl.type === 'master') {
    const master = pl as HlsMaster;
    if (master.sessionKeys.some((k) => !isClearKey(k))) throw new Error('This stream is DRM-protected and cannot be downloaded.');
    const want = req.video;
    const variants = master.variants;
    const variant =
      (want && variants.find((v) => hlsVariantId(v) === want.id)) ||
      (want && variants.find((v) => v.height === want.height && v.bandwidth === want.bandwidth && v.codecs === want.codecs)) ||
      (want && variants.find((v) => v.height === want.height)) ||
      (!want && req.audioOnly ? undefined : [...variants].filter((v) => hasVideoCodec(v.codecs)).sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)[0]);
    videoUrl = variant?.uri ?? want?.url;

    const renditions = master.renditions.filter((r) => r.type === 'AUDIO' && r.uri);
    const wantA = req.audio;
    const group = variant?.audio;
    const audio =
      (wantA && renditions.find((r) => `a:${hash(r.groupId + '|' + r.name + '|' + r.uri)}` === wantA.id)) ||
      (wantA && renditions.find((r) => r.name === wantA.name && r.language === wantA.lang && (!group || r.groupId === group))) ||
      (group ? renditions.filter((r) => r.groupId === group).sort((a, b) => +b.isDefault - +a.isDefault)[0] : undefined);
    audioUrl = audio?.uri ?? (wantA?.url && !variants.some((v) => v.uri === wantA.url) ? wantA.url : undefined);
    // An audio-only variant (listed as a stream, not a rendition).
    if (!audioUrl && wantA?.url && variants.some((v) => v.uri === wantA.url)) {
      if (req.audioOnly) videoUrl = wantA.url;
    }
    videoHasAudio = !audioUrl;
    if (req.audioOnly && audioUrl) videoUrl = undefined;

    for (const s of req.subtitles ?? []) {
      if (!s.url) continue;
      try {
        const m = await loadMedia(s.url, ctx);
        subtitles.push({ name: s.name || s.lang || 'subtitles', lang: s.lang, urls: m.segments.map((x) => x.uri), format: 'vtt' });
      } catch {
        /* subtitles are best-effort */
      }
    }
  } else {
    videoUrl = finalUrl;
  }

  let duration: number | undefined;
  let live = false;
  if (videoUrl) {
    const media = pl.type === 'media' && videoUrl === finalUrl ? pl : await loadMedia(videoUrl, ctx);
    const t = hlsTrack('video', audioUrl || req.audioOnly ? (videoHasAudio ? 'av' : 'video') : 'av', videoUrl, media, ctx);
    tracks.push(t);
    duration = media.totalDuration;
    live = !!t.live;
  }
  if (audioUrl) {
    const media = await loadMedia(audioUrl, ctx);
    const t = hlsTrack('audio', 'audio', audioUrl, media, ctx);
    tracks.push(t);
    duration ??= media.totalDuration;
    live ||= !!t.live;
  }
  if (!tracks.length) throw new Error('No playable stream found in this playlist');
  await ctx.scope.cover(tracks.flatMap((t) => [...new Set(t.parts.map((p) => p.url))].slice(0, 20)).concat(tracks.flatMap((t) => t.parts.filter((p) => p.key).map((p) => p.key!.uri)).slice(0, 5)));
  return { tracks, subtitles, duration, live };
}

// ───────────────────────── DASH ─────────────────────────

async function planDash(req: JobRequest, ctx: PlanContext): Promise<Plan> {
  await ctx.scope.cover([req.url]);
  const { text, url: finalUrl } = await fetchText(req.url, ctx.signal);
  const m = parseDash(text, finalUrl);
  if (m.type === 'dynamic') throw new Error('Live DASH streams can’t be downloaded directly — use “Record while playing”.');
  const reps = m.representations.filter((r) => r.periodIndex === 0 && !r.isProtected);
  const byKey = (key?: string) => (key ? reps.find((r) => r.key === key) : undefined);

  const videos = reps.filter((r) => r.contentType === 'video');
  const audios = reps.filter((r) => r.contentType === 'audio');
  if (!videos.length && !audios.length) throw new Error('This stream is DRM-protected and cannot be downloaded.');

  let video = req.audioOnly ? undefined : byKey(req.videoId) ?? (req.video ? videos.find((v) => v.height === req.video!.height) : undefined) ?? [...videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)[0];
  const audio = byKey(req.audioId) ?? [...audios].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (req.audioOnly && !audio) video = [...videos].sort((a, b) => a.bandwidth - b.bandwidth)[0];

  const tracks: PlannedTrack[] = [];
  if (video) tracks.push(await dashTrack('video', audio || req.audioOnly ? 'video' : 'av', stitchPeriods(m, video), ctx));
  if (audio) tracks.push(await dashTrack('audio', 'audio', stitchPeriods(m, audio), ctx));

  const subtitles: PlannedSubtitle[] = [];
  for (const s of req.subtitles ?? []) {
    const rep = reps.find((r) => r.key === s.id);
    if (!rep) continue;
    const urls = rep.singleFile ? [rep.singleFile] : [...(rep.init ? [rep.init.url] : []), ...rep.segments.map((x) => x.url)];
    subtitles.push({ name: s.name || s.lang || 'subtitles', lang: s.lang, urls, format: s.format });
  }
  return { tracks, subtitles, duration: m.duration, live: false };
}

async function dashTrack(name: string, role: TrackRole, reps: DashRepresentation[], ctx: PlanContext): Promise<PlannedTrack> {
  // Single progressive file (SegmentBase / bare BaseURL) → ranged parallel download.
  if (reps.length === 1 && reps[0].singleFile) {
    const t = await directTrack(name, role, reps[0].singleFile, ctx);
    return t;
  }
  const parts: PlannedPart[] = [];
  let lastInit = '';
  for (const r of reps) {
    if (r.singleFile) {
      parts.push({ url: r.singleFile });
      continue;
    }
    if (r.init) {
      const k = `${r.init.url}|${r.init.range?.join('-')}`;
      if (k !== lastInit) {
        lastInit = k;
        parts.push({ url: r.init.url, range: r.init.range, isInit: true });
      }
    }
    for (const s of r.segments) parts.push({ url: s.url, range: s.range, duration: s.duration });
  }
  await ctx.scope.cover([...new Set(parts.map((p) => p.url))].slice(0, 20));
  return { name, role, mode: 'sequential', parts };
}

// ───────────────────────── Direct ─────────────────────────

async function directTrack(name: string, role: TrackRole, url: string, ctx: PlanContext): Promise<PlannedTrack> {
  await ctx.scope.cover([url]);
  const p = await probe(url, ctx.signal);
  if (p.url !== url) await ctx.scope.cover([p.url]);
  const ext = extFromMime(p.mime) || extFromUrl(p.url) || extFromUrl(url) || undefined;
  if (p.ranges && p.size && p.size > 0) {
    const { chunk, count } = chunkPlan(p.size, ctx.maxConnections);
    const parts: PlannedPart[] = [];
    for (let i = 0; i < count; i++) {
      const start = i * chunk;
      const end = Math.min(p.size, start + chunk) - 1;
      parts.push({ url: p.url, range: [start, end], offset: start, size: end - start + 1 });
    }
    return { name, role, mode: 'positional', parts, totalSize: p.size, ext };
  }
  // No range support → one streamed connection.
  return { name, role, mode: 'positional', parts: [{ url: p.url, offset: 0, size: p.size }], totalSize: p.size, ext };
}

async function planDirect(req: JobRequest, ctx: PlanContext): Promise<Plan> {
  const tracks: PlannedTrack[] = [await directTrack('main', req.audioUrl ? 'video' : 'av', req.url, ctx)];
  if (req.audioUrl) tracks.push(await directTrack('audio', 'audio', req.audioUrl, ctx));
  return { tracks, subtitles: [], duration: req.duration, live: false, rawExt: tracks[0].ext };
}
