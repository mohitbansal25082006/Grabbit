import { describe, expect, it } from 'vitest';
import { classify, extractMediaUrls, identityOf, totalFromContentRange } from '@/lib/detect/classify';
import { AdaptiveConcurrency, backoff, chunkPlan } from '@/lib/engine/scheduler';
import { pickAudio, pickVariant } from '@/lib/quality';
import { mergeVtt, vttToSrt } from '@/lib/subtitles';
import type { VideoVariant } from '@/lib/types';
import { cleanTitle, formatBytes, groupKeyFor, isBlockedUrl, qualityLabel, renderTemplate, resolutionHint, sanitizeFilename } from '@/lib/util';

describe('classify', () => {
  it('recognizes manifests, direct media and segments', () => {
    expect(classify('https://a.com/x/master.m3u8?t=1')).toEqual({ kind: 'hls' });
    expect(classify('https://a.com/api/play', 'application/vnd.apple.mpegurl')).toEqual({ kind: 'hls' });
    expect(classify('https://a.com/m.mpd')).toEqual({ kind: 'dash' });
    expect(classify('https://a.com/v.mp4', 'video/mp4')).toEqual({ kind: 'direct', audioOnly: false });
    expect(classify('https://a.com/s.mp3', 'audio/mpeg')).toEqual({ kind: 'direct', audioOnly: true });
    expect(classify('https://a.com/seg-001.ts', 'video/mp2t')).toEqual({ segment: true });
    expect(classify('https://a.com/chunk-12.m4s')).toEqual({ segment: true });
    expect(classify('https://a.com/v/seg-001.webm', 'video/webm')).toEqual({ segment: true });
    expect(classify('https://a.com/v/init.mp4', 'video/mp4')).toEqual({ segment: true });
    expect(classify('https://a.com/v/my-video.webm', 'video/webm')).toEqual({ kind: 'direct', audioOnly: false });
    expect(classify('https://a.com/page.html', 'text/html')).toBeNull();
    expect(classify('https://a.com/video.mp4', 'text/html')).toBeNull();
  });

  it('never touches YouTube', () => {
    expect(classify('https://rr3---sn-abc.googlevideo.com/videoplayback?mime=video/mp4', 'video/mp4')).toBeNull();
    expect(isBlockedUrl('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isBlockedUrl('https://m.youtube.com/')).toBe(true);
    expect(isBlockedUrl('https://vimeo.com/1')).toBe(false);
  });

  it('builds stable identities that ignore tokens', () => {
    expect(identityOf('https://c.com/v.m3u8?token=1&id=5&exp=2')).toBe(identityOf('https://c.com/v.m3u8?id=5&token=9&exp=3'));
    expect(identityOf('https://c.com/v.m3u8?id=5')).not.toBe(identityOf('https://c.com/v.m3u8?id=6'));
  });

  it('reads Content-Range totals', () => {
    expect(totalFromContentRange('bytes 0-0/123456')).toBe(123456);
    expect(totalFromContentRange('bytes */*')).toBeUndefined();
  });

  it('extracts media URLs from JSON with escaped slashes', () => {
    const json = '{"a":"https:\\/\\/video.cdn.com\\/x\\/1280x720\\/v.mp4?tag=12","b":"https://s.com/p/master.m3u8","c":"https://s.com/img.jpg"}';
    expect(extractMediaUrls(json)).toEqual(['https://video.cdn.com/x/1280x720/v.mp4?tag=12', 'https://s.com/p/master.m3u8']);
  });
});

describe('quality selection', () => {
  const v = (h: number, codecs: string, bw: number, fps = 30): VideoVariant => ({ id: `${h}-${codecs}-${bw}`, height: h, codecs, bandwidth: bw, fps, label: `${h}p` });
  const vs = [v(360, 'avc1', 800), v(720, 'avc1', 2500), v(1080, 'avc1', 5000), v(1080, 'av01', 3000), v(2160, 'hvc1', 15000)];

  it('best picks the highest resolution', () => expect(pickVariant(vs, 'best')!.height).toBe(2160));
  it('respects caps', () => {
    expect(pickVariant(vs, '1080', 'compatible')!.codecs).toBe('avc1');
    expect(pickVariant(vs, '1080', 'quality')!.codecs).toBe('av01');
    expect(pickVariant(vs, '720')!.height).toBe(720);
    expect(pickVariant(vs, 'smallest')!.height).toBe(360);
  });
  it('falls back to the smallest when nothing fits the cap', () => expect(pickVariant([v(1080, 'avc1', 1)], '360')!.height).toBe(1080));
  it('picks default / language audio', () => {
    const a = [
      { id: 'a', lang: 'de', bandwidth: 128, groupId: 'g' },
      { id: 'b', lang: 'en', bandwidth: 96, groupId: 'g', isDefault: true },
      { id: 'c', lang: 'en', bandwidth: 256, groupId: 'h' },
    ];
    expect(pickAudio(a, 'g', 'en')!.id).toBe('b');
    expect(pickAudio(a, 'h', 'en')!.id).toBe('c');
  });
});

describe('scheduler', () => {
  it('grows while throughput improves and backs off on throttling', () => {
    const c = new AdaptiveConcurrency({ min: 2, max: 16, initial: 4 });
    let rate = 1_000_000;
    for (let i = 0; i < 12; i++) {
      c.record(rate);
      c.tick(1000, true);
      rate *= 1.2;
    }
    expect(c.limit).toBeGreaterThan(4);
    const before = c.limit;
    c.throttle();
    expect(c.limit).toBeLessThan(before);
    expect(c.limit).toBeGreaterThanOrEqual(2);
  });
  it('does not grow when not saturated', () => {
    const c = new AdaptiveConcurrency({ min: 2, max: 16, initial: 4 });
    let rate = 1000;
    for (let i = 0; i < 10; i++) {
      c.record((rate *= 2));
      c.tick(1000, false);
    }
    expect(c.limit).toBe(4);
  });
  it('plans chunks for ranged downloads', () => {
    const MB = 1024 * 1024;
    expect(chunkPlan(MB, 16)).toEqual({ chunk: MB, count: 1 });
    const p = chunkPlan(1000 * MB, 16);
    expect(p.count).toBeGreaterThanOrEqual(32);
    expect(p.chunk).toBeLessThanOrEqual(32 * MB);
    expect(p.chunk * p.count).toBeGreaterThanOrEqual(1000 * MB);
  });
  it('backoff grows and honors Retry-After', () => {
    expect(backoff(1)).toBeLessThanOrEqual(800);
    expect(backoff(10)).toBeLessThanOrEqual(30_000);
    expect(backoff(0, 5000)).toBeGreaterThanOrEqual(5000);
  });
});

describe('utils', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
  it('sanitizes file names', () => {
    expect(sanitizeFilename('a/b:c*?"<>|d. ')).toBe('a b c d');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('')).toBe('video');
  });
  it('renders templates', () => {
    expect(renderTemplate('{title} [{quality}] - {site}', { title: 'Cats', quality: '1080p', site: 'x.com' })).toBe('Cats [1080p] - x.com');
    expect(renderTemplate('{title} [{quality}]', { title: 'Cats', quality: '', site: '' })).toBe('Cats');
  });
  it('cleans titles', () => expect(cleanTitle('(3) Amazing Clip - Vimeo', 'vimeo.com')).toBe('Amazing Clip'));
  it('labels qualities', () => {
    expect(qualityLabel(2160)).toBe('4K');
    expect(qualityLabel(1080, 59.94)).toBe('1080p60');
    expect(qualityLabel(720, 30, true)).toBe('720p HDR');
  });
  it('groups direct variants', () => {
    expect(groupKeyFor('https://v.x.com/a/1280x720/f.mp4')).toBe(groupKeyFor('https://v.x.com/a/640x360/f.mp4'));
    expect(groupKeyFor('https://v.redd.it/ab/DASH_720.mp4')).toBe(groupKeyFor('https://v.redd.it/ab/DASH_1080.mp4'));
    expect(resolutionHint('https://v.redd.it/ab/DASH_720.mp4')).toEqual({ height: 720 });
    expect(resolutionHint('https://x.com/v/1920x1080/a.mp4')).toEqual({ width: 1920, height: 1080 });
  });
});

describe('subtitles', () => {
  it('merges VTT segments and converts to SRT', () => {
    const a = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.500\nHello <i>there</i>\n';
    const b = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <i>there</i>\n\n1:00:03.000 --> 1:00:04.000 align:start\n<c.yellow>World</c>\n';
    const merged = mergeVtt([a, b]);
    expect(merged.match(/-->/g)).toHaveLength(2);
    const srt = vttToSrt(merged);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n01:00:03,000 --> 01:00:04,000\nWorld\n');
  });
});
