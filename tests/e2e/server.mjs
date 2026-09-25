// Tiny media server for E2E tests: Range support, a Referer-protected path, a throttled path
// and synthetic "player" pages.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MEDIA = new URL('../fixtures/media/', import.meta.url).pathname;
const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mpdx': 'application/dash+xml',
  '.bin': 'application/octet-stream',
};

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:title" content="${title}">${head}<style>body{margin:0;background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}video{width:720px;max-width:90vw;border-radius:12px;background:#000}</style></head>
<body>${body}</body></html>`;

// Original poster art for store screenshots.
const POSTERS = {
  aurora: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050a24"/><stop offset=".55" stop-color="#10204d"/><stop offset="1" stop-color="#1b1640"/></linearGradient><linearGradient id="a" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3dffc4" stop-opacity="0"/><stop offset=".3" stop-color="#3dffc4" stop-opacity=".75"/><stop offset=".65" stop-color="#8b5cf6" stop-opacity=".65"/><stop offset="1" stop-color="#ff3d7f" stop-opacity="0"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="22"/></filter></defs><rect width="1280" height="720" fill="url(#s)"/><g filter="url(#b)"><path d="M-50 260 C 200 120 380 330 640 200 S 1050 90 1330 230 L1330 330 C 1050 200 860 400 640 300 S 200 260 -50 380Z" fill="url(#a)"/><path d="M-50 180 C 260 60 520 250 760 150 S 1100 60 1330 140 L1330 190 C 1100 120 900 260 760 220 S 260 140 -50 250Z" fill="url(#a)" opacity=".6"/></g><g fill="#fff">${Array.from({ length: 70 }, (_, i) => `<circle cx="${(i * 187) % 1280}" cy="${(i * 97) % 330}" r="${(i % 3) * 0.6 + 0.5}" opacity="${0.3 + (i % 5) * 0.12}"/>`).join('')}</g><path d="M0 560 L150 430 L240 500 L380 360 L520 520 L640 440 L760 540 L900 400 L1040 520 L1150 450 L1280 540 L1280 720 L0 720Z" fill="#0a0f26"/><path d="M0 620 L200 540 L330 600 L520 520 L700 610 L880 540 L1060 620 L1280 560 L1280 720 L0 720Z" fill="#060818"/><rect y="640" width="1280" height="80" fill="#0b1433" opacity=".9"/><path d="M0 660 h1280" stroke="#3dffc4" stroke-opacity=".25" stroke-width="3"/></svg>`,
  ocean: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e6aa8"/><stop offset=".5" stop-color="#083a6b"/><stop offset="1" stop-color="#020b22"/></linearGradient><linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bff4ff" stop-opacity=".55"/><stop offset="1" stop-color="#bff4ff" stop-opacity="0"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="8"/></filter></defs><rect width="1280" height="720" fill="url(#w)"/><g filter="url(#b)">${[180, 360, 560, 760, 980, 1140].map((x, i) => `<path d="M${x} 0 L${x + 60 + i * 8} 0 L${x - 120 + i * 20} 720 L${x - 190} 720Z" fill="url(#r)" opacity="${0.35 + (i % 3) * 0.15}"/>`).join('')}</g><g fill="#9ee7ff" opacity=".5">${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 233) % 1280}" cy="${200 + ((i * 131) % 480)}" r="${1 + (i % 4)}"/>`).join('')}</g><path d="M640 420 c90 -40 190 -20 250 30 c-60 20 -150 40 -250 10 c-40 30 -70 40 -90 30 c20 -20 30 -40 20 -60 c20 -10 50 -12 70 -10z" fill="#041a33" opacity=".85"/><path d="M0 640 C 300 590 500 690 800 640 S 1150 610 1280 650 L1280 720 L0 720Z" fill="#020714"/></svg>`,
  city: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a0b33"/><stop offset=".7" stop-color="#4a1350"/><stop offset="1" stop-color="#ff6b1a"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="640" cy="470" r="170" fill="#ff9e3d" opacity=".85"/>${Array.from({ length: 22 }, (_, i) => { const w = 40 + (i * 37) % 60; const h = 160 + (i * 89) % 300; const x = i * 60 - 20; return `<rect x="${x}" y="${720 - h}" width="${w}" height="${h}" fill="#12061f"/>` + Array.from({ length: 6 }, (_, k) => `<rect x="${x + 8}" y="${730 - h + k * 40}" width="6" height="10" fill="${k % 2 ? '#ff3d7f' : '#3dffc4'}" opacity=".7"/>`).join(''); }).join('')}</svg>`,
};

const PAGES = {
  'demo-hls': () =>
    page(
      'Northern Lights Over Lofoten — 4K Timelapse',
      `<video controls muted poster="/poster/aurora.svg"></video><script>fetch('/media/demo/master.m3u8')</script>`,
      '<meta property="og:image" content="/poster/aurora.svg">',
    ),
  'demo-big': () =>
    page('Deep Ocean — Episode 1: Into the Blue', `<video src="/slower/demo-big.mp4" preload="metadata" controls muted poster="/poster/ocean.svg"></video>`, '<meta property="og:image" content="/poster/ocean.svg">'),
  'demo-city': () =>
    page('Neon Nights — City Walk 1080p', `<video src="/media/direct.mp4" preload="none" controls muted poster="/poster/city.svg"></video>`, '<meta property="og:image" content="/poster/city.svg">'),
  'demo-embed': () => page('Mountain Stories — Live Session', `<iframe src="/page/mseav.html" width="760" height="440" style="border:0" allow="autoplay"></iframe>`, '<meta property="og:image" content="/poster/aurora.svg">'),
  direct: () => page('Aurora Over The Fjords', `<video src="/media/direct.mp4" controls muted autoplay loop playsinline></video>`),
  webm: () => page('Neon City Walk', `<video src="/media/direct.webm" controls muted autoplay loop></video>`),
  hls: () => page('Mountain Timelapse (HLS)', `<video controls muted poster="/poster.svg"></video><script>fetch('/protected/hls-ts/master.m3u8').then(r=>r.text())</script>`),
  aes: () => page('Encrypted Stream Test', `<video controls muted></video><script>fetch('/media/hls-aes/index.m3u8')</script>`),
  fmp4: () => page('Ocean Waves 720p', `<video controls muted></video><script>fetch('/api/stream.json').then(r=>r.json())</script>`),
  dash: () => page('City Lights (DASH)', `<video controls muted></video><script>fetch('/media/dash/manifest.mpd')</script>`),
  slow: () => page('Slow Server Test', `<video src="/slow/direct.mp4" preload="metadata" controls muted></video>`),
  multi: () =>
    page(
      'Three Videos Page',
      `<div style="display:grid;gap:16px"><video src="/media/direct.mp4" controls muted autoplay loop></video><video src="/media/direct.webm" controls muted autoplay loop></video><video controls muted></video></div><script>fetch('/media/hls-ts/master.m3u8')</script>`,
    ),
  embed: () => page('Embedded Player Page', `<iframe src="/page/mseav.html" width="760" height="440" style="border:0" allow="autoplay"></iframe>`),
  mseav: () =>
    page(
      'Hidden Stream Player',
      `<video id="v" muted autoplay controls></video><script>
const v = document.getElementById('v');
const ms = new MediaSource();
v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  const vb = ms.addSourceBuffer('video/webm; codecs="vp9"');
  const ab = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const append = (sb, b) => new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  await append(vb, await get('/media/mse-webm/init.webm'));
  await append(ab, await get('/media/mse-webm-audio/init.webm'));
  window.__inits = true;
  // Wait for the user to press record, like a player that streams as you watch.
  while (!window.__go) await new Promise((r) => setTimeout(r, 100));
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(3, '0');
    await append(vb, await get('/media/mse-webm/seg-' + n + '.webm'));
    await append(ab, await get('/media/mse-webm-audio/seg-' + n + '.webm'));
    await new Promise((r) => setTimeout(r, 150));
  }
  ms.endOfStream();
  window.__done = true;
});
</script>`,
    ),
  mse: () =>
    page(
      'Obfuscated Player (MSE)',
      `<video id="v" muted autoplay controls></video><script>
const v = document.getElementById('v');
const ms = new MediaSource();
v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
  const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const append = (b) => new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  await append(await get('/media/mse-webm/init.webm'));
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 350));
    await append(await get('/media/mse-webm/seg-' + String(i).padStart(3, '0') + '.webm'));
  }
  ms.endOfStream();
  window.__done = true;
});
</script>`,
    ),
  slower: () => page('Aurora Over The Fjords', `<video src="/slower/direct.mp4" preload="metadata" controls muted poster="/poster.svg"></video>`),
};

export function startServer(port = 0) {
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/page/')) {
      const name = path.slice(6).replace(/\.html$/, '');
      if (!PAGES[name]) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGES[name]());
    }
    if (path.startsWith('/poster/')) {
      const name = path.slice(8).replace(/\.svg$/, '');
      if (!POSTERS[name]) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(POSTERS[name]);
    }
    if (path === '/poster.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1b2a6b"/><stop offset="1" stop-color="#6b1b52"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><path d="M0 300 L160 170 L260 250 L380 120 L640 300 L640 360 L0 360Z" fill="#0c0f24"/></svg>`);
    }
    if (path === '/api/stream.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ video: { title: 'Ocean', sources: { hls: `${base}/protected/hls-fmp4/master.m3u8` } } }).replace(/\//g, '\\/'));
    }
    let prefix = ['/media/', '/protected/', '/slow/', '/slower/'].find((p) => path.startsWith(p));
    if (!prefix) return res.writeHead(404).end();
    if (prefix === '/protected/') {
      const ref = req.headers.referer || '';
      if (!ref.startsWith(`${base}/page/`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('missing referer');
      }
    }
    const file = normalize(join(MEDIA, decodeURIComponent(path.slice(prefix.length))));
    if (!file.startsWith(MEDIA) || !existsSync(file)) return res.writeHead(404).end();
    const size = statSync(file).size;
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      start = m[1] ? +m[1] : size - +m[2];
      end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
    if (prefix === '/slow/' || prefix === '/slower/') {
      // Throttle per connection → parallel lanes make a visible difference.
      const delay = prefix === '/slow/' ? 80 : 420;
      stream.on('data', (chunk) => {
        stream.pause();
        res.write(chunk);
        setTimeout(() => stream.resume(), delay);
      });
      stream.on('end', () => res.end());
      req.on('close', () => stream.destroy());
    } else stream.pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { base } = await startServer(+(process.argv[2] || 8765));
  console.log('Grabbit test server on', base);
}
