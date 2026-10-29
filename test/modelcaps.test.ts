import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadableStream } from 'node:stream/web';
import { MODELCAPS_MAX_BYTES, modelcapsArguments, modelcapsProxyUrl, parseModelsResponse, refreshModelCaps } from '../src/core/modelcaps.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modelcaps');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));
const proxyEnv = { OPENAI_API_KEY: 'phm_fixture', OPENAI_BASE_URL: 'http://127.0.0.1:43123/openai/v1' };
const fixedNow = new Date('2026-10-26T03:00:00.000Z');
const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const responder = (value: unknown): typeof fetch => vi.fn(async () => jsonResponse(value)) as typeof fetch;

describe('modelcaps fixture parser', () => {
  it('extracts basic OpenAI models in deterministic ID order without guessing capabilities', () => {
    expect(parseModelsResponse(fixture('openai'))).toEqual([
      { id: 'model-a', contextWindowTokens: null, maxOutputTokens: null, capabilities: { tools: null, vision: null, reasoning: null } },
      { id: 'model-z', contextWindowTokens: null, maxOutputTokens: null, capabilities: { tools: null, vision: null, reasoning: null } },
    ]);
  });

  it('retains explicit false, unknown and true metadata while discarding extra fields', () => {
    const parsed = parseModelsResponse(fixture('extended'));
    expect(parsed).toEqual([
      { id: 'fixture/model-booleans', contextWindowTokens: 64000, maxOutputTokens: null, capabilities: { tools: true, vision: false, reasoning: null } },
      { id: 'fixture/model-tags', contextWindowTokens: 128000, maxOutputTokens: 8192, capabilities: { tools: true, vision: true, reasoning: null } },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('must-not-be-cached');
  });

  it('accepts an empty list and leaves absent tags unknown', () => {
    expect(parseModelsResponse({ data: [] })).toEqual([]);
    expect(parseModelsResponse({ data: [{ id: 'a', capabilities: [] }] })[0]!.capabilities)
      .toEqual({ tools: null, vision: null, reasoning: null });
  });

  it.each([null, [], {}, { data: {} }, { data: [], object: 'model' }, { data: [], error: null },
    { data: [], has_more: true }, { data: [], has_more: 'false' }, { data: [], next_page: 'cursor' },
    { data: [], next: '/v1/models?page=2' }].map(value => [value]))('rejects malformed or incomplete envelopes: %j', value => {
    expect(() => parseModelsResponse(value)).toThrow('modelcaps:');
  });

  it('rejects fixture pagination instead of presenting partial inventory as complete', () => {
    expect(() => parseModelsResponse(fixture('partial'))).toThrow('incomplete');
  });

  it.each([null, [], {}, { id: '' }, { id: 'bad\nname' }, { id: ' bad' }, { id: 'a'.repeat(257) },
    { id: 'a', object: 'list' }, { id: 12 }].map(row => [row]))('rejects malformed model rows: %j', row => {
    expect(() => parseModelsResponse({ data: [row] })).toThrow('modelcaps:');
  });

  it('rejects duplicates and excessive row counts', () => {
    expect(() => parseModelsResponse({ data: [{ id: 'same' }, { id: 'same' }] })).toThrow('duplicate');
    expect(() => parseModelsResponse({ data: Array.from({ length: 10001 }, (_, i) => ({ id: `m-${i}` })) })).toThrow('model list');
  });

  it.each([0, -1, 1.5, '128000', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects invalid token limits: %s', limit => {
    expect(() => parseModelsResponse({ data: [{ id: 'a', context_length: limit }] })).toThrow('token limit');
    expect(() => parseModelsResponse({ data: [{ id: 'a', max_output_tokens: limit }] })).toThrow('token limit');
  });

  it.each([true, 'tools', [false], ['a'.repeat(65)], Array(65).fill('tools'), { tools: 'true' }, { vision: 0 }].map(value => [value]))('rejects malformed capabilities: %j', capabilities => {
    expect(() => parseModelsResponse({ data: [{ id: 'a', capabilities }] })).toThrow('capabilit');
  });
});

describe('modelcaps Secrets proxy and arguments', () => {
  it.each([
    ['http://127.0.0.1:1234', 'http://127.0.0.1:1234/v1/models'],
    ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1/models'],
    ['http://localhost:1234/provider/v1/models/', 'http://localhost:1234/provider/v1/models'],
    ['http://[::1]:1234/provider', 'http://[::1]:1234/provider/v1/models'],
  ])('normalizes proxy endpoint %s', (base, expected) => {
    expect(modelcapsProxyUrl(base, 'phm_fixture').href).toBe(expected);
  });

  it.each([
    ['https://api.example.test/v1', 'phm_fixture'],
    ['http://127.0.0.1.evil.test:1234', 'phm_fixture'],
    [['http://', 'user', ':', 'password', '@', 'localhost:1234'].join(''), 'phm_fixture'],
    ['http://localhost:1234?token=secret', 'phm_fixture'],
    ['http://localhost:1234#fragment', 'phm_fixture'],
    ['file:///v1', 'phm_fixture'],
    ['invalid', 'phm_fixture'],
    ['http://localhost:1234', 'raw-fixture-key'],
    ['http://localhost:1234', 'phm_'],
    [undefined, 'phm_fixture'],
    ['http://localhost:1234', undefined],
  ])('refuses unsafe transport without echoing its input: %s', (base, credential) => {
    try { modelcapsProxyUrl(base, credential); expect.fail('unsafe transport accepted'); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^modelcaps:/);
      expect((error as Error).message).not.toContain('password');
      expect((error as Error).message).not.toContain('raw-fixture-key');
    }
  });

  it('parses explicit output and a local default', () => {
    expect(modelcapsArguments(['--provider', 'fixture', '--output', '/private/cache.json']))
      .toEqual({ provider: 'fixture', output: '/private/cache.json' });
    expect(modelcapsArguments(['--provider', 'fixture']).output).toMatch(/[/\\]\.ashlr[/\\]modelcaps[/\\]fixture\.json$/);
  });

  it.each([[], ['--provider'], ['--unknown', 'x'], ['--provider', '--output'],
    ['--provider', 'a', '--provider', 'b'], ['--provider', 'a', '--output', '/a', '--output', '/b']].map(args => [args]))('rejects missing, unknown and duplicate arguments: %j', args => {
    expect(() => modelcapsArguments(args)).toThrow('modelcaps:');
  });
});

describe('modelcaps cache refresh with fixture transport', () => {
  let directory: string;
  let output: string;

  beforeEach(() => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'modelcaps-test-'));
    output = join(directory, 'cache.json');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network forbidden'); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  const options = () => ({ provider: 'fixture', output, env: proxyEnv, now: () => fixedNow });

  it('persists a private modelcaps.v1 cache through the injected proxy and replaces it atomically', async () => {
    const fetchImpl = responder(fixture('extended'));
    const cache = await refreshModelCaps({ ...options(), fetchImpl });
    expect(cache).toMatchObject({ schema: 'modelcaps.v1', provider: 'fixture', source: '/v1/models',
      observedAt: '2026-10-26T03:00:00.000Z', expiresAt: '2026-10-27T03:00:00.000Z' });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(cache);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:43123/openai/v1/models');
    expect(request).toMatchObject({ method: 'GET', redirect: 'error', headers: {
      Accept: 'application/json', Authorization: 'Bearer phm_fixture',
    } });
    expect(request!.signal).toBeInstanceOf(AbortSignal);
    if (process.platform !== 'win32') {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(output).mode & 0o777).toBe(0o600);
    }
    const next = await refreshModelCaps({ ...options(), fetchImpl: responder({ data: [] }) });
    expect(next.models).toEqual([]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(next);
    expect(readdirSync(directory)).toEqual(['cache.json']);
    expect(readFileSync(output, 'utf8')).not.toContain('phm_fixture');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500, 206])('preserves the prior file on HTTP %s', async status => {
    writeFileSync(output, 'prior-cache', { mode: 0o600 });
    const fetchImpl = vi.fn(async () => new Response('private upstream error', { status })) as typeof fetch;
    await expect(refreshModelCaps({ ...options(), fetchImpl })).rejects.toThrow('modelcaps: probe failed');
    expect(readFileSync(output, 'utf8')).toBe('prior-cache');
  });

  it.each([
    () => new Response('{not JSON'),
    () => jsonResponse({ data: [null] }),
    () => new Response(JSON.stringify({ data: [] }), { headers: { Link: '</models?page=2>; rel="next"' } }),
    () => new Response(JSON.stringify({ data: [] }), { headers: { Link: '</models?page=2>; rel=next' } }),
    () => new Response(JSON.stringify({ data: [] }), { headers: { Link: '</models?page=2>; rel="prev next"' } }),
    () => new Response('{}', { headers: { 'Content-Length': String(MODELCAPS_MAX_BYTES + 1) } }),
    () => new Response('{}', { headers: { 'Content-Length': 'unknown' } }),
    () => new Response(' '.repeat(MODELCAPS_MAX_BYTES + 1)),
    () => new Response(new Uint8Array([0xff, 0xfe])),
    () => new Response(null),
  ])('preserves prior data when the response is invalid, partial or oversized: %#', async response => {
    writeFileSync(output, 'prior-cache', { mode: 0o600 });
    const fetchImpl = vi.fn(async () => response()) as typeof fetch;
    await expect(refreshModelCaps({ ...options(), fetchImpl })).rejects.toThrow('modelcaps: probe failed');
    expect(readFileSync(output, 'utf8')).toBe('prior-cache');
    expect(readdirSync(directory)).toEqual(['cache.json']);
  });

  it('redacts transport failures including credential-bearing messages', async () => {
    writeFileSync(output, 'prior-cache', { mode: 0o600 });
    const fetchImpl = vi.fn(async () => { throw new Error(['http://', 'user', ':', 'secret', '@', 'example.test', ' ', proxyEnv.OPENAI_API_KEY].join('')); }) as typeof fetch;
    await expect(refreshModelCaps({ ...options(), fetchImpl })).rejects.toThrow(/^modelcaps: probe failed$/);
    expect(readFileSync(output, 'utf8')).toBe('prior-cache');
  });

  it('bounds a stalled request and aborts it without altering prior data', async () => {
    writeFileSync(output, 'prior-cache', { mode: 0o600 });
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
    await expect(refreshModelCaps({ ...options(), fetchImpl, timeoutMs: 10 })).rejects.toThrow('modelcaps: probe failed');
    expect(vi.mocked(fetchImpl).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('prior-cache');
  });

  it('bounds a stalled body and cancels its reader', async () => {
    writeFileSync(output, 'prior-cache', { mode: 0o600 });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetchImpl = vi.fn(async () => new Response(stream as unknown as BodyInit)) as typeof fetch;
    await expect(refreshModelCaps({ ...options(), fetchImpl, timeoutMs: 10 })).rejects.toThrow('modelcaps: probe failed');
    expect(cancel).toHaveBeenCalled();
    expect(readFileSync(output, 'utf8')).toBe('prior-cache');
  });

  it.each([{ provider: 'bad provider' }, { output: 'relative.json' }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: 1.5 }])('rejects invalid configuration before transport: %j', async invalid => {
    const fetchImpl = responder({ data: [] });
    await expect(refreshModelCaps({ ...options(), fetchImpl, ...invalid })).rejects.toThrow('modelcaps: invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a symlink target and leaves the referenced data intact', async () => {
    const other = join(directory, 'other.json');
    writeFileSync(other, 'keep-me', { mode: 0o600 });
    symlinkSync(other, output);
    await expect(refreshModelCaps({ ...options(), fetchImpl: responder({ data: [] }) })).rejects.toThrow('unsafe cache file');
    expect(readFileSync(other, 'utf8')).toBe('keep-me');
  });

  it('rejects parent symlinks before creating any descendant directory', async () => {
    const target = join(directory, 'elsewhere');
    const alias = join(directory, 'alias');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, alias, 'dir');
    await expect(refreshModelCaps({ ...options(), output: join(alias, 'nested', 'cache.json'),
      fetchImpl: responder({ data: [] }) })).rejects.toThrow('unsafe cache directory');
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses a nonprivate existing directory without changing permissions', async () => {
    if (process.platform === 'win32') return;
    chmodSync(directory, 0o755);
    await expect(refreshModelCaps({ ...options(), fetchImpl: responder({ data: [] }) })).rejects.toThrow('must be private');
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    expect(readdirSync(directory)).toEqual([]);
  });
});
