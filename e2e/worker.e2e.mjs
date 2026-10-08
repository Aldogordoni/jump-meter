import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
const model = process.env.MODEL_FILE ? fs.readFileSync(process.env.MODEL_FILE) : null;
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (/jump-meter|worker|Worker|pose|error/i.test(t) && !/Failed to load resource/.test(t)) console.log('console:', t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('worker', (w) => w.on('console', (m) => console.log('worker:', m.text().slice(0, 300))));
if (model) await ctx.route('https://storage.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: model, headers: { 'access-control-allow-origin': '*' } }));
const base = BASE;
await page.goto(base + '#/measure');
await page.evaluate(() => { localStorage.setItem('jump-meter.settings.v1', JSON.stringify({ onboarded: true })); localStorage.removeItem('jump-meter.pose-engine'); });
await page.reload();
await page.setInputFiles('input[type=file]', fx('jump240.mp4'));
await page.waitForSelector('canvas');
const t0 = Date.now();
await page.click('button:has-text("Find take-off and landing for me")');
// Measure main-thread responsiveness while detecting.
const lag = await page.evaluate(async () => {
  let worst = 0, last = performance.now();
  const end = performance.now() + 4000;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 16));
    const now = performance.now();
    worst = Math.max(worst, now - last - 16);
    last = now;
  }
  return Math.round(worst);
});
await page.waitForFunction(() => !document.querySelector('.progress'), null, { timeout: 180000 });const result = (await page.locator('.auto .error').textContent().catch(() => null)) ?? '';
console.log('took', Math.round((Date.now() - t0) / 1000), 's; worst stall', lag, 'ms');
// The test clip has no person in it, so a working model reports exactly that.
ok(/No person found/.test(result), 'pose model ran on every frame (' + result.trim().slice(0, 60) + ')');
ok((await page.evaluate(() => localStorage.getItem('jump-meter.pose-engine'))) !== 'main', 'pose model ran in the Web Worker');
ok(lag < 80, `page stayed responsive during analysis (worst stall ${lag} ms)`);
await browser.close();

