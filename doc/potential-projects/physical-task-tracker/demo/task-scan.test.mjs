import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRequestBody,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  formatTimestamp,
  formatSrt,
  normalizeSegments,
  loadSavedKey,
  saveKey,
} from './analyze-response.mjs';

// Captured live failure: auth OK, but the model burned 798/800 tokens on
// reasoning and returned finish_reason='length' with null content.
const TRUNCATED_SHAPE = {
  id: 'chatcmpl-demo',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: null },
      finish_reason: 'length',
    },
  ],
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 800,
    total_tokens: 2000,
    completion_tokens_details: { reasoning_tokens: 798 },
  },
};

describe('extractAnalysis', () => {
  it('rejects length-truncated responses as errors', () => {
    const r = extractAnalysis(TRUNCATED_SHAPE);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'truncated');
    assert.match(r.error, /length/);
  });

  it('rejects null content as an error', () => {
    const r = extractAnalysis({
      choices: [{ message: { content: null }, finish_reason: 'stop' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'empty_content');
  });

  it('rejects empty-string content as an error', () => {
    const r = extractAnalysis({
      choices: [{ message: { content: '   ' }, finish_reason: 'stop' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'empty_content');
  });

  it('accepts a valid JSON task analysis', () => {
    const r = extractAnalysis({
      choices: [
        {
          message: { content: '{"observed_task":"harvesting carrots"}' },
          finish_reason: 'stop',
        },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.analysis.observed_task, 'harvesting carrots');
  });

  it('rejects free text instead of JSON', () => {
    const r = extractAnalysis({
      choices: [
        { message: { content: 'The workers are harvesting.' }, finish_reason: 'stop' },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not_json');
  });

  it('rejects responses with no choices', () => {
    const r = extractAnalysis({ choices: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'empty_response');
  });
});

describe('buildRequestBody', () => {
  it('defaults to a 4096 token budget with no reasoning param', () => {
    const b = buildRequestBody({ model: 'm', prompt: 'p', imageUrl: 'u' });
    assert.equal(b.max_tokens, 4096);
    assert.equal(b.max_tokens, DEFAULT_MAX_TOKENS);
    assert.ok(!('reasoning_effort' in b));
  });

  it('forwards reasoning effort only when set', () => {
    const b = buildRequestBody({
      model: 'm',
      prompt: 'p',
      imageUrl: 'u',
      reasoningEffort: 'low',
    });
    assert.equal(b.reasoning_effort, 'low');
  });

  it('packs multiple frame images in order', () => {
    const b = buildRequestBody({
      model: 'm',
      prompt: 'p',
      imageUrls: ['f1', 'f2', 'f3'],
    });
    const imgs = b.messages[0].content.filter((c) => c.type === 'image_url');
    assert.deepEqual(
      imgs.map((c) => c.image_url.url),
      ['f1', 'f2', 'f3']
    );
  });

  it('combines a single image with an image list', () => {
    const b = buildRequestBody({
      model: 'm',
      prompt: 'p',
      imageUrl: 'u0',
      imageUrls: ['f1', 'f2'],
    });
    const imgs = b.messages[0].content.filter((c) => c.type === 'image_url');
    assert.deepEqual(
      imgs.map((c) => c.image_url.url),
      ['u0', 'f1', 'f2']
    );
  });

  it('appends labeled sections after the main images', () => {
    const b = buildRequestBody({
      model: 'm',
      prompt: 'p',
      imageUrls: ['a1', 'a2'],
      sections: [{ label: 'VISIT B (later):', imageUrls: ['b1'] }],
    });
    const content = b.messages[0].content;
    assert.deepEqual(
      content.map((c) => (c.type === 'text' ? `text:${c.text}` : `img:${c.image_url.url}`)),
      ['text:p', 'img:a1', 'img:a2', 'text:VISIT B (later):', 'img:b1']
    );
  });

  it('classifies image files as single-frame visits', async () => {
    const { classifySource } = await import('./analyze-response.mjs');
    assert.equal(classifySource(false, '.jpg'), 'image');
    assert.equal(classifySource(false, '.PNG'), 'image');
    assert.equal(classifySource(true, '.jpg'), 'frames-dir');
    assert.equal(classifySource(false, '.mp4'), 'video');
    assert.equal(classifySource(false, ''), 'video');
  });

describe('getVideoMeta', () => {
  const FFPROBE_JSON = JSON.stringify({
    streams: [{ width: 640, height: 360, avg_frame_rate: '30000/1001', codec_name: 'h264' }],
    format: { duration: '9.880000' },
  });
  const stubOk = (cmd, fargs, cb) => cb(null, FFPROBE_JSON, '');

  it('parses ffprobe JSON into metadata', async () => {
    const { getVideoMeta } = await import('./analyze-response.mjs');
    const m = await getVideoMeta('clip.mp4', stubOk);
    assert.equal(m.duration, 9.88);
    assert.equal(m.width, 640);
    assert.equal(m.height, 360);
    assert.ok(Math.abs(m.fps - 29.97) < 0.01);
    assert.equal(m.codec, 'h264');
  });

  it('throws a readable error when ffprobe fails', async () => {
    const { getVideoMeta } = await import('./analyze-response.mjs');
    const stubFail = (cmd, fargs, cb) => cb(new Error('enoent'), '', 'ffprobe: not found');
    await assert.rejects(getVideoMeta('clip.mp4', stubFail), /ffprobe failed: ffprobe: not found/);
  });
});

  it('accepts a valid compare diff', () => {
    const r = extractAnalysis({
      choices: [
        {
          message: {
            content: '{"same_location":true,"changed":["new growth"],"unchanged":["fence line"],"progress_delta":"advanced","new_issues":[],"suggested_state_update":"Row established.","confidence":"high","unknowns":[]}',
          },
          finish_reason: 'stop',
        },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.analysis.progress_delta, 'advanced');
  });
});

describe('key persistence', () => {
  // Redirect the config dir so tests never touch a real key file.
  let dir;
  let savedAppData;

  it('round-trips a saved key', async (t) => {
    dir = await mkdtemp(join(tmpdir(), 'task-scan-test-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    savedAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    t.after(() => {
      if (savedAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppData;
    });
    assert.equal(await loadSavedKey(), null);
    await saveKey('  test-key-123  ');
    assert.equal(await loadSavedKey(), 'test-key-123');
  });

  it('returns null for corrupt key files', async (t) => {
    dir = await mkdtemp(join(tmpdir(), 'task-scan-test-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    savedAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    t.after(() => {
      if (savedAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppData;
    });
    await saveKey('placeholder');
    const { configPath } = await import('./analyze-response.mjs');
    await writeFile(configPath(), 'not-json{{{');
    assert.equal(await loadSavedKey(), null);
  });
});

describe('srt', () => {
  it('formats SRT timestamps', () => {
    assert.equal(formatTimestamp(0), '00:00:00,000');
    assert.equal(formatTimestamp(65.5), '00:01:05,500');
    assert.equal(formatTimestamp(3661.25), '01:01:01,250');
  });

  it('formats cues with numbering and arrows', () => {
    const srt = formatSrt([
      { start: 1.0, end: 3.2, label: 'run-up' },
      { start: 3.2, end: 5.0, label: 'throw' },
    ]);
    assert.equal(
      srt,
      '1\n00:00:01,000 --> 00:00:03,200\nrun-up\n\n2\n00:00:03,200 --> 00:00:05,000\nthrow\n\n'
    );
  });

  it('normalizes segments: sorts, drops bad rows, clamps to duration', () => {
    const segs = normalizeSegments(
      [
        { start: 5, end: 9, label: 'b' },
        { start: 1, end: 3, label: 'a' },
        { start: 4, end: 4, label: 'zero-length' },
        { start: -1, end: 2, label: 'negative' },
        { start: 2, end: 3, label: '   ' },
        { start: 'x', end: 3, label: 'nan' },
      ],
      6
    );
    assert.deepEqual(segs, [
      { start: 1, end: 3, label: 'a' },
      { start: 5, end: 6, label: 'b' },
    ]);
  });

  it('returns null when nothing usable remains', () => {
    assert.equal(normalizeSegments([], null), null);
    assert.equal(normalizeSegments('nope', null), null);
    assert.equal(normalizeSegments([{ start: 0, end: 0, label: 'x' }], null), null);
  });
});
