import { describe, expect, it } from 'vitest';
import { isClearKey, parseAttributes, parseHls, seqToIv, type HlsMaster, type HlsMedia } from '@/lib/parsers/hls';
import { hlsMasterToInfo } from '@/lib/quality';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="es",URI="audio/es.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,FRAME-RATE=30,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
v1080/index.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.2.4.L123,mp4a.40.2",VIDEO-RANGE=PQ,AUDIO="aud"
v1080hevc/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:6.0,
seg10.ts
#EXTINF:6.0,
seg11.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2"
#EXT-X-DISCONTINUITY
#EXTINF:4.5,
seg12.ts
#EXT-X-ENDLIST
`;

describe('HLS parser', () => {
  it('parses attribute lists with quoted commas', () => {
    expect(parseAttributes('A=1,B="x,y",C=abc')).toEqual({ A: '1', B: 'x,y', C: 'abc' });
  });

  it('parses a master playlist', () => {
    const m = parseHls(MASTER, 'https://cdn.example.com/show/master.m3u8') as HlsMaster;
    expect(m.type).toBe('master');
    expect(m.variants).toHaveLength(3);
    expect(m.variants[1]).toMatchObject({ width: 1920, height: 1080, frameRate: 60, bandwidth: 5_000_000, audio: 'aud' });
    expect(m.variants[1].uri).toBe('https://cdn.example.com/show/v1080/index.m3u8?token=abc');
    expect(m.renditions.filter((r) => r.type === 'AUDIO')).toHaveLength(2);
    expect(m.renditions[0].uri).toBe('https://cdn.example.com/show/audio/en.m3u8');
  });

  it('parses a media playlist with keys, IVs and discontinuities', () => {
    const p = parseHls(MEDIA, 'https://cdn.example.com/v/index.m3u8') as HlsMedia;
    expect(p.type).toBe('media');
    expect(p.segments).toHaveLength(3);
    expect(p.endList).toBe(true);
    expect(p.totalDuration).toBeCloseTo(16.5);
    expect(p.segments[0].seq).toBe(10);
    expect(p.segments[0].key?.iv?.[15]).toBe(0x0f);
    expect(p.segments[2].key?.uri).toBe('https://cdn.example.com/v/k2');
    expect(p.segments[2].discontinuity).toBe(true);
    expect(isClearKey(p.segments[0].key)).toBe(true);
  });

  it('flags SAMPLE-AES / FairPlay as DRM', () => {
    expect(isClearKey({ method: 'SAMPLE-AES', keyFormat: 'com.apple.streamingkeydelivery' })).toBe(false);
    expect(isClearKey({ method: 'AES-128', keyFormat: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' })).toBe(false);
  });

  it('resolves byte ranges including implicit offsets', () => {
    const p = parseHls(
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:1000@720\nmain.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:2000\nmain.mp4\n#EXT-X-ENDLIST`,
      'https://a.com/x/p.m3u8',
    ) as HlsMedia;
    expect(p.segments[0].map).toEqual({ uri: 'https://a.com/x/main.mp4', byteRange: { offset: 0, length: 720 } });
    expect(p.segments[0].byteRange).toEqual({ offset: 720, length: 1000 });
    expect(p.segments[1].byteRange).toEqual({ offset: 1720, length: 2000 });
  });

  it('derives the default IV from the media sequence', () => {
    const iv = seqToIv(258);
    expect([...iv.slice(14)]).toEqual([1, 2]);
    expect(iv.slice(0, 14).every((b) => b === 0)).toBe(true);
  });

  it('maps a master playlist to quality options with size estimates', () => {
    const m = parseHls(MASTER, 'https://cdn.example.com/show/master.m3u8') as HlsMaster;
    const sample = parseHls(MEDIA, 'https://cdn.example.com/v/index.m3u8') as HlsMedia;
    const info = hlsMasterToInfo(m, sample);
    expect(info.videos.map((v) => v.label)).toEqual(['360p', '1080p60', '1080p HDR']);
    expect(info.videos[0].size).toBe(Math.round((700000 * 16.5) / 8));
    expect(info.videos[1].hasAudio).toBe(false);
    expect(info.audios).toHaveLength(2);
    expect(info.subtitles).toHaveLength(1);
    expect(info.drm).toBe(false);
    expect(info.live).toBe(false);
  });

  it('gives unique ids to variants that share one playlist URL', () => {
    const m = parseHls(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\nv.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv.m3u8\n',
      'https://a.com/m.m3u8',
    ) as HlsMaster;
    const ids = hlsMasterToInfo(m).videos.map((v) => v.id);
    expect(new Set(ids).size).toBe(2);
  });
});
