import { BASE, fx, AXE } from './lib.mjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
const axe = fs.readFileSync(AXE, 'utf8');
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const scheme = process.env.SCHEME ?? 'light';
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', colorScheme: scheme, bypassCSP: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const base = BASE;
async function audit(name) {
  await page.waitForTimeout(500);
  await page.addScriptTag({ content: axe });
  const res = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n').slice(1, 2).join('')) }));
  });
  console.log(`${res.length ? 'FAIL' : 'PASS'} a11y ${scheme}: ${name} (${res.length} violations)`);
  for (const v of res) console.log(`- [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.join('\n    ')}`);
}
// Onboarding (fresh user)
await page.goto(base + '#/measure');
await page.waitForSelector('app-onboarding .card');
await audit('onboarding step 1');
await page.click('app-onboarding button:has-text("Next")');
await page.click('app-onboarding button:has-text("Next")');
await audit('onboarding step 3');
await page.click('app-onboarding button:has-text("Next")');
await page.click('app-onboarding button:has-text("Start measuring")');
await audit('measure intro');
// Seed data
const now = Date.now();
const hist = Array.from({ length: 12 }, (_, i) => ({
  id: `j${i}`, date: new Date(now - (12 - i) * 86400000 * 2).toISOString(), heightCm: 40 + (i % 5), flightMs: 570, captureFps: 240, frames: 137,
  type: i % 4 === 0 ? 'Drop jump' : 'CMJ', method: 'auto', rsi: i % 4 === 0 ? 1.8 : undefined, contactMs: i % 4 === 0 ? 220 : undefined, tags: i % 2 ? ['Barefoot'] : ['Trainers'],
  confidence: { level: 'medium', score: 60, reasons: [] },
}));
await page.evaluate((h) => localStorage.setItem('jump-meter.history.v1', JSON.stringify(h)), hist);
await page.reload();
await page.setInputFiles('input[type=file]', fx('jump240.mp4'));
await page.waitForSelector('canvas');
await page.locator('input.scrub').fill('97');
await page.locator('.mark-card', { has: page.locator('h3:text-is("Take-off")') }).getByRole('button', { name: /^Set to frame/ }).click();
await page.locator('input.scrub').fill('228');
await page.locator('.mark-card', { has: page.locator('h3:text-is("Landing")') }).getByRole('button', { name: /^Set to frame/ }).click();
await page.waitForSelector('.quality');
await audit('measure result');
for (const r of ['history', 'train', 'setup', 'account']) {
  await page.goto(base + '#/' + r);
  await audit(r);
}
await browser.close();
