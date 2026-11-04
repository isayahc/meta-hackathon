/** Browser QA against the real request handler, intercepted in-process: never listen(). */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from '../dist/serve-dashboard.js';
import { replayWalkthrough, readWalkthrough } from '../dist/lib/walkthrough.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'walkthrough-browser-'));
const output = resolve(process.argv[2] || './walkthrough-qa'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
try {
  await exec(process.env.WALKTHROUGH_PYTHON || 'python3', [fileURLToPath(new URL('./replay-walkthrough.py', import.meta.url)), join(root, 'bundle')]);
  const replay = await replayWalkthrough(root, join(root, 'bundle', 'run.json'));
  const html = await readFile(new URL('../dist/dashboard/index.html', import.meta.url), 'utf8');
  const handler = createServer(root).listeners('request')[0];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname === '/') { await route.fulfill({ status: 200, contentType: 'text/html', body: html }); return; }
    let status = 500, headers = {}, body = Buffer.alloc(0);
    const req = { method: request.method(), url: url.pathname + url.search, async *[Symbol.asyncIterator]() { const bytes = request.postDataBuffer(); if (bytes) yield bytes; } };
    const res = { writeHead(code, values) { status = code; headers = values; }, end(bytes = '') { body = Buffer.from(bytes); } };
    try { await handler(req, res); await route.fulfill({ status, headers, body }); }
    catch (error) { await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: error.message }) }); }
  });
  await page.goto('http://fieldops.test/');
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.getByText('Map a work area',{exact:true}).click();await page.getByText('Replay — not fresh inference', { exact: false }).waitFor();
  const station = page.locator('.stationreview').first();
  await station.locator('[name=station]').fill('Tray filling station');
  await station.locator('[name=static]').check();
  await station.locator('[name=rationale]').fill('Synthetic review: the fixture depicts the intended station.');
  await station.getByRole('button', { name: 'Confirm station' }).click();
  await page.getByText('Review saved.', { exact: false }).waitFor();
  assert.equal(readWalkthrough(root, replay.id).reviews[0].decision, 'confirmed');
  assert.equal(await page.locator('.stationreview').nth(1).getByRole('button', { name: 'Confirm station' }).isDisabled(), true);
  await page.locator('#walkthroughruns').screenshot({ path: join(output, 'review-mobile.png') });
  await page.reload(); await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await page.locator('.stationreview [name=station]').first().waitFor();
  assert.equal(await page.locator('.stationreview [name=station]').first().inputValue(), 'Tray filling station');
  await page.locator('#walkthroughform [name=images]').setInputFiles([join(root, 'bundle', 'candidate-0.png'), join(root, 'bundle', 'candidate-1.png')]);
  await page.getByRole('button', { name: 'Start walkthrough' }).click();
  await page.getByText('Walkthrough saved for review.', { exact: true }).waitFor();
  await page.getByText('Prepared capture · captured', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'capture-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'Mobile viewport must not overflow horizontally');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['review save', 'dynamic rejection', 'reload persistence', 'real image upload/capture', 'replay label', 'mobile bounds'], screenshots: output }));
} finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
