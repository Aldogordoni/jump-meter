import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
const axe = fs.readFileSync(AXE, 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', acceptDownloads: true, bypassCSP: true, permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const base = BASE;
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
async function goFrame(n) {
  await page.locator('input.scrub').fill(String(n));
  await page.waitForFunction(() => !document.querySelector('.busy'));
}
async function setMark(title) {
  await page.locator('.mark-card', { has: page.locator(`h3:text-is("${title}")`) }).getByRole('button', { name: /^Set to frame/ }).click();
}
async function axeRun(name) {
  await page.addScriptTag({ content: axe });
  const v = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => x.id + ': ' + x.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')));
  ok(v.length === 0, `a11y ${name} ${v.join('; ')}`);
}

// 1. Onboarding
await page.goto(base + '#/measure');
await page.waitForSelector('app-onboarding .card');
await page.screenshot({ path: 's3-onb1.png' });
await page.click('app-onboarding button:has-text("Next")');
await page.click('app-onboarding button:has-text("Next")');
await page.fill('#ob-h', '180');
await page.fill('#ob-m', '78');
await page.screenshot({ path: 's3-onb3.png' });
await page.click('app-onboarding button:has-text("Next")');
await page.click('app-onboarding button:has-text("Start measuring")');
await page.waitForTimeout(300);
const st = await page.evaluate(() => JSON.parse(localStorage.getItem('jump-meter.settings.v1')));
ok(st.onboarded && st.statureCm === 180 && st.massKg === 78, 'onboarding saved details ' + JSON.stringify({o: st.onboarded, h: st.statureCm, m: st.massKg}));
ok((await page.locator('app-onboarding .card').count()) === 0, 'onboarding closed');

// 2. Recorder with a fake camera
await page.click('button:has-text("Record now")');
await page.waitForSelector('app-recorder video');
await page.waitForTimeout(2500);
ok(await page.locator('.hands-free input').isVisible(), 'hands-free toggle');
await page.locator('.hands-free input').check();
await page.waitForTimeout(800);
console.log('TIP', (await page.locator('app-recorder .tip').textContent())?.trim());
await page.screenshot({ path: 's3-rec.png' });
await page.click('app-recorder button:has-text("Cancel")');

// 3. Save two jumps with clips, share card
for (const [a, g] of [[97, 228], [100, 226]]) {
  await page.setInputFiles('input[type=file]', fx('jump240.mp4'));
  await page.waitForSelector('canvas');
  await page.selectOption('#type', 'CMJ');
  await goFrame(a); await setMark('Take-off');
  await goFrame(g); await setMark('Landing');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Save CMJ")');
  await page.waitForSelector('button:has-text("Share card"):enabled', { timeout: 60000 });
  if (a === 100) {
    const dl = page.waitForEvent('download');
    await page.click('button:has-text("Share card")');
    const d = await dl;
    await d.saveAs('s3-card.png');
    ok(fs.statSync('s3-card.png').size > 20000, 'share card downloaded');
  }
  await page.click('text=Load another');
}

// 4. History compare
await page.goto(base + '#/history');
await page.waitForSelector('.thumb');
await page.locator('.row-actions button:has-text("Compare")').first().click();
ok(!!(await page.waitForSelector('.compare-bar', { timeout: 3000 }).catch(() => null)), 'compare banner');
await page.locator('.thumb:has-text("Compare with this")').first().click();
await page.waitForSelector('app-clip-viewer video');
ok((await page.locator('app-clip-viewer video').count()) === 2, 'two clips side by side');
await page.click('app-clip-viewer button[role=radio]:has-text("0.5×")');
const rates = await page.$$eval('app-clip-viewer video', (vs) => vs.map((v) => v.playbackRate));
ok(rates.every((r) => r === 0.5), 'slow motion applied to both');
await page.waitForTimeout(800);
await page.screenshot({ path: 's3-compare.png' });
await axeRun('compare viewer');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok((await page.locator('app-clip-viewer video').count()) === 0, 'escape closes viewer');

// 5. Trim
await page.locator('.thumb:has-text("Watch clip")').first().click();
await page.waitForSelector('app-clip-viewer video');
await page.waitForFunction(() => document.querySelector('app-clip-viewer video').duration > 0);
const before = await page.$eval('app-clip-viewer video', (v) => v.duration);
await page.click('app-clip-viewer button:has-text("Trim")');
await page.locator('app-clip-viewer .scrub').fill((before * 0.25).toFixed(2));
await page.click('app-clip-viewer button:has-text("Start here")');
await page.locator('app-clip-viewer .scrub').fill((before * 0.7).toFixed(2));
await page.click('app-clip-viewer button:has-text("End here")');
await page.click('app-clip-viewer button:has-text("Save trimmed clip")');
await page.waitForSelector('app-clip-viewer video', { state: 'detached', timeout: 60000 });
await page.locator('.thumb:has-text("Watch clip")').first().click();
await page.waitForFunction(() => document.querySelector('app-clip-viewer video')?.duration > 0);
const after = await page.$eval('app-clip-viewer video', (v) => v.duration);
console.log('DURATION', before.toFixed(2), '→', after.toFixed(2));
ok(after < before * 0.6 && after > before * 0.3, 'clip trimmed');
await page.keyboard.press('Escape');

// 6. Share card from history
const dl2 = page.waitForEvent('download');
await page.locator('.row-actions button:has-text("Share card")').first().click();
await (await dl2).saveAs('s3-card2.png');
ok(fs.statSync('s3-card2.png').size > 20000, 'history share card');
await browser.close();
