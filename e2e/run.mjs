// Runs every end-to-end suite against a served build and fails on any FAIL line or crash.
//   BASE_URL=http://localhost:8765/jump-meter/ node e2e/run.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  ['analysis.e2e.mjs'],
  ['experience.e2e.mjs'],
  ['account.e2e.mjs'],
  ['team.e2e.mjs'],
  ['platform.e2e.mjs'],
  ['a11y.e2e.mjs', { SCHEME: 'light' }],
  ['a11y.e2e.mjs', { SCHEME: 'dark' }],
  ...(process.env.SKIP_WORKER ? [] : [['worker.e2e.mjs']]),
];
let failed = 0;
for (const [file, env] of suites) {
  const label = file + (env?.SCHEME ? ` (${env.SCHEME})` : '');
  const r = spawnSync(process.execPath, [path.join(here, file)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10 * 60_000,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const fails = out.split('\n').filter((l) => /^FAIL\b|^pageerror/.test(l));
  const passes = out.split('\n').filter((l) => /^PASS\b/.test(l)).length;
  const bad = r.status !== 0 || fails.length > 0;
  console.log(`${bad ? '✗' : '✓'} ${label}: ${passes} passed${fails.length ? `, ${fails.length} failed` : ''}${r.status ? ` (exit ${r.status})` : ''}`);
  if (bad) {
    failed++;
    console.log(fails.length ? fails.join('\n') : out.split('\n').slice(-25).join('\n'));
  }
}
process.exit(failed ? 1 : 0);
