// Shared domain types for Grabbit.

export type MediaKind = 'direct' | 'hls' | 'dash';
export type DetectSource = 'network' | 'dom' | 'hook' | 'json' | 'meta';

/** A media resource sniffed on a page. */
export interface DetectedMedia {
  id: string;
  tabId: number;
  frameId?: number;
  url: string;
  kind: MediaKind;
  mime?: string;
  /** Byte size for direct media when known. */
  size?: number;
  pageUrl: string;
  pageTitle?: string;
  title?: string;
  thumbnail?: string;
  duration?: number;
  /** Width/height hints (from DOM or URL patterns). */
  width?: number;
  height?: number;
  /** Request headers captured from the page's own request, replayed on download. */
  headers?: Record<string, string>;
  audioOnly?: boolean;
  drm?: boolean;
  live?: boolean;
  detectedAt: number;
  source: DetectSource;
  /** Items sharing a groupKey are quality variants of the same video (direct files). */
  groupKey?: string;
  info?: MediaInfo;
  analyzing?: boolean;
  error?: string;
  /** True when the URL is a child resource of a detected manifest (hidden in UI). */
  hidden?: boolean;
}

export interface VideoVariant {
  id: string;
  url?: string;
  width?: number;
  height?: number;
  fps?: number;
  bandwidth?: number;
  codecs?: string;
  hdr?: boolean;
  label: string;
  /** Estimated bytes (bandwidth × duration, or real size). */
  size?: number;
  /** HLS: EXT-X-MEDIA audio group this variant references. */
  audioGroup?: string;
  subtitleGroup?: string;
  /** Whether this variant carries its own audio. */
  hasAudio?: boolean;
}

export interface AudioTrackInfo {
  id: string;
  url?: string;
  lang?: string;
  name?: string;
  codecs?: string;
  bandwidth?: number;
  channels?: number;
  isDefault?: boolean;
  groupId?: string;
  size?: number;
}

export interface SubtitleTrackInfo {
  id: string;
  url?: string;
  lang?: string;
  name?: string;
  format: 'vtt' | 'ttml' | 'srt' | 'unknown';
  groupId?: string;
}

/** The result of analyzing a DetectedMedia (manifest parsing / probing). */
export interface MediaInfo {
  kind: MediaKind;
  duration?: number;
  live: boolean;
  drm: boolean;
  videos: VideoVariant[];
  audios: AudioTrackInfo[];
  subtitles: SubtitleTrackInfo[];
  container?: string;
  size?: number;
  rangeSupported?: boolean;
  childUrls?: string[];
  analyzedAt: number;
}

export type OutputContainer = 'auto' | 'mp4' | 'mkv' | 'original';
export type QualityPreset = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360' | 'smallest' | 'audio';
export type CodecPreference = 'quality' | 'compatible';

/** What the user asked to download. */
export interface JobRequest {
  url: string;
  kind: MediaKind;
  pageUrl: string;
  title: string;
  thumbnail?: string;
  headers?: Record<string, string>;
  /** Chosen video variant (HLS/DASH). */
  videoId?: string;
  /** Chosen audio rendition (HLS/DASH). */
  audioId?: string;
  subtitleIds?: string[];
  /** Resolved choices (manifests can rotate tokens, so we keep URL + attributes to re-match). */
  video?: VideoVariant;
  audio?: AudioTrackInfo;
  subtitles?: SubtitleTrackInfo[];
  /** Direct: an extra audio file to merge in (e.g. split audio/video sites). */
  audioUrl?: string;
  audioOnly?: boolean;
  /** Set for "record while playing" jobs: already-captured OPFS files to mux. */
  recorded?: { path: string; role: 'video' | 'audio' | 'av' }[];
  container: OutputContainer;
  qualityLabel: string;
  estimatedSize?: number;
  duration?: number;
  live?: boolean;
  tabId?: number;
}

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'recording'
  | 'paused'
  | 'muxing'
  | 'saving'
  | 'done'
  | 'error'
  | 'canceled';

export interface Job {
  id: string;
  request: JobRequest;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  filename: string;
  site: string;
  totalBytes?: number;
  doneBytes: number;
  totalParts: number;
  doneParts: number;
  /** Compact per-cell state string for the segment mosaic: 0 pending, 1 active, 2 done, 3 retrying. */
  mosaic?: string;
  speed: number;
  /** Recent speed samples (bytes/s) for the sparkline. */
  speedHistory?: number[];
  eta?: number;
  connections: number;
  muxProgress?: number;
  error?: string;
  downloadId?: number;
  outputSize?: number;
  savedPath?: string;
  resumable?: boolean;
  warning?: string;
  /** Files produced by this job. */
  outputs?: { name: string; downloadId?: number; size?: number }[];
}

export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'preparing', 'downloading', 'recording', 'muxing', 'saving'];
export const isActive = (j: Job) => ACTIVE_STATUSES.includes(j.status);
