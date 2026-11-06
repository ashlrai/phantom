import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  getProviderRegistry,
  probeApiModelEngine,
  probeEndpoint,
  resolveActiveProvider,
} from '../src/core/providers.js';

// Runtime ownership and operator environment must not affect these unit probes.
vi.mock('../src/core/local-runtime/llama/config.js', () => ({
  resolveLlamaServerOrigin: () => 'http://127.0.0.1:18080',
}));

function config(chain: string[] = ['lmstudio', 'ollama']): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://127.0.0.1:11234',
      ollama: 'http://127.0.0.1:11434',
      providerChain: chain,
    },
    telemetry: {},
    tools: {},
  };
}

function response(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('provider endpoint protocol descriptors', () => {
  it.each([
    ['lmstudio', 'http://localhost:1234', 'http://localhost:1234/v1/models'],
    ['lmstudio', 'http://localhost:1234/v1/', 'http://localhost:1234/v1/models'],
    ['lmstudio', 'http://localhost:1234/v1/models/', 'http://localhost:1234/v1/models'],
    ['ollama', 'http://localhost:11434/', 'http://localhost:11434/api/tags'],
    ['ollama', 'http://localhost:11434/api/tags/', 'http://localhost:11434/api/tags'],
    ['llama-server', 'http://localhost:8080', 'http://localhost:8080/v1/models'],
    ['llama-server', 'http://localhost:8080/v1', 'http://localhost:8080/v1/models'],
    ['llama-server', 'http://localhost:8080/v1/models', 'http://localhost:8080/v1/models'],
    ['custom', 'http://localhost:4321/health', 'http://localhost:4321/health'],
    ['constructor', 'http://localhost:4321/health', 'http://localhost:4321/health'],
  ])('canonicalizes %s at %s', async (id, base, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [], models: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeEndpoint(id, base);

    expect(result).toMatchObject({ id, url: expected, up: true, models: [] });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(expected, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ['lmstudio', { data: [null, undefined, 42, 'model', false, [], {}, { id: 1 }, { id: 'valid-openai' }] }, ['valid-openai']],
    ['llama-server', { data: [null, { id: 'valid-llama' }] }, ['valid-llama']],
    ['ollama', { models: [null, undefined, 42, 'model', false, [], {}, { name: 1 }, { name: 'valid-ollama' }] }, ['valid-ollama']],
    ['custom', { models: [null, { name: 'valid-fallback' }] }, ['valid-fallback']],
  ])('retains valid %s models among malformed rows', async (id, body, models) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    expect(await probeEndpoint(id, 'http://localhost:1234')).toMatchObject({ up: true, models });
  });

  it.each([null, undefined, 7, 'invalid', [], {}, { data: null }, { models: {} }])(
    'accepts an unrecognized JSON shape without throwing: %j',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      expect(await probeEndpoint('custom', 'http://localhost:1234/health')).toMatchObject({ up: true, models: [] });
    },
  );

  it('tries the OpenAI model shape before the Ollama fallback for custom endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      data: [{ id: 'openai-model' }],
      models: [{ name: 'ollama-model' }],
    })));
    expect((await probeEndpoint('custom', 'http://localhost:1234/health')).models).toEqual(['openai-model']);
  });
});

describe('provider registry compatibility', () => {
  it('keeps chain order, deduplicates endpoints and appends the supervised runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [], models: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const chain = ['ollama', 'lmstudio', 'ollama'];
    const result = await getProviderRegistry(config(chain));

    expect(result.providers.map((provider) => provider.id)).toEqual(['ollama', 'lmstudio', 'llama-server']);
    expect(result.activeProvider).toBe('ollama');
    expect(result.chain).toEqual(chain);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18080/v1/models', expect.any(Object));
  });

  it('ignores inherited object property names in both local and cloud lookups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await getProviderRegistry(config(['constructor', 'toString', '__proto__']));

    expect(result.providers.map((provider) => provider.id)).toEqual(['lmstudio', 'ollama', 'llama-server']);
    expect(result.activeProvider).toBeNull();
  });

  it('uses a configured cloud provider before local fallback only when its key is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ data: [], models: [] })));
    vi.stubEnv('ANTHROPIC_API_KEY', '   ');
    expect((await getProviderRegistry(config(['anthropic']))).activeProvider).toBe('lmstudio');

    // FAKE: generated at runtime; never an actual credential or a source literal.
    vi.stubEnv('ANTHROPIC_API_KEY', ['FAKE', randomUUID()].join('_'));
    const result = await getProviderRegistry(config(['anthropic']));
    expect(result.activeProvider).toBe('anthropic');
    expect(result.providers.map((provider) => provider.id)).toEqual(['lmstudio', 'ollama', 'llama-server']);
  });

  it('still selects a healthy supervised runtime when the chain omits all local providers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url === 'http://127.0.0.1:18080/v1/models') return response({ data: [{ id: 'runtime-model' }] });
      throw new Error('offline');
    }));
    expect(await resolveActiveProvider(config(['unknown']))).toBe('llama-server');
  });

  it('skips absent optional URLs while continuing to probe the supervised runtime', async () => {
    const cfg = config([]);
    cfg.models.lmstudio = '';
    cfg.models.ollama = '';
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getProviderRegistry(cfg);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:18080/v1/models', expect.any(Object));
    expect(result.providers.slice(0, 2)).toEqual([
      { id: 'lmstudio', url: '', up: false, models: [], error: 'not configured' },
      { id: 'ollama', url: '', up: false, models: [], error: 'not configured' },
    ]);
    expect(result.activeProvider).toBeNull();
  });
});

describe('bounded provider probes', () => {
  it('keeps the abort timeout armed until a stalled response body settles', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let readingBody = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return {
        ok: true,
        json: () => {
          readingBody = true;
          return new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
          });
        },
      } as Response;
    }));

    const pending = probeEndpoint('ollama', 'http://localhost:11434');
    await vi.advanceTimersByTimeAsync(1999);
    expect(readingBody).toBe(true);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ up: false, models: [], error: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'http-error', 'network-error', 'invalid-json'])('cleans its timer after %s', async (outcome) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    if (outcome === 'network-error') fetchMock.mockRejectedValue(new Error('offline'));
    else if (outcome === 'http-error') fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });
    else if (outcome === 'invalid-json') fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } });
    else fetchMock.mockResolvedValue(response({ data: [{ id: 'model' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeEndpoint('lmstudio', 'http://localhost:1234');

    expect(result.up).toBe(outcome === 'success');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('API engine readiness compatibility', () => {
  it('skips network access without a key and retains valid model rows with a FAKE key', async () => {
    const envKey = 'PHANTOM_PROVIDERS_READINESS_FAKE_KEY';
    vi.stubEnv(envKey, '');
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [null, 5, { id: 'api-model' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = { envKey, defaultBaseUrl: 'http://localhost:4321/v1' };

    expect(await probeApiModelEngine('test-api', api)).toEqual({
      engineId: 'test-api', keyPresent: false, reachable: false, models: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // FAKE: this synthetic credential exists only inside the test process.
    vi.stubEnv(envKey, ['FAKE', randomUUID()].join('_'));
    expect(await probeApiModelEngine('test-api', api)).toEqual({
      engineId: 'test-api', keyPresent: true, reachable: true, models: ['api-model'],
    });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4321/v1/models', expect.any(Object));
  });
});
