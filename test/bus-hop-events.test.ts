import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBusHopEvent, emitBusHopEvent, localTelemetryDir,
  type BusHopEvent, type BusHopInput,
} from '../src/core/observability/telemetry-sink.js';

const forbiddenCredentialProcess = vi.hoisted(() => vi.fn(() => {
  throw new Error('credential subprocess forbidden');
}));
vi.mock('node:child_process', () => ({
  spawn: forbiddenCredentialProcess, spawnSync: forbiddenCredentialProcess,
  execFile: forbiddenCredentialProcess, execFileSync: forbiddenCredentialProcess,
}));

const host = 'https://us.i.posthog.com';
let testHome: string;
let fakeKey: string;
let fetchMock: ReturnType<typeof vi.fn>;

function hop(overrides: Partial<BusHopInput> = {}): BusHopInput {
  return { node: 'node-5', engine: 'codex-cmp', tokensIn: 120, tokensOut: 30,
    costUsd: 0.004, job: 'RQ-BUS-5A', pr: 42, ...overrides };
}

function spool(): { text: string; events: BusHopEvent[]; file: string } {
  const files = readdirSync(localTelemetryDir());
  expect(files).toHaveLength(1);
  const file = join(localTelemetryDir(), files[0]!);
  const text = readFileSync(file, 'utf8');
  return { text, events: text.trim().split('\n').map(line => JSON.parse(line)), file };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'phantom-bus-hop-'));
  vi.stubEnv('HOME', testHome);
  vi.stubEnv('POSTHOG_API_KEY', '');
  // Runtime-built, deliberately FAKE; never a real credential or tracked token.
  fakeKey = ['phc', 'FAKE', randomUUID().replaceAll('-', '')].join('_');
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  expect(forbiddenCredentialProcess).not.toHaveBeenCalled();
  expect(process.stdout.write).not.toHaveBeenCalled();
  expect(process.stderr.write).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});

describe('bus hop schema v1', () => {
  it('builds a PostHog event with all required metadata and a stable insert ID', () => {
    const event = buildBusHopEvent(hop());
    expect(event).toEqual({
      event: 'phantom_bus_hop', timestamp: expect.any(String), properties: {
        schema_version: 1, $insert_id: expect.any(String), $process_person_profile: false,
        distinct_id: 'node-5', node: 'node-5', engine: 'codex-cmp',
        tokens_in: 120, tokens_out: 30, cost_usd: 0.004, job: 'RQ-BUS-5A', pr: 42,
      },
    });
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(event.properties.$insert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(buildBusHopEvent(hop()).properties.$insert_id).not.toBe(event.properties.$insert_id);
  });

  it('preserves unknown usage, cost and PR as null, distinct from measured zero', () => {
    const unknown = buildBusHopEvent(hop({ tokensIn: null, tokensOut: null, costUsd: null, pr: null }));
    expect(unknown.properties).toMatchObject({ tokens_in: null, tokens_out: null, cost_usd: null, pr: null });
    const zero = buildBusHopEvent(hop({ tokensIn: 0, tokensOut: 0, costUsd: 0 }));
    expect(zero.properties).toMatchObject({ tokens_in: 0, tokens_out: 0, cost_usd: 0 });
  });

  it('drops undeclared runtime properties and objects without serializing them', async () => {
    const privateFields = { ...hop(), prompt: 'PRIVATE PROMPT', apiKey: fakeKey,
      toolArgs: { toJSON: () => { throw new Error('must not serialize'); } } };
    expect((await emitBusHopEvent(privateFields)).ok).toBe(true);
    const { text } = spool();
    expect(text.includes(fakeKey)).toBe(false);
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('toolArgs');
    expect(text).not.toContain('apiKey');
  });

  it.each([
    ['empty node', { node: '' }], ['free text', { job: 'please implement this goal' }],
    ['control characters', { engine: 'codex\nPRIVATE' }], ['long ID', { node: 'x'.repeat(201) }],
    ['negative input', { tokensIn: -1 }], ['fractional input', { tokensIn: 1.5 }],
    ['unsafe output', { tokensOut: Number.MAX_SAFE_INTEGER + 1 }],
    ['NaN cost', { costUsd: NaN }], ['infinite cost', { costUsd: Infinity }],
    ['negative cost', { costUsd: -0.01 }], ['zero PR', { pr: 0 }], ['fractional PR', { pr: 1.5 }],
    ['missing usage', { tokensIn: undefined }],
  ])('rejects %s without spool or network activity', async (_label, overrides) => {
    const result = await emitBusHopEvent(hop(overrides as Partial<BusHopInput>), { posthogHost: host });
    expect(result).toEqual({ ok: false, spooled: false, delivered: false, detail: 'invalid bus hop metadata' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => readdirSync(localTelemetryDir())).toThrow();
  });

  it('rejects credential-shaped metadata even without a configured key', async () => {
    expect((await emitBusHopEvent(hop({ job: fakeKey }))).ok).toBe(false);
    const fakeOtherKey = ['sk', 'FAKE', randomUUID().replaceAll('-', '')].join('-');
    expect((await emitBusHopEvent(hop({ engine: fakeOtherKey }))).ok).toBe(false);
  });

  it('rejects an opaque environment credential embedded in metadata', async () => {
    const fakeOpaqueKey = ['FAKE', randomUUID().slice(0, 8)].join('-');
    vi.stubEnv('POSTHOG_API_KEY', fakeOpaqueKey);
    expect((await emitBusHopEvent(hop({ node: `prefix-${fakeOpaqueKey}` }))).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates and emits a single snapshot even when input has a changing getter', async () => {
    let reads = 0;
    const input = { ...hop(), get job() { return ++reads === 1 ? 'RQ-BUS-5A' : fakeKey; } };
    expect((await emitBusHopEvent(input)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(spool().events[0]?.properties.job).toBe('RQ-BUS-5A');
    expect(spool().text.includes(fakeKey)).toBe(false);
  });

  it('contains a throwing input getter without exposing its message', async () => {
    const input = { ...hop(), get job(): string { throw new Error(fakeKey); } };
    expect(() => buildBusHopEvent(input)).toThrow('invalid bus hop metadata');
    expect(await emitBusHopEvent(input)).toEqual({
      ok: false, spooled: false, delivered: false, detail: 'invalid bus hop metadata',
    });
  });
});

describe('local-first hop emitter', () => {
  it('defaults to disk even when a PostHog credential exists', async () => {
    vi.stubEnv('POSTHOG_API_KEY', fakeKey);
    expect(await emitBusHopEvent(hop())).toEqual({
      ok: true, spooled: true, delivered: false, detail: 'spooled locally',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const { file, text, events } = spool();
    expect(file).toMatch(/bus-hop-\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes(fakeKey)).toBe(false);
    expect(events[0]?.properties.job).toBe('RQ-BUS-5A');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(localTelemetryDir()).mode & 0o777).toBe(0o700);
    }
  });

  it('appends independent JSONL events without truncating earlier hops', async () => {
    await Promise.all([emitBusHopEvent(hop()), emitBusHopEvent(hop({ node: 'node-6' }))]);
    expect(spool().events.map(event => event.properties.node)).toEqual(['node-5', 'node-6']);
  });

  it.each(['', '   ', ['phm', 'FAKE', 'placeholder'].join('_')])('stays local when credential is unavailable (%#)', async key => {
    vi.stubEnv('POSTHOG_API_KEY', key);
    expect(await emitBusHopEvent(hop(), { posthogHost: host })).toMatchObject({
      ok: true, spooled: true, delivered: false, detail: 'spooled locally; PostHog credential unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spool().events).toHaveLength(1);
  });

  it('returns a value-free spool error and makes no request when disk is unavailable', async () => {
    vi.stubEnv('POSTHOG_API_KEY', fakeKey);
    writeFileSync(join(testHome, '.ashlr'), 'not a directory');
    expect(await emitBusHopEvent(hop(), { posthogHost: host })).toEqual({
      ok: false, spooled: false, delivered: false, detail: 'bus hop spool unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('optional PostHog hop delivery', () => {
  beforeEach(() => vi.stubEnv('POSTHOG_API_KEY', fakeKey));

  it('spools before POST and sends the same event with a request-only token', async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${host}/i/v0/e/`);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const { token, ...event } = JSON.parse(init.body as string);
      expect(token === fakeKey).toBe(true);
      expect(event).toEqual(spool().events[0]);
      expect(spool().text.includes(fakeKey)).toBe(false);
      return new Response(null, { status: 200 });
    });
    expect(await emitBusHopEvent(hop(), { posthogHost: host })).toEqual({
      ok: true, spooled: true, delivered: true, detail: 'delivered to PostHog',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spool().events).toHaveLength(1);
  });

  it('uses the current environment credential separately for each emit', async () => {
    await emitBusHopEvent(hop(), { posthogHost: host });
    vi.stubEnv('POSTHOG_API_KEY', '');
    expect((await emitBusHopEvent(hop(), { posthogHost: host })).delivered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spool().events).toHaveLength(2);
  });

  it.each(['http://us.i.posthog.com', 'https://example.com/path', 'https://example.com/?query=1',
    'https://example.com/#fragment', 'https://user@example.com', 'not a URL'])('rejects unsafe host %s while retaining spool', async posthogHost => {
    expect(await emitBusHopEvent(hop(), { posthogHost })).toEqual({
      ok: false, spooled: true, delivered: false, detail: 'invalid PostHog host',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spool().events).toHaveLength(1);
  });

  it('does not accept credential-bearing origins', async () => {
    expect((await emitBusHopEvent(hop(), { posthogHost: `https://${fakeKey}.example.com` })).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('contains a throwing options getter after preserving the event', async () => {
    expect(await emitBusHopEvent(hop(), { get posthogHost(): string { throw new Error(fakeKey); } })).toEqual({
      ok: false, spooled: true, delivered: false, detail: 'invalid PostHog host',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spool().events).toHaveLength(1);
  });

  it('does not wait for an uncooperative response stream to cancel', async () => {
    const cancel = vi.fn(() => new Promise(() => {}));
    fetchMock.mockResolvedValue({ ok: true, body: { cancel } });
    expect((await emitBusHopEvent(hop(), { posthogHost: host })).delivered).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 429, 500])('retains spool on HTTP %i and never reads the response body', async status => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const text = vi.fn(() => { throw new Error(fakeKey); });
    fetchMock.mockResolvedValue({ ok: false, status, text, body: { cancel } });
    expect(await emitBusHopEvent(hop(), { posthogHost: host })).toEqual({
      ok: false, spooled: true, delivered: false, detail: 'PostHog request rejected',
    });
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(spool().text.includes(fakeKey)).toBe(false);
  });

  it('does not return or log credential-bearing thrown values', async () => {
    fetchMock.mockRejectedValue(new Error(`FAKE transport failure ${fakeKey}`));
    const result = await emitBusHopEvent(hop(), { posthogHost: host });
    expect(result.detail).toBe('PostHog request failed');
    expect(JSON.stringify(result).includes(fakeKey)).toBe(false);
    expect(spool().text.includes(fakeKey)).toBe(false);
  });

  it('aborts a stalled request at the bounded deadline and retains spool', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error(fakeKey)), { once: true });
    }));
    const pending = emitBusHopEvent(hop(), { posthogHost: host });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      ok: false, spooled: true, delivered: false, detail: 'PostHog request timed out',
    });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(spool().events).toHaveLength(1);
  });
});
