// Transport diagnostics: cause chains surface bounded and sanitized;
// HTTP statuses resolve for the caller, never reported as unreachable.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorplanPrompt, formatTransportError, postApi, serializeTransportError } from './analyze-response.js';

describe('formatTransportError', () => {
  it('passes a plain message through', () => {
    assert.equal(formatTransportError(new TypeError('fetch failed')), 'fetch failed');
  });

  it('appends cause codes and messages', () => {
    const err = new TypeError('fetch failed', {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' },
    });
    assert.equal(formatTransportError(err), 'fetch failed <- ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9');
  });

  it('flattens nested aggregate errors without naming the container', () => {
    const err = new TypeError('fetch failed', {
      cause: new AggregateError(
        [
          { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.meta.ai' },
          { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:443' },
        ],
        'all attempts failed'
      ),
    });
    const text = formatTransportError(err);
    assert.match(text, /ENOTFOUND: getaddrinfo ENOTFOUND api\.meta\.ai/);
    assert.match(text, /ECONNREFUSED: connect ECONNREFUSED 10\.0\.0\.1:443/);
    assert.doesNotMatch(text, /AggregateError/);
    assert.doesNotMatch(text, /all attempts failed/);
  });

  it('redacts bearer tokens and image data', () => {
    const text = formatTransportError(new Error('denied for Bearer sk-secret-token and data:image/png;base64,iVBORw0KGgoAAA='));
    assert.match(text, /Bearer \[REDACTED\]/);
    assert.match(text, /data:\.\.\.\[REDACTED\]/);
    assert.doesNotMatch(text, /sk-secret-token/);
    assert.doesNotMatch(text, /iVBORw0KGgo/);
  });

  it('bounds deep chains and long messages', () => {
    let err: unknown = { code: 'E0', message: 'deep' };
    for (let i = 1; i <= 10; i++) err = { code: `E${i}`, message: `m${i}`, cause: err };
    const text = formatTransportError(err);
    assert.ok(text.length <= 800);
    assert.match(text, /^E10: m10/);
    assert.doesNotMatch(text, /E0/);
    assert.equal(formatTransportError(new Error('y'.repeat(500))).length, 200);
  });
});

describe('serializeTransportError', () => {
  it('serializes nested causes as JSON', () => {
    const parsed = JSON.parse(
      serializeTransportError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'nope', port: 9 } }))
    ) as { name: string; message: string; cause: { code: string; port: number } };
    assert.equal(parsed.name, 'TypeError');
    assert.equal(parsed.message, 'fetch failed');
    assert.equal(parsed.cause.code, 'ECONNREFUSED');
    assert.equal(parsed.cause.port, 9);
  });

  it('redacts secrets and drops stacks', () => {
    const err = new Error('boom', {
      cause: { Authorization: 'Bearer sk-live-token', api_key: 'sk-live-token', img: 'data:image/png;base64,iVBORw0KGgo', stack: 'x'.repeat(100), ok: 1 },
    });
    const text = serializeTransportError(err);
    assert.doesNotMatch(text, /sk-live-token/);
    assert.doesNotMatch(text, /iVBORw0KGgo/);
    assert.match(text, /\[REDACTED\]/);
    const parsed = JSON.parse(text) as { cause: Record<string, unknown> };
    assert.ok(!('stack' in parsed.cause));
    assert.equal(parsed.cause.ok, 1);
  });

  it('survives circular structures and stays bounded', () => {
    const loop: Record<string, unknown> = { message: 'loop' };
    loop.self = loop;
    const text = serializeTransportError({ cause: loop, big: 'z'.repeat(5000) });
    assert.match(text, /Circular/);
    assert.ok(text.length <= 2000);
  });
});

describe('postApi', () => {
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realError = console.error;

  async function withStubs<T>(fetchImpl: typeof fetch, fn: (seen: { exitCode: number | null; logged: string[] }) => Promise<T>): Promise<T> {
    const seen = { exitCode: null as number | null, logged: [] as string[] };
    globalThis.fetch = fetchImpl;
    process.exit = ((code?: number) => {
      seen.exitCode = code ?? 0;
      throw new Error('__process_exit__');
    }) as unknown as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      seen.logged.push(args.map(String).join(' '));
    }) as unknown as typeof console.error;
    try {
      return await fn(seen);
    } finally {
      globalThis.fetch = realFetch;
      process.exit = realExit;
      console.error = realError;
    }
  }

  it('exits 1 with the cause chain plus serialized detail on network rejection', async () => {
    const failing = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' } });
    };
    await withStubs(failing as typeof fetch, async (seen) => {
      await assert.rejects(postApi('https://api.meta.ai/v1/chat/completions', 'k', {}), /__process_exit__/);
      assert.equal(seen.exitCode, 1);
      assert.equal(seen.logged.length, 2);
      assert.match(seen.logged[0], /^API unreachable: fetch failed/);
      assert.match(seen.logged[0], /ECONNREFUSED/);
      assert.match(seen.logged[1], /^detail: \{/);
      const detail = JSON.parse(seen.logged[1].slice('detail: '.length)) as { name: string; cause: { code: string } };
      assert.equal(detail.name, 'TypeError');
      assert.equal(detail.cause.code, 'ECONNREFUSED');
    });
  });

  it('resolves HTTP failures for the caller to report', async () => {
    const res = { ok: false, status: 503, text: async () => 'overloaded' };
    await withStubs((async () => res) as unknown as typeof fetch, async (seen) => {
      assert.equal(await postApi('https://x', 'k', {}), res);
      assert.equal(seen.exitCode, null);
      assert.deepEqual(seen.logged, []);
    });
  });

  it('resolves successful responses untouched', async () => {
    const res = { ok: true, status: 200, json: async () => ({ choices: [] }) };
    await withStubs((async () => res) as unknown as typeof fetch, async (seen) => {
      assert.equal(await postApi('https://x', 'k', {}), res);
      assert.equal(seen.exitCode, null);
    });
  });
});

describe('buildFloorplanPrompt', () => {
  it('shows a two-endpoint wall path example', () => {
    const prompt = buildFloorplanPrompt();
    assert.match(prompt, /"path": \[\[0,0\],\[1,1\]\] or null/);
    assert.doesNotMatch(prompt, /\[\[\[0,0\],\[1,1\]\]\]/);
    assert.match(prompt, /one wall entry per straight run/);
    assert.match(prompt, /at most two rooms/);
    assert.match(prompt, /never the words room, zone, outdoor/);
    assert.match(prompt, /verify every wall path/);
  });
});
