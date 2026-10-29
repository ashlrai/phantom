/**
 * m19.telemetry-sink.test.ts — hermetic tests for core/observability/telemetry-sink.ts
 *
 * Covers:
 *   - getSink returns LocalFileSink when cfg.telemetry.pulse is not set
 *   - getSink returns LocalFileSink when pulse is set but no PAT is available
 *   - getSink returns OtlpHttpSink when both pulse endpoint AND PAT are configured
 *   - patAvailable returns a boolean (never the PAT value)
 *   - patAvailable returns true when ASHLR_PULSE_TOKEN env var is set
 *   - patAvailable returns false when no PAT source is available
 *   - LocalFileSink.emit never throws; returns { sink:'local', ok, detail }
 *   - LocalFileSink.emit writes JSONL to localTelemetryDir()
 *   - OtlpHttpSink.emit POSTs to cfg.telemetry.pulse with Authorization: Bearer <PAT>
 *   - OtlpHttpSink.emit: PAT appears ONLY in Authorization header, NEVER in body/attrs
 *   - OtlpHttpSink.emit: POST body is valid JSON OTLP (no PAT in body)
 *   - OtlpHttpSink.emit: returns { sink:'otlp', ok, detail } — detail never holds PAT
 *   - OtlpHttpSink.emit never throws on network failure (best-effort, fire-and-forget)
 *   - OtlpHttpSink.emit never throws on timeout
 *   - emits from a tiny local HTTP server that captures POST — asserts OTLP shape +
 *     Authorization: Bearer present + no secret in JSON body
 *   - localTelemetryDir returns a string path under ~/.ashlr/telemetry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { parseNativeOtelTrace, type ReceivedOtelSpan } from '../src/core/observability/otlp.js';
import { startOtlpReceiver } from '../src/core/observability/otlp-receiver.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestTokenEvidence } from '../src/core/run/token-evidence.js';
import type { AshlrConfig, GenAiSpan } from '../src/core/types.js';

const credentialSpawn = vi.hoisted(() => vi.fn(() => { throw new Error('telemetry credential subprocess forbidden'); }));
vi.mock('node:child_process', () => ({ spawn: credentialSpawn, spawnSync: credentialSpawn }));

// ---------------------------------------------------------------------------
// Mock node:fs for LocalFileSink (prevent real filesystem writes in tests)
// ---------------------------------------------------------------------------

const mockMkdirSync = vi.fn();
const mockAppendFileSync = vi.fn();
const mockExistsSync = vi.fn(() => true);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  };
});

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import {
  getSink,
  patAvailable,
  localTelemetryDir,
} from '../src/core/observability/telemetry-sink.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAT_VALUE = 'super-secret-pat-value-DO-NOT-LOG';
const PULSE_ENDPOINT = 'http://localhost:4318/v1/traces';

function makeConfig(overrides: Partial<AshlrConfig['telemetry']> = {}): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: { ...overrides },
    tools: {},
  };
}

function makeSpan(overrides: Partial<GenAiSpan> = {}): GenAiSpan {
  return {
    name: 'task-001',
    runId: 'run-abc',
    model: 'claude-3-5-sonnet',
    provider: 'anthropic',
    tier: 'cloud',
    tokensIn: 1000,
    tokensOut: 500,
    estCostUsd: 0.0105,
    status: 'done',
    startTs: new Date(Date.now() - 5000).toISOString(),
    endTs: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Spin up a tiny local HTTP server for integration-style OTLP delivery tests
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startCaptureServer(): Promise<{ server: http.Server; captured: CapturedRequest[]; port: number }> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {} }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, captured, port };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Remove ASHLR_PULSE_TOKEN from env by default
  delete process.env['ASHLR_PULSE_TOKEN'];
});

afterEach(() => {
  delete process.env['ASHLR_PULSE_TOKEN'];
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// localTelemetryDir
// ---------------------------------------------------------------------------

describe('localTelemetryDir', () => {
  it('returns a string', () => {
    expect(typeof localTelemetryDir()).toBe('string');
  });

  it('is under ~/.ashlr/telemetry', () => {
    const dir = localTelemetryDir();
    const home = os.homedir();
    expect(dir).toContain('.ashlr');
    expect(dir).toContain('telemetry');
    expect(path.isAbsolute(dir)).toBe(true);
    // Should start with the home dir
    expect(dir.startsWith(home)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patAvailable — boolean-only, never returns value
// ---------------------------------------------------------------------------

describe('patAvailable', () => {
  it.each(['', '  ', 'phm_test_placeholder', ' phm_test_placeholder '])('does not call a placeholder/blank PAT ready: %s', value => {
    process.env.ASHLR_PULSE_TOKEN = value;
    const cfg = { ...makeConfig({ pulse: PULSE_ENDPOINT }), phantom: { enabled: true } };
    expect(patAvailable(cfg)).toBe(false);
    expect(credentialSpawn).not.toHaveBeenCalled();
  });
  it('configured Secrets does not prove a usable telemetry credential', async () => {
    delete process.env.ASHLR_PULSE_TOKEN;
    const cfg = { ...makeConfig({ pulse: PULSE_ENDPOINT }), phantom: { enabled: true } };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(patAvailable(cfg)).toBe(false);
    expect(await getSink(cfg, false).emit([makeSpan()])).toEqual({ sink: 'otlp', ok: false, detail: 'PAT unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialSpawn).not.toHaveBeenCalled();
  });
  it('placeholder PAT prevents provider contact on the emit path', async () => {
    process.env.ASHLR_PULSE_TOKEN = 'phm_test_placeholder';
    const cfg = { ...makeConfig({ pulse: PULSE_ENDPOINT }), phantom: { enabled: true } };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await getSink(cfg, false).emit([makeSpan()])).toEqual({ sink: 'otlp', ok: false, detail: 'PAT unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(credentialSpawn).not.toHaveBeenCalled();
  });
  it('returns a boolean (true) when ASHLR_PULSE_TOKEN env is set', () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    const result = patAvailable(makeConfig({ pulse: PULSE_ENDPOINT }));
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  it('returns false when no env var and no phantom PAT', () => {
    delete process.env['ASHLR_PULSE_TOKEN'];
    // With no phantom integration and no env var, should return false
    const result = patAvailable(makeConfig({ pulse: PULSE_ENDPOINT }));
    expect(typeof result).toBe('boolean');
    expect(result).toBe(false);
  });

  it('return value is strictly boolean (not the PAT string)', () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    const result = patAvailable(makeConfig({ pulse: PULSE_ENDPOINT }));
    expect(result).not.toBe(PAT_VALUE);
    expect(result === true || result === false).toBe(true);
  });

  it('returns false when ASHLR_PULSE_TOKEN is empty string', () => {
    process.env['ASHLR_PULSE_TOKEN'] = '';
    const result = patAvailable(makeConfig({ pulse: PULSE_ENDPOINT }));
    expect(result).toBe(false);
  });

  it('never throws', () => {
    expect(() => patAvailable(makeConfig())).not.toThrow();
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    expect(() => patAvailable(makeConfig({ pulse: PULSE_ENDPOINT }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getSink — sink selection logic
// ---------------------------------------------------------------------------

describe('getSink — sink selection', () => {
  it('returns LocalFileSink when no pulse endpoint is configured', () => {
    const sink = getSink(makeConfig());
    expect(sink).toBeDefined();
    expect(typeof sink.emit).toBe('function');
  });

  it('returns LocalFileSink when pulse is set but no PAT available', () => {
    delete process.env['ASHLR_PULSE_TOKEN'];
    const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
    // No PAT → should default to local
    const result = sink.emit([makeSpan()]);
    // Should not throw and should resolve to local sink result
    expect(result).toBeInstanceOf(Promise);
  });

  it('returns OtlpHttpSink when pulse endpoint AND PAT are both configured', () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
    expect(sink).toBeDefined();
    expect(typeof sink.emit).toBe('function');
  });

  it('emit function exists on the returned sink', () => {
    const sink = getSink(makeConfig());
    expect(typeof sink.emit).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// LocalFileSink behavior
// ---------------------------------------------------------------------------

describe('LocalFileSink.emit', () => {
  it('returns a TelemetryEmitResult with sink="local"', async () => {
    const sink = getSink(makeConfig()); // no endpoint → LocalFileSink
    const result = await sink.emit([makeSpan()]);
    expect(result.sink).toBe('local');
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.detail).toBe('string');
  });

  it('never throws — returns ok:true or ok:false but never throws', async () => {
    const sink = getSink(makeConfig());
    await expect(sink.emit([makeSpan()])).resolves.toBeDefined();
  });

  it('never throws even on empty spans array', async () => {
    const sink = getSink(makeConfig());
    await expect(sink.emit([])).resolves.toBeDefined();
  });

  it('detail field never contains a PAT value', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    const sink = getSink(makeConfig()); // still local — no endpoint
    const result = await sink.emit([makeSpan()]);
    expect(result.detail).not.toContain(PAT_VALUE);
  });

  it('detail field never contains prompt or result content', async () => {
    const sink = getSink(makeConfig());
    const result = await sink.emit([makeSpan({ name: 'task-id' })]);
    // detail is metadata only
    expect(result.detail).not.toContain('PRIVATE');
    expect(result.detail).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// OtlpHttpSink best-effort behavior (mocked fetch)
// ---------------------------------------------------------------------------

describe('OtlpHttpSink.emit — mocked fetch', () => {
  it('returns { sink:"otlp", ok:true } on successful POST', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    // Mock global fetch for this test
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"partialSuccess":{}}',
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      const result = await sink.emit([makeSpan()]);

      expect(result.sink).toBe('otlp');
      expect(result.ok).toBe(true);
      expect(typeof result.detail).toBe('string');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('POSTs to the configured pulse endpoint', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const calls: { url: string; init: RequestInit }[] = [];
    const mockFetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '{}',
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const endpoint = 'http://telemetry.example.com/v1/traces';
      const sink = getSink(makeConfig({ pulse: endpoint }));
      await sink.emit([makeSpan()]);

      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]!.url).toBe(endpoint);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends Authorization: Bearer <PAT> header', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const capturedHeaders: Record<string, string>[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaders.push(headers ?? {});
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '{}',
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      await sink.emit([makeSpan()]);

      expect(capturedHeaders.length).toBeGreaterThan(0);
      const headers = capturedHeaders[0]!;
      // Find Authorization header (case-insensitive key lookup)
      const authKey = Object.keys(headers).find(k => k.toLowerCase() === 'authorization');
      expect(authKey).toBeDefined();
      const authValue = headers[authKey!];
      expect(authValue).toMatch(/^Bearer /);
      expect(authValue).toContain(PAT_VALUE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('PAT does NOT appear in the POST body (only in the Authorization header)', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const capturedBodies: string[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBodies.push(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '{}',
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      await sink.emit([makeSpan()]);

      for (const body of capturedBodies) {
        expect(body).not.toContain(PAT_VALUE);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('POST body is valid JSON', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const capturedBodies: string[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? '');
      capturedBodies.push(body);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => '{}',
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      await sink.emit([makeSpan()]);

      for (const body of capturedBodies) {
        expect(() => JSON.parse(body)).not.toThrow();
        const parsed = JSON.parse(body);
        // Should be a valid OTLP trace payload
        expect(parsed).toHaveProperty('resourceSpans');
        expect(Array.isArray(parsed.resourceSpans)).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns ok:false on fetch failure — never throws', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      const result = await sink.emit([makeSpan()]);

      expect(result.sink).toBe('otlp');
      expect(result.ok).toBe(false);
      expect(typeof result.detail).toBe('string');
      // detail should NOT contain the PAT
      expect(result.detail).not.toContain(PAT_VALUE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns ok:false on HTTP error status — never throws', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      const result = await sink.emit([makeSpan()]);

      expect(result.ok).toBe(false);
      expect(result.detail).not.toContain(PAT_VALUE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('detail in TelemetryEmitResult never contains PAT value on success or failure', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    // Test success case
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' }));
    let sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
    let result = await sink.emit([makeSpan()]);
    expect(result.detail).not.toContain(PAT_VALUE);
    vi.unstubAllGlobals();

    // Test failure case
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
    result = await sink.emit([makeSpan()]);
    expect(result.detail).not.toContain(PAT_VALUE);
    vi.unstubAllGlobals();
  });

  it('sets Content-Type: application/json header', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    const capturedInits: RequestInit[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedInits.push(init);
      return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
    });
    vi.stubGlobal('fetch', mockFetch);

    try {
      const sink = getSink(makeConfig({ pulse: PULSE_ENDPOINT }));
      await sink.emit([makeSpan()]);

      const headers = capturedInits[0]!.headers as Record<string, string>;
      const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
      expect(ctKey).toBeDefined();
      expect(headers[ctKey!]).toContain('application/json');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: tiny local HTTP server captures the POST
// ---------------------------------------------------------------------------

describe('OtlpHttpSink — real HTTP delivery to local capture server', () => {
  it('delivers a valid OTLP POST with Authorization: Bearer + no secret in body', async () => {
    const { server, captured, port } = await startCaptureServer();
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    try {
      const endpoint = `http://127.0.0.1:${port}/v1/traces`;
      const sink = getSink(makeConfig({ pulse: endpoint }));
      const result = await sink.emit([makeSpan()]);

      // The emit should succeed
      expect(result.sink).toBe('otlp');
      expect(result.ok).toBe(true);

      // The server must have received exactly one request
      expect(captured.length).toBe(1);
      const req = captured[0]!;

      // Method must be POST
      expect(req.method).toBe('POST');

      // Authorization header must be present and contain Bearer + PAT
      const authHeader = req.headers['authorization'];
      expect(authHeader).toBeDefined();
      expect(authHeader).toMatch(/^Bearer /);
      expect(authHeader).toContain(PAT_VALUE);

      // Body must be valid JSON
      expect(() => JSON.parse(req.body)).not.toThrow();
      const body = JSON.parse(req.body);

      // Body must be a valid OTLP traces payload
      expect(body).toHaveProperty('resourceSpans');
      expect(Array.isArray(body.resourceSpans)).toBe(true);

      // PAT must NOT appear anywhere in the JSON body
      expect(req.body).not.toContain(PAT_VALUE);

      // Result detail must not contain PAT
      expect(result.detail).not.toContain(PAT_VALUE);
    } finally {
      await stopServer(server);
      delete process.env['ASHLR_PULSE_TOKEN'];
    }
  });

  it('body contains OTLP resourceSpans with spans having gen_ai attributes', async () => {
    const { server, captured, port } = await startCaptureServer();
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    try {
      const endpoint = `http://127.0.0.1:${port}/v1/traces`;
      const sink = getSink(makeConfig({ pulse: endpoint }));
      await sink.emit([
        makeSpan({ tokensIn: 999, tokensOut: 444, model: 'test-model', provider: 'test-provider', tokenEvidence: requestTokenEvidence('reported', 999, 444) }),
        makeSpan({ tokensIn: 999, tokensOut: 444, model: 'unknown-model', provider: 'test-provider' }),
      ]);

      const body = JSON.parse(captured[0]!.body);
      const spans = body.resourceSpans
        .flatMap((rs: { scopeSpans: { spans: unknown[] }[] }) =>
          rs.scopeSpans.flatMap((ss: { spans: unknown[] }) => ss.spans),
        );
      expect(spans.length).toBeGreaterThan(0);

      const attrKeys = (spans[0] as { attributes: { key: string }[] }).attributes.map((a) => a.key);
      expect(attrKeys).toContain('gen_ai.system');
      expect(attrKeys).toContain('gen_ai.request.model');
      expect(attrKeys).toContain('gen_ai.usage.input_tokens');
      expect(attrKeys).toContain('gen_ai.usage.output_tokens');
      const unknownKeys = (spans[1] as { attributes: { key: string }[] }).attributes.map(a => a.key);
      expect(unknownKeys).toContain('phantom.accounted.input_tokens');
      expect(unknownKeys).not.toContain('gen_ai.usage.input_tokens');
      expect(unknownKeys).not.toContain('gen_ai.usage.output_tokens');
    } finally {
      await stopServer(server);
      delete process.env['ASHLR_PULSE_TOKEN'];
    }
  });

  it('body does not contain any private content from span metadata', async () => {
    const { server, captured, port } = await startCaptureServer();
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;
    const PRIVATE_MARKER = 'PRIVATE_GOAL_TEXT_MUST_NOT_APPEAR';

    try {
      const endpoint = `http://127.0.0.1:${port}/v1/traces`;
      const sink = getSink(makeConfig({ pulse: endpoint }));
      // Span name is a task id (metadata), not a goal string
      await sink.emit([makeSpan({ name: 'task-id-metadata' })]);

      const body = captured[0]!.body;
      expect(body).not.toContain(PRIVATE_MARKER);
      expect(body).not.toContain(PAT_VALUE);
    } finally {
      await stopServer(server);
      delete process.env['ASHLR_PULSE_TOKEN'];
    }
  });

  it('handles server unavailable gracefully — never throws', async () => {
    process.env['ASHLR_PULSE_TOKEN'] = PAT_VALUE;

    // Point at a port with nothing listening
    const deadEndpoint = 'http://127.0.0.1:19999/v1/traces';

    try {
      const sink = getSink(makeConfig({ pulse: deadEndpoint }));
      const result = await sink.emit([makeSpan()]);

      // Must not throw, must return a result
      expect(result.sink).toBe('otlp');
      expect(result.ok).toBe(false);
      expect(typeof result.detail).toBe('string');
      expect(result.detail).not.toContain(PAT_VALUE);
    } finally {
      delete process.env['ASHLR_PULSE_TOKEN'];
    }
  });
});

function fixture(name: string, attributes: Record<string, string | number> = {}) {
  return { resourceSpans: [{ resource: { attributes: [{ key: 'private', value: { stringValue: 'PRIVATE_CONTENT' } }] },
    scopeSpans: [{ spans: [{ name, attributes: Object.entries(attributes).map(([key, value]) => ({
      key, value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value },
    })) }] }] }] };
}
const claude = fixture('claude_code.api_request', {
  input_tokens: 12, output_tokens: 9, cache_read_tokens: 80, cache_creation_tokens: 50,
  cache_creation_5m: '30', cache_creation_1h: '20', cost_usd: 0.12,
  prompt: 'PRIVATE_CONTENT', 'workspace.host_paths': 'PRIVATE_CONTENT',
});

let server: http.Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function listen(onSpans: (spans: ReceivedOtelSpan[]) => void | Promise<void> = () => {}) {
  server = await startOtlpReceiver({ port: 0, onSpans });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  expect(address.address).toBe('127.0.0.1');
  return `http://127.0.0.1:${address.port}/v1/traces`;
}
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('native OTLP metadata', () => {
  it('retains both cache lifetimes without double counting or retaining content', () => {
    const result = parseNativeOtelTrace(claude);
    expect(result).toEqual([{ source: 'claude-code', event: 'api_request', usage: {
      input_tokens: 12, output_tokens: 9, cache_read_tokens: 80, cache_creation_tokens: 50,
      cache_creation_5m: 30, cache_creation_1h: 20,
    }, costUsd: 0.12 }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONTENT');
  });
  it('accepts safety events without recording tool details or invented usage', () => {
    expect(parseNativeOtelTrace(fixture('claude_code.safety_event', {
      tool_parameters: 'PRIVATE_CONTENT', input_tokens: 50, cost_usd: 1,
    }))).toEqual([{ source: 'claude-code', event: 'safety_event', usage: {} }]);
  });
  it('converts xAI billed ticks to dollars with ticks taking precedence', () => {
    expect(parseNativeOtelTrace(fixture('chat', { 'gen_ai.system': 'xai',
      cost_in_usd_ticks: '37756000', cost_usd: 50,
    }))[0]?.costUsd).toBe(0.0037756);
    expect(parseNativeOtelTrace(fixture('chat', { 'gen_ai.provider.name': 'xai',
      cost_in_usd_ticks: 0,
    }))[0]?.costUsd).toBe(0);
  });
  it.each([-1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '1e3', 'bad', '9007199254740990.9'])('rejects invalid integer usage %s', value => {
    const payload = fixture('claude_code.api_request', { input_tokens: value, cost_in_usd_ticks: value });
    expect(parseNativeOtelTrace(payload)[0]?.usage).toEqual({});
  });
  it('decodes canonical OTLP intValue attributes across resources and scopes', () => {
    const span = { name: 'claude_code.api_request', attributes: [
      { key: 'cache_creation_5m', value: { intValue: '40' } },
      { key: 'cache_creation_1h', value: { intValue: '0' } },
    ] };
    const payload = { resourceSpans: [
      { scopeSpans: [{ spans: [span] }, { spans: [span] }] },
      { scopeSpans: [{ spans: [span] }] },
    ] };
    const result = parseNativeOtelTrace(payload);
    expect(result).toHaveLength(3);
    expect(result.every(item => item.usage.cache_creation_5m === 40 &&
      item.usage.cache_creation_1h === 0 && item.costUsd === undefined)).toBe(true);
  });
  it.each([-1, 0.5, '9007199254740992', 'NaN'])('keeps invalid xAI cost unknown: %s', value => {
    expect(parseNativeOtelTrace(fixture('chat', {
      'gen_ai.system': 'xai', cost_in_usd_ticks: value,
    }))[0]?.costUsd).toBeUndefined();
  });
  it('ignores unknown spans and refuses invalid envelopes', () => {
    expect(parseNativeOtelTrace(fixture('PRIVATE_CONTENT'))).toEqual([]);
    expect(() => parseNativeOtelTrace(null)).toThrow('Invalid OTLP');
    expect(parseNativeOtelTrace({ resourceSpans: [null, {}] })).toEqual([]);
  });
});

describe('loopback receiver', () => {
  it.each(['0.0.0.0', '::', '::1', 'localhost', '127.0.0.2', '192.168.1.2', ''])('refuses bind %s', async host => {
    await expect(startOtlpReceiver({ host, port: 0, onSpans: () => {} })).rejects.toThrow('127.0.0.1');
  });
  it('receives fixture spans over HTTP and acknowledges after delivery', async () => {
    const batches: ReceivedOtelSpan[][] = [];
    const url = await listen(spans => { batches.push(spans); });
    const response = await post(url, claude);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(batches).toEqual([parseNativeOtelTrace(claude)]);
  });
  it('refuses malformed, browser, compressed, oversized and unsupported requests', async () => {
    let deliveries = 0;
    const url = await listen(() => { deliveries++; });
    expect((await post(url, '{')).status).toBe(400);
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, claude, { Origin: 'https://example.com' })).status).toBe(403);
    expect((await post(url, claude, { 'Content-Type': 'application/x-protobuf' })).status).toBe(415);
    expect((await post(url, claude, { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await post(url, ' '.repeat(1_048_577))).status).toBe(413);
    expect((await fetch(url)).status).toBe(405);
    expect((await post(url + '/other', claude)).status).toBe(404);
    expect(deliveries).toBe(0);
  });
  it('reports callback failure without exposing its error', async () => {
    const url = await listen(() => { throw new Error('PRIVATE_CONTENT'); });
    const response = await post(url, claude);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{}');
  });
  it('rejects a busy port', async () => {
    await listen();
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP');
    await expect(startOtlpReceiver({ port: address.port, onSpans: () => {} })).rejects.toThrow();
  });
});
