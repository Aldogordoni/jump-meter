// Shared settings for the end-to-end tests.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.BASE_URL ?? 'http://localhost:8765/jump-meter/';
export const fx = (name) => path.join(here, 'fixtures', name);
export const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

// Screenshots and downloads go to e2e/out.
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
process.chdir(out);
