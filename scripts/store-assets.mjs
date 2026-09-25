// Generates every Chrome Web Store image for Grabbit:
//   store/icon-128.png                 store icon (96px artwork + 16px padding)
//   store/screenshots/01-05-*.png      1280×800 listing screenshots (real UI, branded frame)
//   store/promo-small-440x280.png      small promo tile
//   store/promo-marquee-1400x560.png   marquee promo tile
//
// Requires: `npm run build` and `npm run fixtures` first.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { startServer } from '../tests/e2e/server.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const EXT = `${ROOT}.output/chrome-mv3`;
const OUT = `${ROOT}store`;
const BUILD = `${OUT}/.build`;
const RAW = `${BUILD}/raw`;
const EXEC = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
for (const f of [`${EXT}/manifest.json`, `${ROOT}tests/fixtures/media/demo-big.mp4`]) {
  if (!existsSync(f)) throw new Error(`Missing ${f} — run "npm run build" and "npm run fixtures" first.`);
}
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
mkdirSync(`${BUILD}/screenshots`, { recursive: true });
mkdirSync(`${OUT}/screenshots`, { recursive: true });

const LOGO_PATH =
  'M11.2 2.4c1.9 0 2.9 3 2.9 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6.9-6.6 2.8-6.6Zm9.6 0c1.9 0 2.8 3 2.8 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6 1-6.6 2.9-6.6ZM16 11.4c5 0 9 3.9 9 8.8S21 29.6 16 29.6s-9-4.5-9-9.4 4-8.8 9-8.8Z';
const logoSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="hl" cx="22%" cy="12%" r="75%"><stop offset="0" stop-color="#FFB23D"/><stop offset="1" stop-color="#FFB23D" stop-opacity="0"/></radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF6B1A"/><stop offset="1" stop-color="#FF3D7F"/></linearGradient>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="38" fill="url(#bg)"/>
  <rect x="0" y="0" width="128" height="128" rx="38" fill="url(#hl)"/>
  <rect x=".5" y=".5" width="127" height="127" rx="37.5" fill="none" stroke="#fff" stroke-opacity=".28"/>
  <g transform="translate(20 17) scale(2.75)">
    <path fill="#fff" d="${LOGO_PATH}"/>
    <path fill="none" stroke="#FF5A2A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M16 16.2v7.2m-3.2-3.1 3.2 3.2 3.2-3.2"/>
  </g>
</svg>`;

const fontUrl = (p) => `file://${ROOT}node_modules/@fontsource-variable/${p}`;
const BASE_CSS = `
@font-face{font-family:'SG';src:url('${fontUrl('space-grotesk/files/space-grotesk-latin-wght-normal.woff2')}') format('woff2');font-weight:300 700}
@font-face{font-family:'JB';src:url('${fontUrl('jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2')}') format('woff2');font-weight:100 800}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%}
body{font-family:'SG',system-ui,sans-serif;color:#F4F1FF;background:#0B0816;overflow:hidden;position:relative;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;background:
  radial-gradient(55% 60% at 0% 0%,rgba(255,107,26,.30),transparent 70%),
  radial-gradient(50% 60% at 100% 100%,rgba(139,92,246,.30),transparent 70%),
  radial-gradient(40% 40% at 85% 10%,rgba(255,61,127,.12),transparent 70%)}
.rings{position:absolute;inset:0;background:repeating-radial-gradient(circle at 78% 58%,transparent 0 46px,rgba(255,255,255,.028) 46px 47px)}
.grain{position:absolute;inset:0;opacity:.08;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.brand{position:absolute;display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.04em}
.brand svg{border-radius:28%;box-shadow:0 10px 30px -10px rgba(255,90,42,.8)}
.kicker{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 14px;border-radius:99px;font:700 13px 'JB',monospace;letter-spacing:.08em;text-transform:uppercase;color:#FF8A3D;background:rgba(255,107,26,.12);border:1px solid rgba(255,107,26,.35)}
h1{font-weight:800;letter-spacing:-.045em;line-height:1.02}
.grad{background:linear-gradient(135deg,#FF6B1A,#FF3D7F);-webkit-background-clip:text;background-clip:text;color:transparent}
p.lead{color:#B8B1D6;line-height:1.5}
ul.feat{list-style:none;padding:0;display:grid;gap:12px}
ul.feat li{display:flex;gap:12px;align-items:center;font-size:18px;font-weight:600;color:#E6E1FA}
ul.feat li b{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,#FF6B1A,#FF3D7F);color:#fff;font-size:14px;flex-shrink:0}
.shot{position:absolute;border-radius:22px;overflow:hidden;border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 90px -30px rgba(0,0,0,.9),0 0 0 1px rgba(0,0,0,.4),0 0 80px -20px rgba(255,107,26,.35)}
.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.window{position:absolute;border-radius:18px;overflow:hidden;border:1px solid rgba(255,255,255,.14);background:#0B0816;box-shadow:0 40px 100px -30px rgba(0,0,0,.95),0 0 100px -30px rgba(255,107,26,.35)}
.window .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#17112b;border-bottom:1px solid rgba(255,255,255,.08)}
.window .bar i{width:11px;height:11px;border-radius:50%;background:#3a3354}
.window .bar i:nth-child(1){background:#ff5f57}.window .bar i:nth-child(2){background:#febc2e}.window .bar i:nth-child(3){background:#28c840}
.window .bar span{margin-left:14px;flex:1;height:24px;border-radius:8px;background:#0e0a1c;color:#8e87ad;font:500 12px 'JB',monospace;display:flex;align-items:center;padding:0 12px}
.window img{display:block;width:100%}
.window::after{content:'';position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(transparent,#0B0816);pointer-events:none}
.chip{position:absolute;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:14px;background:rgba(20,14,38,.92);border:1px solid rgba(255,255,255,.14);font-weight:700;font-size:15px;box-shadow:0 20px 40px -18px rgba(0,0,0,.9)}
.chip em{font-style:normal;font-family:'JB',monospace;color:#FF8A3D}
.dot{width:9px;height:9px;border-radius:50%;background:#3DFFC4;box-shadow:0 0 12px #3DFFC4}
`;

function brand(size = 34, font = 24, pos = 'left:56px;top:48px') {
  return `<div class="brand" style="${pos};font-size:${font}px">${logoSvg(size)}Grabbit</div>`;
}

function sidePage({ kicker, title, lead, bullets, img, imgW, chips = '' }) {
  const h = Math.round((imgW * 600) / 408);
  return `<div class="bg"></div><div class="rings"></div><div class="grain"></div>${brand()}
  <div style="position:absolute;left:56px;top:150px;width:560px;display:flex;flex-direction:column;gap:24px">
    <span class="kicker">${kicker}</span>
    <h1 style="font-size:60px">${title}</h1>
    <p class="lead" style="font-size:21px">${lead}</p>
    <ul class="feat">${bullets.map((b) => `<li><b>✓</b>${b}</li>`).join('')}</ul>
  </div>
  <div class="shot" style="right:120px;top:${Math.round((800 - h) / 2)}px;width:${imgW}px;height:${h}px"><img src="${img}"></div>${chips}`;
}

function topPage({ kicker, title, img, url, width = 1120, top = 196 }) {
  return `<div class="bg"></div><div class="rings"></div><div class="grain"></div>${brand(30, 21, 'right:56px;top:44px')}
  <div style="position:absolute;left:80px;top:40px;display:flex;flex-direction:column;gap:14px;max-width:960px">
    <span class="kicker" style="align-self:flex-start">${kicker}</span>
    <h1 style="font-size:46px">${title}</h1>
  </div>
  <div class="window" style="left:${(1280 - width) / 2}px;top:${top}px;width:${width}px"><div class="bar"><i></i><i></i><i></i><span>${url}</span></div><img src="${img}"></div>`;
}

// ───────────────────────── 1. Capture the real UI ─────────────────────────
const { server, base } = await startServer();
const ctx = await chromium.launchPersistentContext('', {
  executablePath: EXEC,
  headless: true,
  acceptDownloads: true,
  downloadsPath: `${BUILD}/downloads`,
  colorScheme: 'dark',
  deviceScaleFactor: 2,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const hub = await ctx.newPage();
await hub.goto(`chrome-extension://${extId}/hub.html#downloads`);
const send = (type, payload) =>
  hub.evaluate(async ([type, payload]) => {
    const r = await chrome.runtime.sendMessage({ target: 'bg', type, payload });
    if (!r?.ok) throw new Error(r?.error);
    return r.data;
  }, [type, payload]);
const tabOf = (name) => hub.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/page/${name}.html`);
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 200));
  }
};
async function open(name) {
  const p = await ctx.newPage();
  await p.goto(`${base}/page/${name}.html`);
  await p.waitForTimeout(1500);
  return { p, tab: await tabOf(name) };
}
async function popupFor(tab) {
  const pop = await ctx.newPage();
  await pop.setViewportSize({ width: 408, height: 600 });
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  return pop;
}

console.log('• popup: quality dial');
const hls = await open('demo-hls');
{
  const pop = await popupFor(hls.tab);
  await pop.locator('.dial').waitFor({ timeout: 15000 }).catch(async (e) => { await pop.screenshot({ path: '/tmp/claude-0/dbg-popup.png' }); throw e; });
  await pop.waitForTimeout(900);
  await pop.screenshot({ path: `${RAW}/popup-dial.png` });
  await pop.close();
}

console.log('• hub: finished + live download');
{
  const city = await open('demo-city');
  const it = (await send('media.list', { tabId: city.tab })).items[0];
  const j1 = await send('quick.grab', { tabId: city.tab, itemId: it.id });
  const h = (await send('media.list', { tabId: hls.tab })).items.find((i) => i.kind === 'hls');
  const j2 = await send('quick.grab', { tabId: hls.tab, itemId: h.id });
  await until(async () => (await send('jobs.list')).filter((j) => [j1, j2].includes(j.id) && j.status === 'done').length === 2, 60000).catch(async (e) => {
    console.log(JSON.stringify((await send('jobs.list')).map((j) => [j.request.title, j.status, j.error, j.warning])));
    throw e;
  });
  const big = await open('demo-big');
  const bi = (await send('media.list', { tabId: big.tab })).items[0];
  const jb = await send('quick.grab', { tabId: big.tab, itemId: bi.id });
  await until(async () => {
    const j = (await send('jobs.list')).find((x) => x.id === jb);
    return j?.status === 'downloading' && j.totalBytes && j.doneBytes / j.totalBytes > 0.38;
  }, 60000);
  await hub.goto(`chrome-extension://${extId}/hub.html#downloads`);
  await hub.waitForTimeout(1600);
  await hub.screenshot({ path: `${RAW}/hub-downloads.png` });
  await send('job.action', { id: jb, action: 'cancel' });
  await big.p.close();
  await city.p.close();
}

console.log('• in-page Grab button');
{
  const { p } = await open('demo-city');
  await p.setViewportSize({ width: 1120, height: 600 });
  await p.addStyleTag({ content: 'video{width:960px!important;max-width:94vw!important}' });
  await p.waitForTimeout(400);
  const box = await p.locator('video').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(400);
  await p.mouse.move(box.x + box.width - 60, box.y + 30);
  await p.waitForTimeout(400);
  await p.mouse.click(box.x + box.width - 48, box.y + 29);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${RAW}/overlay.png` });
  await p.close();
}

console.log('• popup: record while playing');
{
  const { p, tab } = await open('demo-embed');
  const frame = p.frames().find((f) => f.url().includes('mseav'));
  await until(() => frame.evaluate(() => window.__inits === true));
  const pop = await popupFor(tab);
  const det = pop.locator('details.tools');
  await det.waitFor();
  if (!(await det.evaluate((d) => d.open))) await det.locator('summary').click();
  await det.getByLabel('Turbo 8×').check();
  await pop.getByRole('button', { name: 'Start recording' }).click();
  await pop.getByRole('button', { name: 'Stop & save' }).waitFor();
  await pop.waitForTimeout(700);
  await pop.screenshot({ path: `${RAW}/popup-record.png` });
  await pop.getByRole('button', { name: 'Stop & save' }).click();
  await pop.close();
  await p.close();
}

console.log('• settings');
await hub.goto(`chrome-extension://${extId}/hub.html#settings`);
await hub.waitForTimeout(900);
await hub.screenshot({ path: `${RAW}/settings.png` });
await ctx.close();
server.close();

// ───────────────────────── 2. Compose store images ─────────────────────────
const browser = await chromium.launch({ executablePath: EXEC });
async function render(name, w, h, body, extraCss = '') {
  const file = `${BUILD}/${name}.html`;
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${extraCss}</style></head><body style="width:${w}px;height:${h}px">${body}</body></html>`);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, omitBackground: name === 'icon-128' });
  await page.close();
  console.log('✓', `${name}.png`);
}
const raw = (f) => `file://${RAW}/${f}`;

await render(
  'screenshots/01-quality-dial',
  1280,
  800,
  sidePage({
    kicker: 'Quality Dial',
    title: 'Turn the dial.<br><span class="grad">Pick any quality.</span>',
    lead: 'Grabbit finds every stream on the page and shows each quality with codec, frame rate and an estimated file size.',
    bullets: ['4K, 1440p, 1080p, 720p… or audio only', 'HLS, DASH, MP4, WebM and more', 'MP4 or MKV — merged losslessly'],
    img: raw('popup-dial.png'),
    imgW: 408,
    chips: `<div class="chip" style="right:120px;top:40px"><span class="dot"></span>6 qualities found</div><div class="chip" style="left:600px;bottom:56px">Live size <em>estimates</em></div>`,
  }),
);
await render(
  'screenshots/02-turbo-downloads',
  1280,
  800,
  topPage({
    kicker: 'Turbo engine',
    title: 'Parallel lanes. <span class="grad">Watch every segment land.</span>',
    img: raw('hub-downloads.png'),
    url: 'Grabbit — Downloads',
  }),
);
await render(
  'screenshots/03-in-page-button',
  1280,
  800,
  topPage({
    kicker: 'One tap',
    title: 'Hover any video. <span class="grad">Grab it right there.</span>',
    img: raw('overlay.png'),
    url: 'neon-nights.example/city-walk',
  }),
);
await render(
  'screenshots/04-record-while-playing',
  1280,
  800,
  sidePage({
    kicker: 'Record while playing',
    title: 'Hidden stream?<br><span class="grad">Record it as it plays.</span>',
    lead: 'For players that hide their video links, Grabbit captures exactly what plays — even inside embedded players — and saves one clean file.',
    bullets: ['Turbo 8× finishes long videos fast', 'Auto-stops and saves at the end', 'Video + audio merged into one file'],
    img: raw('popup-record.png'),
    imgW: 408,
    chips: `<div class="chip" style="right:120px;top:40px"><span class="dot" style="background:#FF5A78;box-shadow:0 0 12px #FF5A78"></span>Recording…</div>`,
  }),
);
await render(
  'screenshots/05-settings',
  1280,
  800,
  topPage({
    kicker: 'Make it yours',
    title: 'Presets, file names, speed — <span class="grad">all your way.</span>',
    img: raw('settings.png'),
    url: 'Grabbit — Settings',
  }),
);

// Promo tiles
const dialArt = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 220 220" style="position:absolute">
  <defs><linearGradient id="dg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FF6B1A"/><stop offset="1" stop-color="#FF3D7F"/></linearGradient>
  <radialGradient id="dk" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#2e2550"/><stop offset="1" stop-color="#130e24"/></radialGradient></defs>
  ${Array.from({ length: 37 }, (_, i) => {
    const a = ((-135 + 7.5 * i - 90) * Math.PI) / 180;
    const r1 = 90, r2 = i % 6 ? 94 : 97;
    return `<line x1="${110 + r1 * Math.cos(a)}" y1="${110 + r1 * Math.sin(a)}" x2="${110 + r2 * Math.cos(a)}" y2="${110 + r2 * Math.sin(a)}" stroke="${i < 28 ? '#FF7A2E' : 'rgba(255,255,255,.2)'}" stroke-width="1.6" stroke-linecap="round"/>`;
  }).join('')}
  <path d="M54.8 165.2 A78 78 0 1 1 165.2 165.2" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="9" stroke-linecap="round"/>
  <path d="M54.8 165.2 A78 78 0 1 1 185.1 88.8" fill="none" stroke="url(#dg)" stroke-width="9" stroke-linecap="round" style="filter:drop-shadow(0 0 8px #FF6B1A)"/>
  <circle cx="110" cy="110" r="56" fill="url(#dk)" stroke="rgba(255,255,255,.16)"/>
  <circle cx="185.1" cy="88.8" r="8" fill="#FF6B1A" stroke="#0B0816" stroke-width="3"/>
  <text x="110" y="112" text-anchor="middle" font-family="SG" font-weight="800" font-size="28" fill="#fff" letter-spacing="-1">4K</text>
  <text x="110" y="132" text-anchor="middle" font-family="JB" font-weight="700" font-size="10" fill="#FF8A3D">BEST QUALITY</text>
</svg>`;

await render(
  'promo-small-440x280',
  440,
  280,
  `<div class="bg"></div><div class="grain"></div>
   <div style="position:absolute;left:30px;top:34px;display:flex;flex-direction:column;gap:12px">
     <div style="display:flex;align-items:center;gap:12px">${logoSvg(58)}<span style="font-size:40px;font-weight:800;letter-spacing:-.05em">Grabbit</span></div>
     <div style="font-size:23px;font-weight:700;line-height:1.15;letter-spacing:-.03em;margin-top:10px">Grab any video.<br><span class="grad">Fast.</span></div>
     <div style="font:600 12px 'JB',monospace;color:#B8B1D6;letter-spacing:.06em;margin-top:6px">HLS · DASH · MP4 · 4K</div>
   </div>
   <div style="position:absolute;right:-24px;top:40px;width:210px;height:210px">${dialArt(210)}</div>`,
);
await render(
  'promo-marquee-1400x560',
  1400,
  560,
  `<div class="bg"></div><div class="rings"></div><div class="grain"></div>
   <div style="position:absolute;left:90px;top:110px;display:flex;flex-direction:column;gap:22px;width:760px">
     <div style="display:flex;align-items:center;gap:18px">${logoSvg(86)}<span style="font-size:68px;font-weight:800;letter-spacing:-.05em">Grabbit</span></div>
     <div style="font-size:46px;font-weight:800;line-height:1.05;letter-spacing:-.04em">Grab web videos in the<br><span class="grad">best quality. Fast.</span></div>
     <div style="font-size:20px;color:#B8B1D6">Quality Dial · parallel turbo lanes · pause &amp; resume · record while playing</div>
   </div>
   <div style="position:absolute;right:120px;top:40px;width:480px;height:480px">${dialArt(480)}</div>`,
);

// Store icon: 96×96 artwork inside a transparent 128×128 canvas.
await render(
  'icon-128',
  128,
  128,
  `<div style="position:absolute;left:16px;top:16px;width:96px;height:96px">${logoSvg(96)}</div>`,
  'html,body{background:transparent!important}',
);
await browser.close();
rmSync(BUILD, { recursive: true, force: true });
console.log('\nStore assets written to store/');
