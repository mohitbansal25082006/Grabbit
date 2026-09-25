import { describe, expect, it } from 'vitest';
import { expandTemplate, parseDash, parseIsoDuration, stitchPeriods } from '@/lib/parsers/dash';
import { dashToInfo } from '@/lib/quality';

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0M20.0S" minBufferTime="PT2S">
  <BaseURL>https://cdn.example.com/dash/</BaseURL>
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s"/>
      <Representation id="v720" bandwidth="2500000" width="1280" height="720" frameRate="30000/1001" codecs="avc1.64001f"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" frameRate="30" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      <SegmentTemplate timescale="48000" media="audio/$Time$.m4s" initialization="audio/init.mp4">
        <SegmentTimeline><S t="0" d="192000" r="4"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
      <Representation id="sub-en" bandwidth="256"><BaseURL>subs/en.vtt</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('DASH parser', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT1H2M3.5S')).toBeCloseTo(3723.5);
    expect(parseIsoDuration('P1DT1S')).toBe(86401);
    expect(parseIsoDuration(undefined)).toBe(0);
  });

  it('expands templates with padding', () => {
    expect(expandTemplate('$RepresentationID$/s-$Number%05d$-$Time$.m4s$$', { RepresentationID: 'v1', Number: 7, Time: 100 })).toBe('v1/s-00007-100.m4s$');
  });

  it('builds segment lists from SegmentTemplate + number and timeline', () => {
    const m = parseDash(MPD, 'https://example.com/manifest.mpd');
    expect(m.type).toBe('static');
    expect(m.duration).toBe(20);
    const v = m.representations.find((r) => r.id === 'v1080')!;
    expect(v.init?.url).toBe('https://cdn.example.com/dash/v1080/init.mp4');
    expect(v.segments).toHaveLength(5);
    expect(v.segments[4].url).toBe('https://cdn.example.com/dash/v1080/seg-00005.m4s');
    const a = m.representations.find((r) => r.id === 'a128')!;
    expect(a.segments.map((s) => s.url.split('/').pop())).toEqual(['0.m4s', '192000.m4s', '384000.m4s', '576000.m4s', '768000.m4s']);
    expect(a.channels).toBe(2);
    const t = m.representations.find((r) => r.id === 'sub-en')!;
    expect(t.contentType).toBe('text');
    expect(t.singleFile).toBe('https://cdn.example.com/dash/subs/en.vtt');
  });

  it('maps to MediaInfo with labels and sizes', () => {
    const info = dashToInfo(parseDash(MPD, 'https://example.com/manifest.mpd'));
    expect(info.videos.map((v) => v.label)).toEqual(['720p', '1080p']);
    expect(info.videos[1].size).toBe(Math.round((5_000_000 * 20) / 8));
    expect(info.audios[0].name).toContain('English');
    expect(info.subtitles[0].format).toBe('vtt');
    expect(info.drm).toBe(false);
  });

  it('detects DRM (ContentProtection) and SegmentBase single files', () => {
    const drm = `<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/><Representation id="1" bandwidth="1" width="10" height="10"><BaseURL>v.mp4</BaseURL><SegmentBase indexRange="800-999"><Initialization range="0-799"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`;
    const m = parseDash(drm, 'https://x.com/a/m.mpd');
    expect(m.drm).toBe(true);
    expect(m.representations[0].singleFile).toBe('https://x.com/a/v.mp4');
    expect(dashToInfo(m).drm).toBe(true);
  });

  it('stitches representations across periods', () => {
    const multi = `<MPD type="static" mediaPresentationDuration="PT8S"><Period duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="p1-$Number$.m4s"/><Representation id="hi" bandwidth="9" height="1080"/></AdaptationSet></Period><Period duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="p2-$Number$.m4s"/><Representation id="hi" bandwidth="9" height="1080"/></AdaptationSet></Period></MPD>`;
    const m = parseDash(multi, 'https://x.com/m.mpd');
    const chosen = m.representations[0];
    const all = stitchPeriods(m, chosen);
    expect(all).toHaveLength(2);
    expect(all.flatMap((r) => r.segments.map((s) => s.url.split('/').pop()))).toEqual(['p1-1.m4s', 'p1-2.m4s', 'p2-1.m4s', 'p2-2.m4s']);
  });
});
