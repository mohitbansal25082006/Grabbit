// Generate real media fixtures for end-to-end tests (requires ffmpeg: $FFMPEG or on PATH).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const FF = process.env.FFMPEG || ['/tmp/claude-0/ff/ffmpeg'].find(existsSync) || 'ffmpeg';
const OUT = new URL('./media/', import.meta.url).pathname;
const D = 20; // seconds
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const ff = (...args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const src = (w, h) => ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=30:duration=${D}`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${D}`];
const x264 = (br) => ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', br, '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'];
const aac = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'];

// 1) Direct MP4 (big enough to exercise ranged parallel chunks).
ff(...src(1280, 720), ...x264('3000k'), ...aac, '-movflags', '+faststart', join(OUT, 'direct.mp4'));

// 2) Direct WebM (VP9 + Opus).
ff(...src(640, 360), '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '96k', join(OUT, 'direct.webm'));

// 3) HLS (MPEG-TS) master with two variants.
for (const [name, w, h, br] of [['v360', 640, 360, '700k'], ['v720', 1280, 720, '2500k']]) {
  const dir = join(OUT, 'hls-ts', name);
  mkdirSync(dir, { recursive: true });
  ff(...src(w, h), ...x264(br), ...aac, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', join(dir, 'seg%03d.ts'), join(dir, 'index.m3u8'));
}
writeFileSync(
  join(OUT, 'hls-ts', 'master.m3u8'),
  `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
v720/index.m3u8
`,
);

// 4) HLS AES-128 encrypted.
{
  const dir = join(OUT, 'hls-aes');
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(16);
  writeFileSync(join(dir, 'key.bin'), key);
  writeFileSync(join(dir, 'keyinfo.txt'), `key.bin\n${join(dir, 'key.bin')}\n${randomBytes(16).toString('hex')}\n`);
  ff(...src(854, 480), ...x264('1200k'), ...aac, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_key_info_file', join(dir, 'keyinfo.txt'), '-hls_segment_filename', join(dir, 'seg%03d.ts'), join(dir, 'index.m3u8'));
}

// 5) HLS fMP4 with a separate audio rendition.
{
  const dir = join(OUT, 'hls-fmp4');
  mkdirSync(join(dir, 'video'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${D}`, ...x264('2000k'), '-an', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'video', 'seg%03d.m4s'), join(dir, 'video', 'index.m3u8'));
  ff('-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=48000:duration=${D}`, ...aac, '-vn', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(dir, 'audio', 'seg%03d.m4s'), join(dir, 'audio', 'index.m3u8'));
  writeFileSync(
    join(dir, 'master.m3u8'),
    `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2300000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
video/index.m3u8
`,
  );
}

// 6) DASH: two video representations + audio (SegmentTemplate + SegmentTimeline).
{
  const dir = join(OUT, 'dash');
  mkdirSync(dir, { recursive: true });
  ff(
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${D}`,
    '-f', 'lavfi', '-i', `sine=frequency=520:sample_rate=48000:duration=${D}`,
    '-map', '0:v', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-b:v:0', '2000k', '-s:v:0', '1280x720', '-b:v:1', '600k', '-s:v:1', '640x360',
    ...aac,
    '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    '-f', 'dash', join(dir, 'manifest.mpd'),
  );
}
// 7) WebM (VP9) DASH-style chunks for the MSE "record while playing" test.
{
  const dir = join(OUT, 'mse-webm');
  mkdirSync(dir, { recursive: true });
  ff('-f', 'lavfi', '-i', `testsrc2=size=854x480:rate=30:duration=${D}`, '-c:v', 'libvpx-vp9', '-b:v', '800k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '60', '-keyint_min', '60', '-an',
    '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0', '-dash_segment_type', 'webm', '-init_seg_name', 'init.webm', '-media_seg_name', 'seg-$Number%03d$.webm',
    '-f', 'dash', join(dir, 'manifest.mpd'));
}
// 8) Opus audio WebM chunks (second SourceBuffer for the MSE recorder test).
{
  const dir = join(OUT, 'mse-webm-audio');
  mkdirSync(dir, { recursive: true });
  ff('-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${D}`, '-c:a', 'libopus', '-b:a', '96k', '-vn',
    '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0', '-dash_segment_type', 'webm', '-init_seg_name', 'init.webm', '-media_seg_name', 'seg-$Number%03d$.webm',
    '-f', 'dash', join(dir, 'manifest.mpd'));
}
// 9) Store-screenshot demo content: a multi-quality master and a large file for a rich mosaic.
{
  const dir = join(OUT, 'demo');
  mkdirSync(dir, { recursive: true });
  const v = (bw, w, h, fps, codecs, uri) => `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${w}x${h},FRAME-RATE=${fps},CODECS="${codecs},mp4a.40.2"\n${uri}\n`;
  writeFileSync(
    join(dir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
      v(16000000, 3840, 2160, 30, 'avc1.640033', '../hls-ts/v720/index.m3u8') +
      v(9000000, 2560, 1440, 30, 'avc1.640032', '../hls-ts/v720/index.m3u8') +
      v(5200000, 1920, 1080, 60, 'avc1.64002a', '../hls-ts/v720/index.m3u8') +
      v(2800000, 1280, 720, 30, 'avc1.64001f', '../hls-ts/v720/index.m3u8') +
      v(1400000, 854, 480, 30, 'avc1.64001e', '../hls-ts/v360/index.m3u8') +
      v(900000, 640, 360, 30, 'avc1.64001e', '../hls-ts/v360/index.m3u8'),
  );
  ff('-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '40', ...x264('12000k'), ...aac, '-movflags', '+faststart', join(OUT, 'demo-big.mp4'));
}
console.log('fixtures ready in', OUT);
