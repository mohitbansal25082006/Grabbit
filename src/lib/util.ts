// Small, dependency-free helpers shared by every context.

export function formatBytes(n?: number, digits = 1): string {
  if (n == null || !isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`;
}

export const formatSpeed = (bps?: number) => (bps ? `${formatBytes(bps)}/s` : '—');

export function formatDuration(sec?: number): string {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatEta(sec?: number): string {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function formatBitrate(bps?: number): string {
  if (!bps) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

/** Fast, stable 53-bit string hash (cyrb53) rendered as base36. */
export function hash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function resolveUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function originOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export const isHttpUrl = (u?: string): u is string => !!u && /^https?:\/\//i.test(u);

/** Hosts Grabbit deliberately never touches (YouTube is excluded by design / store policy). */
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com|ytimg\.com|youtubekids\.com)$/i;

export function isBlockedUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return BLOCKED_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Strip characters that are illegal in file names on Windows/macOS/Linux. */
export function sanitizeFilename(name: string, max = 150): string {
  let out = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
  if (out.length > max) out = out.slice(0, max).trim();
  return out || 'video';
}

export function sanitizePath(path: string): string {
  return path
    .split(/[\\/]+/)
    .map((p) => sanitizeFilename(p, 80))
    .filter(Boolean)
    .join('/');
}

export interface TemplateVars {
  title: string;
  site: string;
  quality: string;
  date?: Date;
  ext?: string;
}

/** Render a filename template like `{title} [{quality}] - {site}`. */
export function renderTemplate(tpl: string, v: TemplateVars): string {
  const d = v.date ?? new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  const map: Record<string, string> = {
    title: v.title,
    site: v.site,
    quality: v.quality,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
    timestamp: String(d.getTime()),
  };
  const out = tpl.replace(/\{(\w+)\}/g, (_, k: string) => map[k] ?? '');
  return sanitizeFilename(out.replace(/\[\s*\]|\(\s*\)/g, '').replace(/\s+-\s*$/, ''));
}

/** Clean up a page title into a nice video title (drops " - YouTube"-style suffixes, counters, etc). */
export function cleanTitle(title?: string, site?: string): string {
  if (!title) return site || 'video';
  let t = title.replace(/^\(\d+\+?\)\s*/, '').trim();
  if (site) {
    const base = site.split('.').slice(-2, -1)[0];
    if (base) t = t.replace(new RegExp(`\\s*[|\\-–—:]\\s*${escapeRe(base)}[^|\\-–—]*$`, 'i'), '');
  }
  return t.trim() || site || 'video';
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/mp2t': 'ts',
  'video/3gpp': '3gp',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

export const extFromMime = (mime?: string) => (mime ? MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? '' : '');

export function qualityLabel(height?: number, fps?: number, hdr?: boolean): string {
  if (!height) return 'Auto';
  let base: string;
  if (height >= 4000) base = '8K';
  else if (height >= 2000) base = '4K';
  else if (height >= 1400) base = '1440p';
  else base = `${height}p`;
  if (fps && fps > 32) base += Math.round(fps);
  if (hdr) base += ' HDR';
  return base;
}

/** Pull a resolution hint out of a URL (e.g. `/1280x720/`, `_720p`, `DASH_1080`). */
export function resolutionHint(url: string): { width?: number; height?: number } {
  const m = url.match(/(?:^|[^\d])(\d{3,4})x(\d{3,4})(?:[^\d]|$)/);
  if (m) return { width: +m[1], height: +m[2] };
  const p = url.match(/(?:^|[^a-z\d])(\d{3,4})p(?:\d{2})?(?:[^a-z\d]|$)/i) || url.match(/DASH_(\d{3,4})(?:[^\d]|$)/i);
  if (p) return { height: +p[1] };
  return {};
}

/** Key used to group quality variants of the same direct video. */
export function groupKeyFor(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/\d{3,4}x\d{3,4}/g, '{r}')
      .replace(/(^|[^a-z\d])\d{3,4}p(\d{2})?(?=[^a-z\d]|$)/gi, '$1{r}')
      .replace(/DASH_\d{3,4}/gi, 'DASH_{r}')
      .replace(/\/(avc1|hevc|vp9|av01)\//gi, '/{c}/');
    return u.host + path;
  } catch {
    return url;
  }
}

export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const run = () => {
    last = Date.now();
    timer = undefined;
    const a = pending!;
    pending = undefined;
    fn(...a);
  };
  const t = (...a: A) => {
    pending = a;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else if (!timer) timer = setTimeout(run, wait);
  };
  t.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  return t;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
