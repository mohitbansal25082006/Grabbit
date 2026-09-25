// End-to-end tests: load the built extension in Chromium, visit test pages, grab via the real
// message paths (SW → offscreen engine → OPFS → chrome.downloads) and verify output files.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { startServer } from './server.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXT = `${ROOT}.output/chrome-mv3`;
const PROFILE = `${ROOT}tests/e2e/.profile`;
const DOWNLOADS = `${ROOT}tests/e2e/downloads`;
const SHOTS = process.env.SHOTS ? `${ROOT}tests/e2e/screenshots` : '';
const FF = process.env.FFMPEG || ['/tmp/claude-0/ff/ffmpeg'].find(existsSync) || 'ffmpeg';
const EXEC = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const only = process.argv[2];

if (!existsSync(`${EXT}/manifest.json`)) throw new Error('Build the extension first: npm run build');
rmSync(PROFILE, { recursive: true, force: true });
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const { server, base } = await startServer();
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EXEC,
  headless: true,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  viewport: { width: 1280, height: 820 },
  colorScheme: process.env.LIGHT ? 'light' : 'dark',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const extId = new URL(sw.url()).host;
const hub = await ctx.newPage();
await hub.goto(`chrome-extension://${extId}/hub.html#downloads`);
await hub.waitForTimeout(500);

const send = (type, payload) =>
  hub.evaluate(async ([type, payload]) => {
    const r = await chrome.runtime.sendMessage({ target: 'bg', type, payload });
    if (!r?.ok) throw new Error(r?.error || `no reply for ${type}`);
    return r.data;
  }, [type, payload]);

function probe(file) {
  let out = '';
  try {
    execFileSync(FF, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String(e.stderr);
  }
  const d = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return {
    duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
    video: (out.match(/Video: (\w+)/) || [])[1],
    audio: (out.match(/Audio: (\w+)/) || [])[1],
    format: (out.match(/Input #0, ([\w,]+)/) || [])[1],
    height: +((out.match(/, \d{2,5}x(\d{2,5})/) || [])[1] || 0),
  };
}
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');

async function openPage(name) {
  const p = await ctx.newPage();
  await p.goto(`${base}/page/${name}.html`);
  await p.waitForTimeout(1800);
  const tabId = await hub.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${base}/page/${name}.html`);
  return { p, tabId };
}

async function waitJob(id, timeout = 90_000, until = ['done', 'error', 'canceled']) {
  const t0 = Date.now();
  for (;;) {
    const jobs = await send('jobs.list');
    const j = jobs.find((x) => x.id === id);
    if (j && until.includes(j.status)) return j;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for job (status ${j?.status})`);
    await hub.waitForTimeout(300);
  }
}

async function savedFile(job) {
  const [d] = await hub.evaluate((id) => chrome.downloads.search({ id }), job.downloadId);
  return d?.filename;
}

const results = [];
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, 'PASS', Date.now() - t0]);
    console.log(`✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push([name, 'FAIL', Date.now() - t0, e.message]);
    console.log(`✘ ${name}: ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

async function grab(pageName, pick, choice = {}) {
  const { p, tabId } = await openPage(pageName);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = (await send('media.list', { tabId })).items;
    if (items.some(pick)) break;
    await hub.waitForTimeout(300);
  }
  const item = items.find(pick);
  assert(item, `media not detected on ${pageName}: ${JSON.stringify(items.map((i) => [i.kind, i.url, i.source]))}`);
  const analyzed = await send('media.analyze', { tabId, id: item.id });
  const jobId = await send('quick.grab', { tabId, itemId: item.id, choice });
  return { p, tabId, item: analyzed ?? item, jobId };
}

await test('direct MP4: ranged parallel download is byte-exact', async () => {
  const { jobId, p } = await grab('direct', (i) => i.kind === 'direct' && i.url.endsWith('direct.mp4'));
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  const f = await savedFile(job);
  assert(f && existsSync(f), 'file missing');
  assert(md5(f) === md5(`${ROOT}tests/fixtures/media/direct.mp4`), 'checksum mismatch');
  assert(job.totalParts > 1, `expected multiple chunks, got ${job.totalParts}`);
  await p.close();
});

await test('HLS (TS) master → best variant, Referer-protected, remuxed to MP4', async () => {
  const { jobId, item, p } = await grab('hls', (i) => i.kind === 'hls');
  assert(item.info?.videos?.length === 2, `expected 2 variants, got ${item.info?.videos?.length}`);
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(!job.warning, `warning: ${job.warning}`);
  const f = await savedFile(job);
  const info = probe(f);
  assert(Math.abs(info.duration - 20) < 1, `duration ${info.duration}`);
  assert(info.video === 'h264' && info.audio === 'aac', `streams ${info.video}/${info.audio}`);
  assert(info.height === 720, `height ${info.height}`);
  assert(/mp4|mov/.test(info.format), `format ${info.format}`);
  await p.close();
});

await test('HLS quality choice: 360p variant via the dial', async () => {
  const { tabId, item, p } = await grab('hls', (i) => i.kind === 'hls', {});
  const v360 = item.info.videos.find((v) => v.height === 360);
  const jobId = await send('quick.grab', { tabId, itemId: item.id, choice: { videoId: v360.id } });
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(!job.warning, `warning: ${job.warning}`);
  const info = probe(await savedFile(job));
  assert(info.height === 360, `height ${info.height}`);
  await p.close();
});

await test('HLS AES-128 encrypted → decrypted & playable', async () => {
  const { jobId, p } = await grab('aes', (i) => i.kind === 'hls');
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(!job.warning, `warning: ${job.warning}`);
  const info = probe(await savedFile(job));
  assert(Math.abs(info.duration - 20) < 1 && info.video === 'h264' && info.audio === 'aac', JSON.stringify(info));
  await p.close();
});

await test('HLS fMP4 + separate audio rendition (found via JSON API) → merged', async () => {
  const { jobId, item, p } = await grab('fmp4', (i) => i.kind === 'hls');
  assert(item.source === 'json' || item.source === 'hook' || item.source === 'network', 'source');
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  const info = probe(await savedFile(job));
  assert(info.video === 'h264' && info.audio === 'aac', `streams ${info.video}/${info.audio}`);
  assert(Math.abs(info.duration - 20) < 1, `duration ${info.duration}`);
  await p.close();
});

await test('DASH video + audio → merged MP4 (best 720p)', async () => {
  const { jobId, item, p } = await grab('dash', (i) => i.kind === 'dash');
  assert(item.info?.videos?.length === 2, `variants ${item.info?.videos?.length}`);
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  const info = probe(await savedFile(job));
  assert(info.video === 'h264' && info.audio === 'aac' && info.height === 720, JSON.stringify(info));
  assert(Math.abs(info.duration - 20) < 1, `duration ${info.duration}`);
  await p.close();
});

await test('Audio only from DASH → .m4a', async () => {
  const { jobId, p } = await grab('dash', (i) => i.kind === 'dash', { audioOnly: true });
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  const info = probe(await savedFile(job));
  assert(!info.video && info.audio === 'aac', JSON.stringify(info));
  assert(/mp4|m4a/.test(info.format), `format ${info.format}`);
  await p.close();
});

await test('WebM (VP9/Opus) direct → kept as WebM', async () => {
  const { jobId, p } = await grab('webm', (i) => i.kind === 'direct' && i.url.endsWith('.webm'));
  const job = await waitJob(jobId);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  const f = await savedFile(job);
  assert(md5(f) === md5(`${ROOT}tests/fixtures/media/direct.webm`), 'checksum mismatch');
  await p.close();
});

await test('Pause & resume a throttled download → byte-exact', async () => {
  const { jobId, p } = await grab('slow', (i) => i.kind === 'direct');
  await waitJob(jobId, 20_000, ['downloading']);
  await hub.waitForTimeout(1500);
  await send('job.action', { id: jobId, action: 'pause' });
  const paused = await waitJob(jobId, 20_000, ['paused']);
  assert(paused.doneBytes > 0, 'nothing downloaded before pause');
  await send('job.action', { id: jobId, action: 'resume' });
  const job = await waitJob(jobId, 120_000);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(md5(await savedFile(job)) === md5(`${ROOT}tests/fixtures/media/direct.mp4`), 'checksum mismatch after resume');
  await p.close();
});

await test('Record while playing (MSE player, no URLs exposed) → saved MP4', async () => {
  const { p, tabId } = await openPage('mse');
  const list = await send('media.list', { tabId });
  assert(list.tab.mse, 'MSE not detected');
  await send('record.toggle', { tabId, on: true });
  await p.waitForFunction(() => window.__done === true, null, { timeout: 20_000 });
  await send('record.toggle', { tabId, on: false });
  let job;
  for (let i = 0; i < 60 && !job; i++) {
    job = (await send('jobs.list')).find((j) => j.request.recorded && j.request.pageUrl.includes('/page/mse'));
    if (!job) await hub.waitForTimeout(250);
  }
  assert(job, 'no recording job created');
  job = await waitJob(job.id);
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(!job.warning, `warning: ${job.warning}`);
  const info = probe(await savedFile(job));
  assert(info.video === 'vp9' && info.duration > 8, JSON.stringify(info));
  await p.close();
});

await test('YouTube is excluded', async () => {
  const blocked = await hub.evaluate(async () => {
    const t = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
    await new Promise((r) => setTimeout(r, 300));
    const r = await chrome.runtime.sendMessage({ target: 'bg', type: 'media.list', payload: { tabId: t.id } });
    await chrome.tabs.remove(t.id);
    return r.data.tab.blocked;
  });
  assert(blocked === true, 'youtube tab not blocked');
});

if (SHOTS) {
  // UI screenshots for the README.
  const { p: dp, tabId } = await openPage('hls');
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 408, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
  await popup.waitForTimeout(1800);
  await popup.screenshot({ path: `${SHOTS}/popup-dark.png` });
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.waitForTimeout(400);
  await popup.screenshot({ path: `${SHOTS}/popup-light.png` });

  const { tabId: slowTab } = await openPage('slower');
  const items = (await send('media.list', { tabId: slowTab })).items;
  const jid = await send('quick.grab', { tabId: slowTab, itemId: items[0].id });
  await waitJob(jid, 20_000, ['downloading']);
  await hub.goto(`chrome-extension://${extId}/hub.html#downloads`);
  await hub.waitForTimeout(3500);
  await hub.screenshot({ path: `${SHOTS}/hub-downloads.png` });
  await hub.goto(`chrome-extension://${extId}/hub.html#settings`);
  await hub.waitForTimeout(600);
  await hub.screenshot({ path: `${SHOTS}/hub-settings.png` });
  await hub.goto(`chrome-extension://${extId}/hub.html#welcome`);
  await hub.waitForTimeout(600);
  await hub.screenshot({ path: `${SHOTS}/hub-welcome.png` });
  await send('job.action', { id: jid, action: 'cancel' });

  const vp = await ctx.newPage();
  await vp.goto(`${base}/page/direct.html`);
  await vp.waitForTimeout(1500);
  const box = await vp.locator('video').boundingBox();
  await vp.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await vp.waitForTimeout(400);
  await vp.mouse.move(box.x + box.width - 60, box.y + 30);
  await vp.waitForTimeout(500);
  await vp.mouse.click(box.x + box.width - 50, box.y + 29);
  await vp.waitForTimeout(1500);
  await vp.screenshot({ path: `${SHOTS}/overlay.png` });
  void dp;
}

await ctx.close();
server.close();
const failed = results.filter((r) => r[1] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
