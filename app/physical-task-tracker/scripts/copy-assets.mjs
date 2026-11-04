// Copies non-TS runtime assets (dashboard page, samples, example env)
// next to the compiled output so dist/ runs standalone.
import { cp, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(appDir, 'dist');
await mkdir(distDir, { recursive: true });
for (const entry of ['dashboard', 'samples', 'workers']) {
  await cp(join(appDir, 'src', entry), join(distDir, entry), { recursive: true, filter: (source) => !source.includes('__pycache__') });
}
// Plain-JS OI runner (runs inside the OI checkout, not compiled by tsc).
await mkdir(join(distDir, 'lib'), { recursive: true });
await cp(join(appDir, 'src', 'lib', 'oi-runner.mjs'), join(distDir, 'lib', 'oi-runner.mjs'));
await cp(join(appDir, 'src', 'example.env'), join(distDir, 'example.env'));
console.log('assets copied to dist/');
