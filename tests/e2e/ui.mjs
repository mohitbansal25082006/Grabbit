// UI tests: drive the real popup, hub and settings with clicks, like a user.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { startServer } from './server.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXT = `${ROOT}.output/chrome-mv3`;
const DOWNLOADS = `${ROOT}tests/e2e/downloads-ui`;
const EXEC = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

const { server, base } = await startServer();
const ctx = await chromium.launchPersistentContext('', {
  executablePath: EXEC,
  headless: true,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const errors = [];
ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`)));

const hub = await ctx.newPage();
hub.on('pageerror', (e) => errors.push(`hub: ${e.message}`));
hub.on('dialog', (d) => d.accept());
await hub.goto(`chrome-extension://${extId}/hub.html#downloads`);
const send = (type, payload) =>
  hub.evaluate(async ([type, payload]) => {
    const r = await chrome.runtime.sendMessage({ target: 'bg', type, payload });
    if (!r?.ok) throw new Error(r?.error);
    return r.data;
  }, [type, payload]);
const stored = () => hub.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`✔ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`✘ ${name}: ${e.message.split('\n')[0]}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const until = async (fn, ms = 10000, msg = 'condition') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${msg}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

// ─────────── Popup ───────────
const page = await ctx.newPage();
await page.goto(`${base}/page/multi.html`);
await page.waitForTimeout(1500);
const tabId = await hub.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/page/multi.html`);
const popup = await ctx.newPage();
popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
await popup.setViewportSize({ width: 408, height: 600 });
await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tabId}`);
const cards = popup.locator('article.card');

await test('Popup lists every video on the page', async () => {
  await until(async () => (await cards.count()) >= 3, 10000, '3 cards');
});

await test('Each card opens fully and shows its Grab button (multiple videos)', async () => {
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    if (!(await card.evaluate((el) => el.classList.contains('expanded')))) await card.locator('button.head').click();
    const grab = card.locator('button.grab');
    await grab.waitFor({ state: 'attached', timeout: 10000 });
    await grab.scrollIntoViewIfNeeded();
    assert(await grab.isVisible(), `grab button hidden on card ${i}`);
    const box = await card.boundingBox();
    assert(box.height > 250, `card ${i} squashed to ${Math.round(box.height)}px`);
    assert((await popup.locator('article.card.expanded').count()) === 1, 'exactly one card open');
  }
});

await test('Opened card stays open and keeps edits across live refreshes', async () => {
  const card = cards.first();
  if (!(await card.evaluate((el) => el.classList.contains('expanded')))) await card.locator('button.head').click();
  await card.locator('button.grab').waitFor();
  const name = card.locator('input.input').last();
  await name.fill('My Custom Name');
  await card.getByRole('radio', { name: 'MKV' }).click();
  await popup.waitForTimeout(3500);
  assert(await card.evaluate((el) => el.classList.contains('expanded')), 'card collapsed by refresh');
  assert((await name.inputValue()) === 'My Custom Name', 'title was reset');
  assert((await card.getByRole('radio', { name: 'MKV' }).getAttribute('aria-checked')) === 'true', 'format reset');
});

await test('Collapsing a card is respected (no auto re-open)', async () => {
  const card = cards.first();
  await card.locator('button.head').click();
  await popup.waitForTimeout(2600);
  assert((await popup.locator('article.card.expanded').count()) === 0, 'a card re-opened by itself');
});

await test('“More ways to grab” opens, stays open, and adds a pasted link', async () => {
  const details = popup.locator('details.tools');
  await details.locator('summary').click();
  await popup.waitForTimeout(2600);
  assert(await details.evaluate((d) => d.open), 'details closed itself');
  assert(await popup.getByRole('button', { name: /Start recording/ }).isVisible(), 'record button not visible');
  const before = await cards.count();
  await details.locator('input.input').fill(`${base}/media/hls-aes/index.m3u8`);
  await details.locator('input.input').press('Enter');
  await until(async () => (await cards.count()) > before, 8000, 'pasted link card');
});

await test('Grab button in a card starts a real download', async () => {
  const card = cards.first();
  if (!(await card.evaluate((el) => el.classList.contains('expanded')))) await card.locator('button.head').click();
  await card.locator('button.grab').click();
  const job = await until(async () => (await send('jobs.list')).find((j) => j.status === 'done'), 30000, 'job done');
  assert(job, 'no job');
});

// ─────────── Record while playing (via popup clicks) ───────────
const ffmpeg = ['/tmp/claude-0/ff/ffmpeg'].find(existsSync) || 'ffmpeg';
const { execFileSync } = await import('node:child_process');
function probe(file) {
  let out = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String(e.stderr);
  }
  const d = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0, video: (out.match(/Video: (\w+)/) || [])[1], audio: (out.match(/Audio: (\w+)/) || [])[1] };
}

async function recordFlow(turbo) {
  const before = new Set((await send('jobs.list')).map((j) => j.id));
  const pg = await ctx.newPage();
  await pg.goto(`${base}/page/embed.html`);
  const frame = () => pg.frames().find((f) => f.url().includes('mseav'));
  await until(async () => frame() && (await frame().evaluate(() => window.__inits === true)), 10000, 'player ready');
  await pg.waitForTimeout(800);
  const tab = await hub.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/page/embed.html`);
  const pop = await ctx.newPage();
  pop.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
  await pop.setViewportSize({ width: 408, height: 600 });
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  const det = pop.locator('details.tools');
  await det.waitFor();
  if (!(await det.evaluate((d) => d.open))) await det.locator('summary').click();
  if (turbo) await det.getByLabel('Turbo 8×').check();
  await pop.getByRole('button', { name: 'Start recording' }).click();
  await pop.getByRole('button', { name: 'Stop & save' }).waitFor({ timeout: 5000 });
  await frame().evaluate(() => (window.__go = true));
  await until(() => frame().evaluate(() => window.__done === true), 20000, 'player finished');
  if (turbo) {
    // No click: recording must stop by itself when the video ends, and the popup must notice.
    await pop.getByRole('button', { name: 'Start recording' }).waitFor({ timeout: 25000 });
  } else {
    await pg.waitForTimeout(500);
    await pop.getByRole('button', { name: 'Stop & save' }).click();
    await pop.getByText(/Saved!/).waitFor({ timeout: 10000 });
  }
  const job = await until(async () => (await send('jobs.list')).find((j) => !before.has(j.id) && j.request.recorded && ['done', 'error'].includes(j.status)), 30000, 'recording job');
  assert(job.status === 'done', `job ${job.status}: ${job.error}`);
  assert(!job.warning, `warning: ${job.warning}`);
  const [d] = await hub.evaluate((id) => chrome.downloads.search({ id }), job.downloadId);
  const info = probe(d.filename);
  assert(info.video === 'vp9' && info.audio === 'opus', `streams ${info.video}/${info.audio}`);
  assert(info.duration > 15, `duration ${info.duration}`);
  await pop.close();
  await pg.close();
  return job;
}

await test('Record while playing: iframe player, separate audio+video, Start → Stop & save', async () => {
  await recordFlow(false);
});

await test('Record while playing: Turbo 8× auto-stops when the video ends', async () => {
  await recordFlow(true);
});

await test('Record while playing: clear message when there is no streaming player', async () => {
  const pg = await ctx.newPage();
  await pg.goto(`${base}/page/direct.html`);
  await pg.waitForTimeout(1000);
  const tab = await hub.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${base}/page/direct.html`);
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  const det = pop.locator('details.tools');
  await det.waitFor();
  if (!(await det.evaluate((d) => d.open))) await det.locator('summary').click();
  await pop.getByRole('button', { name: 'Start recording' }).click();
  await pop.getByText(/No streaming player found/).waitFor({ timeout: 5000 });
  await pop.close();
  await pg.close();
});

// ─────────── Hub buttons ───────────
await test('Hub: open file / show in folder buttons work', async () => {
  await hub.goto(`chrome-extension://${extId}/hub.html#history`);
  const row = hub.locator('article.job.done').first();
  await row.waitFor();
  await row.getByRole('button', { name: 'Open file' }).click();
  await row.getByRole('button', { name: 'Show in folder' }).click();
  await hub.waitForTimeout(500);
  const t = await hub.locator('.toast').textContent().catch(() => '');
  assert(!t || !/moved|deleted|error/i.test(t), `toast: ${t}`);
});

await test('Hub: remove one item, then Clear empties history', async () => {
  for (const t of await send('media.list', { tabId }).then((r) => r.items.slice(0, 2))) await send('quick.grab', { tabId, itemId: t.id });
  await until(async () => {
    const js = await send('jobs.list');
    return js.filter((j) => j.status === 'done').length >= 3 && js.every((j) => ['done', 'error', 'canceled'].includes(j.status));
  }, 30000, 'all jobs settled');
  await hub.goto(`chrome-extension://${extId}/hub.html#history`);
  const rows = hub.locator('article.job');
  await rows.first().waitFor();
  const n = await rows.count();
  await rows.first().getByRole('button', { name: 'Remove' }).click();
  await until(async () => (await rows.count()) === n - 1, 5000, 'row removed');
  await hub.getByRole('button', { name: 'Clear' }).click();
  await until(async () => (await rows.count()) === 0, 5000, 'history empty');
  assert((await send('jobs.list')).length === 0, 'engine still has jobs');
});

// ─────────── Settings ───────────
await hub.goto(`chrome-extension://${extId}/hub.html#settings`);
await hub.locator('.settings').waitFor();
const btn = (name) => hub.getByRole('button', { name, exact: true });

await test('Settings: default quality & codec', async () => {
  await btn('720p').click();
  await btn('Most efficient (AV1 / VP9 / HEVC)').click();
  await until(async () => (await stored()).preset === '720' && (await stored()).codec === 'quality', 3000, 'saved');
  await btn('Best').click();
  await btn('Most compatible (H.264)').click();
  await until(async () => (await stored()).preset === 'best' && (await stored()).codec === 'compatible', 3000, 'restored');
});

await test('Settings: container, filename template, tokens, subfolder, preview', async () => {
  await btn('MKV').click();
  await until(async () => (await stored()).container === 'mkv', 3000, 'container');
  const tpl = hub.locator('.settings input.input').nth(0);
  await tpl.fill('{site} - {title}');
  await tpl.blur();
  await btn('{quality}').click();
  await until(async () => (await stored()).filenameTemplate === '{site} - {title} {quality}', 3000, `template ${(await stored()).filenameTemplate}`);
  const sub = hub.locator('.settings input.input').nth(1);
  await sub.fill('Videos/Grabbit');
  await sub.blur();
  await until(async () => (await stored()).subfolder === 'Videos/Grabbit', 3000, 'subfolder');
  const preview = await hub.locator('.preview').textContent();
  assert(preview.includes('Downloads/Videos/Grabbit/vimeo.com - Northern Lights Timelapse 1080p.mp4'), `preview: ${preview}`);
  await btn('Auto (MP4, MKV if needed)').click();
  await tpl.fill('{title} [{quality}]');
  await tpl.blur();
  await sub.fill('Grabbit');
  await sub.blur();
  await until(async () => (await stored()).subfolder === 'Grabbit' && (await stored()).container === 'auto', 3000, 'restore');
});

await test('Settings: every switch toggles and persists', async () => {
  const keys = ['saveAs', 'saveSubtitles', 'overlay', 'notifications'];
  const sw = hub.locator('.settings input.switch');
  assert((await sw.count()) === 4, 'expected 4 switches');
  for (let i = 0; i < 4; i++) {
    const before = (await stored())[keys[i]];
    await sw.nth(i).click();
    await until(async () => (await stored())[keys[i]] === !before, 3000, `${keys[i]} toggled`);
    await sw.nth(i).click();
    await until(async () => (await stored())[keys[i]] === before, 3000, `${keys[i]} restored`);
  }
});

await test('Settings: sliders (connections, parallel jobs, retries, min size)', async () => {
  const r = hub.locator('.settings input[type=range]');
  const want = [['maxConnections', '24'], ['maxJobs', '4'], ['retries', '9'], ['minSizeKB', '1024']];
  for (let i = 0; i < want.length; i++) await r.nth(i).fill(want[i][1]);
  await until(async () => {
    const s = await stored();
    return want.every(([k, v]) => s[k] === +v);
  }, 3000, 'sliders saved');
  const txt = await hub.locator('.settings .val').allTextContents();
  assert(txt.includes('24') && txt.includes('4') && txt.includes('9') && txt.includes('1.0 MB'), `labels ${txt}`);
  for (const [i, v] of [[0, '16'], [1, '3'], [2, '6'], [3, '320']]) await r.nth(i).fill(v);
  await until(async () => (await stored()).maxConnections === 16, 3000, 'restore');
});

await test('Settings: hide-button sites & per-site rules add/remove', async () => {
  const cardsS = hub.locator('.settings section.card');
  const det = cardsS.nth(3);
  await det.locator('input.input').fill('https://www.example.com/page');
  await det.getByRole('button', { name: 'Add' }).click();
  await until(async () => (await stored()).disabledOverlayHosts?.includes('example.com'), 3000, 'host added');
  await det.getByRole('button', { name: 'Remove example.com' }).click();
  await until(async () => !(await stored()).disabledOverlayHosts?.includes('example.com'), 3000, 'host removed');

  const rules = cardsS.nth(4);
  await rules.locator('input.input').fill('vimeo.com');
  await rules.locator('select').selectOption('1080');
  await rules.getByRole('button', { name: 'Add' }).click();
  await until(async () => (await stored()).siteRules?.some((r) => r.host === 'vimeo.com' && r.preset === '1080'), 3000, 'rule added');
  await rules.getByRole('button', { name: 'Remove rule' }).click();
  await until(async () => !(await stored()).siteRules?.length, 3000, 'rule removed');
});

await test('Settings: theme switch applies instantly', async () => {
  await btn('Daylight meadow').click();
  await until(async () => (await hub.evaluate(() => document.documentElement.dataset.theme)) === 'light', 3000, 'light');
  await btn('Night burrow').click();
  await until(async () => (await hub.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 3000, 'dark');
  await btn('System').click();
  await until(async () => (await stored()).theme === 'auto', 3000, 'auto');
});

await test('Settings: “Customize” opens the browser shortcuts page', async () => {
  const [p] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }), hub.getByRole('button', { name: 'Customize' }).click()]);
  await p.waitForTimeout(500);
  assert(/extensions\/shortcuts/.test(p.url()), p.url());
  await p.close();
});

await test('Settings take effect: page button hides live, max connections reaches engine', async () => {
  const vp = await ctx.newPage();
  await vp.goto(`${base}/page/direct.html`);
  await vp.waitForTimeout(1200);
  const hostVisible = () => vp.evaluate(() => getComputedStyle(document.querySelector('grabbit-overlay')).display !== 'none');
  assert(await hostVisible(), 'overlay missing');
  await hub.locator('.settings input.switch').nth(2).click();
  await until(async () => !(await hostVisible()), 3000, 'overlay hidden live');
  await hub.locator('.settings input.switch').nth(2).click();
  await until(hostVisible, 3000, 'overlay shown live');
  await vp.close();
});

console.log(errors.length ? `\nPage errors:\n${errors.join('\n')}` : '\nNo page errors.');
await ctx.close();
server.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
