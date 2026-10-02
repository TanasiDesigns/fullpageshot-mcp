// Smoke test: launch the browser headlessly, navigate, capture a full-page
// screenshot, and verify the bytes. Run with `npm run smoke`.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, findBrowserExecutable } from '../src/browser.mjs';
import { imageDimensions } from '../src/png.mjs';

const url = process.argv[2] || 'https://example.com';

const exe = findBrowserExecutable();
if (!exe) {
  console.error('No Chromium-based browser found. Set FULLPAGESHOT_CHROME.');
  process.exit(1);
}
console.log('browser:', exe);

const browser = await launch({ headless: true });
console.log('version:', browser.version);

try {
  const page = await browser.newPage('about:blank');
  const info = await page.goto(url, { timeoutMs: 30000 });
  console.log('opened:', info.url, '|', info.title);
  await page.settle();

  const shot = await page.screenshot({ fullPage: true, format: 'png' });
  const dims = imageDimensions(shot.buffer);
  const file = path.join(os.tmpdir(), `fullpageshot-smoke-${Date.now()}.png`);
  await fs.writeFile(file, shot.buffer);
  console.log('captured:', `${dims?.width}x${dims?.height}`, `${shot.buffer.length} bytes`, '->', file);

  if (!dims || dims.width < 100 || dims.height < 100) throw new Error('Screenshot looks wrong');
  if (dims.height <= 900) console.log('note: page fit within the viewport (nothing to scroll)');
  console.log('SMOKE OK');
} finally {
  await browser.close();
}