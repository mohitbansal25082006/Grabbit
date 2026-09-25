// Render Grabbit's original rabbit-mark logo to PNG icons with headless Chromium.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const EXEC = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="hl" cx="22%" cy="12%" r="75%"><stop offset="0" stop-color="#FFB23D"/><stop offset="1" stop-color="#FFB23D" stop-opacity="0"/></radialGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF6B1A"/><stop offset="1" stop-color="#FF3D7F"/></linearGradient>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="38" fill="url(#bg)"/>
  <rect x="4" y="4" width="120" height="120" rx="38" fill="url(#hl)"/>
  <rect x="4.5" y="4.5" width="119" height="119" rx="37.5" fill="none" stroke="#fff" stroke-opacity=".28"/>
  <g transform="translate(23 21) scale(2.56)">
    <path fill="#fff" d="M11.2 2.4c1.9 0 2.9 3 2.9 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6.9-6.6 2.8-6.6Zm9.6 0c1.9 0 2.8 3 2.8 6.6v3.2a9.6 9.6 0 0 0-5.7 0V9c0-3.6 1-6.6 2.9-6.6ZM16 11.4c5 0 9 3.9 9 8.8S21 29.6 16 29.6s-9-4.5-9-9.4 4-8.8 9-8.8Z"/>
    <path fill="none" stroke="#FF5A2A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M16 16.2v7.2m-3.2-3.1 3.2 3.2 3.2-3.2"/>
  </g>
</svg>`;

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/logo.svg', svg(128));
const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  const buf = await page.locator('svg').screenshot({ omitBackground: true });
  writeFileSync(`public/icons/${size}.png`, buf);
  console.log('icon', size);
}
await browser.close();
