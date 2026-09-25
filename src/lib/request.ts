// Turn a detected media item + user choices into a concrete download request.
import { estimateSize, pickAudio, pickVariant } from './quality';
import { presetForHost, type Settings } from './settings';
import type { DetectedMedia, JobRequest, OutputContainer, QualityPreset } from './types';
import { cleanTitle, extFromMime, extFromUrl, formatBytes, hostOf, qualityLabel } from './util';

export interface Choice {
  videoId?: string;
  audioId?: string;
  audioOnly?: boolean;
  container?: OutputContainer;
  subtitleIds?: string[];
  preset?: QualityPreset;
  title?: string;
}

export function titleFor(item: DetectedMedia): string {
  return cleanTitle(item.title || item.pageTitle, hostOf(item.pageUrl));
}

export function buildRequest(item: DetectedMedia, s: Settings, choice: Choice = {}): JobRequest {
  const info = item.info;
  const preset = choice.preset ?? presetForHost(s, hostOf(item.pageUrl));
  const audioOnly = choice.audioOnly ?? (preset === 'audio' || !!item.audioOnly);
  const base: JobRequest = {
    url: item.url,
    kind: item.kind,
    pageUrl: item.pageUrl,
    title: choice.title || titleFor(item),
    thumbnail: item.thumbnail?.startsWith('data:') && item.thumbnail.length > 120_000 ? undefined : item.thumbnail,
    headers: item.headers,
    container: choice.container ?? s.container,
    qualityLabel: '',
    duration: item.duration ?? info?.duration,
    live: item.live ?? info?.live,
    audioOnly,
    tabId: item.tabId,
  };

  if (item.kind === 'direct') {
    const v = info?.videos[0];
    const h = v?.height ?? item.height;
    const ext = (info?.container || extFromUrl(item.url) || extFromMime(item.mime) || 'mp4').toUpperCase();
    base.qualityLabel = audioOnly ? 'Audio' : h ? qualityLabel(h, v?.fps, v?.hdr) : ext;
    base.estimatedSize = item.size ?? info?.size;
    return base;
  }

  if (!info) {
    base.qualityLabel = audioOnly ? 'Audio' : 'Best';
    return base;
  }

  const video = choice.videoId ? info.videos.find((v) => v.id === choice.videoId) : pickVariant(info.videos, preset === 'audio' ? 'best' : preset, s.codec);
  const needsAudio = audioOnly || (video ? video.hasAudio === false : true);
  const audio = choice.audioId
    ? info.audios.find((a) => a.id === choice.audioId)
    : needsAudio
      ? pickAudio(info.audios, video?.audioGroup)
      : undefined;

  if (audioOnly) {
    base.audioId = audio?.id;
    base.audio = audio;
    // HLS with muxed audio only: download the smallest video variant and extract its audio.
    if (!audio && info.videos.length) {
      base.video = pickVariant(info.videos, 'smallest');
      base.videoId = base.video?.id;
    }
    base.qualityLabel = 'Audio';
    base.estimatedSize = audio?.size;
    return base;
  }
  base.videoId = video?.id;
  base.audioId = audio?.id;
  base.video = video;
  base.audio = audio;
  base.subtitleIds = choice.subtitleIds ?? (s.saveSubtitles && info.subtitles[0] ? [pickSub(info, video?.subtitleGroup)] : undefined);
  base.subtitles = base.subtitleIds?.map((id) => info.subtitles.find((x) => x.id === id)).filter((x) => !!x);
  base.qualityLabel = video?.label ?? 'Best';
  base.estimatedSize = estimateSize(video, audio);
  return base;
}

function pickSub(info: NonNullable<DetectedMedia['info']>, group?: string): string {
  const lang = (globalThis.navigator?.language || 'en').slice(0, 2);
  const pool = group ? info.subtitles.filter((s) => s.groupId === group) : info.subtitles;
  const list = pool.length ? pool : info.subtitles;
  return (list.find((s) => s.lang?.startsWith(lang)) ?? list[0]).id;
}

export function describeItem(item: DetectedMedia): string {
  const parts: string[] = [];
  const info = item.info;
  if (item.kind === 'direct') {
    const v = info?.videos[0];
    const h = v?.height ?? item.height;
    if (h) parts.push(qualityLabel(h, v?.fps, v?.hdr));
    parts.push((info?.container || extFromUrl(item.url) || extFromMime(item.mime) || 'file').toUpperCase());
    if (item.size) parts.push(formatBytes(item.size));
  } else {
    parts.push(item.kind.toUpperCase());
    if (info?.videos.length) {
      const top = pickVariant(info.videos, 'best');
      if (top) parts.push(`up to ${top.label}`);
      if (info.videos.length > 1) parts.push(`${info.videos.length} qualities`);
    }
    if (info?.audios.length && info.audios.length > 1) parts.push(`${info.audios.length} audio`);
  }
  return parts.join(' · ');
}
