import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message, e.stack?.slice(0, 600)));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)); });
const base = BASE;
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
async function goFrame(n) {
  await page.locator('input.scrub').fill(String(n));
  await page.waitForFunction(() => !document.querySelector('.busy'));
}
async function setMark(title) {
  await page.locator('.mark-card', { has: page.locator(`h3:text-is("${title}")`) }).getByRole('button', { name: /^Set to frame/ }).click();
}
await page.goto(base + '#/measure');
await page.evaluate(() => localStorage.setItem('jump-meter.settings.v1', JSON.stringify({ onboarded: true, statureCm: 180 })));
await page.reload();

// --- CMJ: quality panel
await page.setInputFiles('input[type=file]', fx('jump240.mp4'));
await page.waitForSelector('canvas');
await page.selectOption('#type', 'CMJ');
await goFrame(97); await setMark('Take-off');
await goFrame(228); await setMark('Landing');
await page.waitForSelector('.quality .pill');
await page.waitForTimeout(4000);
const q = (await page.textContent('.quality')).replace(/\s+/g, ' ');
console.log('QUALITY', q);
ok(/confidence/i.test(q), 'confidence shown');

// --- Broad jump: distance tool
await page.selectOption('#type', 'Broad jump');
await page.waitForSelector('fieldset.dist');
await page.fill('#cal', '100');
await page.click('button:has-text("Tap its two ends")');
const box = await page.locator('.frame-box').boundingBox();
const tap = (fx, fy) => page.locator('svg.overlay').click({ position: { x: box.width * fx, y: box.height * fy } });
await tap(0.1, 0.9);
await tap(0.5, 0.9); // 100 cm = 40% of the width
await page.click('button:has-text("Tap toes at take-off")');
await tap(0.2, 0.8);
await page.click('button:has-text("Tap heel at landing")');
await tap(0.8, 0.85); // 60% of width → 150 cm horizontally
console.log('SVG', await page.locator('svg.overlay').count(), await page.locator('svg.overlay circle').count(), JSON.stringify(box)); await page.screenshot({ path: 's2-dbg.png', fullPage: true });
const d = (await page.textContent('.dist-out')).replace(/\s+/g, ' ');
console.log('DIST', d);
ok(Math.abs(parseFloat(d.replace(/[^0-9.]/g, '')) - 150) < 1.5, 'broad jump distance ≈150 cm');
ok(/Distance/.test(await page.textContent('.stats dl')), 'distance in stats');
await page.locator('.stage').screenshot({ path: 's2-dist.png' });
await page.click('button:has-text("Save Broad jump")');
await page.waitForSelector('.saved');

// --- Repeated jumps: add hops by hand
await page.selectOption('#type', 'Repeated jumps');
ok(await page.locator('.mark-card h3:text-is("Movement start")').count() === 0, 'repeated hides movement start');
for (const [a, g] of [[20, 60], [80, 120], [140, 180], [200, 236]]) {
  await goFrame(a); await setMark('Take-off');
  await goFrame(g); await setMark('Landing');
  await page.click('button:has-text("Add hop from the marks above")');
  await page.waitForTimeout(150);
}
const rows = await page.locator('.hop-table tbody tr').count();
ok(rows === 4, `4 hops in table (${rows})`);
const stats = (await page.textContent('.stats dl')).replace(/\s+/g, ' ');
console.log('REP', stats);
ok(/RSI, best 5/.test(stats), 'best-5 RSI shown');
await page.locator('.hop-table tbody tr').nth(3).getByRole('button', { name: /Remove/ }).click();
await page.waitForTimeout(200);
ok((await page.locator('.hop-table tbody tr').count()) === 3, 'hop removed');
await page.screenshot({ path: 's2-rep.png', fullPage: true });
await page.click('button:has-text("Save Repeated jumps")');
await page.waitForSelector('.saved');

// --- Stored records
const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('jump-meter.history.v1') ?? '[]'));
const broad = recs.find((r) => r.type === 'Broad jump');
const rep = recs.find((r) => r.type === 'Repeated jumps');
console.log('BROAD', JSON.stringify({ d: broad?.distanceCm, conf: broad?.confidence?.level }));
console.log('REPREC', JSON.stringify({ hops: rep?.hops?.length, rsi: rep?.rsi, contact: rep?.contactMs }));
ok(Math.abs(broad?.distanceCm - 150) < 1.5, 'distance saved');
ok(rep?.hops?.length === 3 && rep.rsi > 0, 'hops saved');

// --- History
await page.goto(base + '#/history');
await page.waitForTimeout(600);
await page.click('.chips button:text-is("Broad jump")').catch(() => console.log('no broad chip'));
await page.waitForTimeout(400);
const h = (await page.textContent('main')).replace(/\s+/g, ' ');
ok(/Distance/.test(h), 'history shows distance');
await page.screenshot({ path: 's2-hist.png', fullPage: true });
await browser.close();
