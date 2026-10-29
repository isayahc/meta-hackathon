import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverlaySvg,
  resolveApiKey,
} from './lib/analyze-response.js';

describe('buildOverlaySvg', () => {
  it('renders image, paths, and boxes exactly', () => {
    const svg = buildOverlaySvg({
      width: 256,
      height: 256,
      imageHref: 'tile.jpg',
      boxes: [{ left: 5, top: 34, right: 108, bottom: 137 }],
      paths: [{ d: 'M0 0L10 0L10 10Z', left: 5, top: 34 }],
    });
    assert.equal(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">\n' +
        '<image href="tile.jpg" x="0" y="0" width="256" height="256"/>\n' +
        '<path d="M0 0L10 0L10 10Z" transform="translate(5 34)" fill="hsl(0 90% 55%)" fill-opacity="0.35" stroke="hsl(0 90% 55%)" stroke-width="2"/>\n' +
        '<rect x="5" y="34" width="103" height="103" fill="none" stroke="white" stroke-width="2"/>\n' +
        '</svg>\n'
    );
  });

  it('escapes untrusted strings', () => {
    const svg = buildOverlaySvg({
      width: 10,
      height: 10,
      imageHref: 'a"b<c',
      boxes: [],
      paths: [],
    });
    assert.ok(svg.includes('href="a&quot;b&lt;c"'));
    assert.ok(!svg.includes('a"b<c'));
  });

  it('works without an image layer', () => {
    const svg = buildOverlaySvg({ width: 0, height: -5, boxes: [], paths: [] });
    assert.ok(svg.includes('viewBox="0 0 1 1"'));
    assert.ok(!svg.includes('<image'));
  });
});

describe('resolveApiKey', () => {
  it('prefers the env var untouched', async () => {
    const saved = process.env.META_API_KEY;
    process.env.META_API_KEY = '  env-key  ';
    try {
      assert.equal(await resolveApiKey(), 'env-key');
    } finally {
      if (saved === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = saved;
    }
  });

  it('throws when keyless and non-interactive', async () => {
    const savedKey = process.env.META_API_KEY;
    const savedAppData = process.env.APPDATA;
    delete process.env.META_API_KEY;
    process.env.APPDATA = 'definitely-not-a-real-dir-12345';
    try {
      await assert.rejects(resolveApiKey(), /META_API_KEY/);
    } finally {
      if (savedKey === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = savedKey;
      if (savedAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = savedAppData;
    }
  });
});
