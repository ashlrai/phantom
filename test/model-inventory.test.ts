import { describe, it, expect, vi } from 'vitest';
import { inventoryEndpoint, loopbackListenerNames, measureModelInventory, modelTiers, type ModelInventoryRow } from '../src/core/resources/model-inventory.js';

function fixture(options: { failGenerate?: boolean; failUnload?: boolean; cached?: boolean; resident?: boolean; calibration?: boolean; omlx?: boolean; both?: boolean } = {}) {
  const calls: { engine: string; path: string; body: Record<string, unknown> }[] = [];
  let loaded = options.resident ?? false;
  let samples = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const engine = url.port === '11434' ? 'ollama' : 'omlx';
    const path = url.pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ engine, path, body });
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    const response = (value: unknown): Response => new Response(JSON.stringify(value));
    if (path === '/api/tags') return response({ models: options.omlx && !options.both ? [] : [{ name: 'example:8b', size: 1000 }] });
    if (path === '/admin/api/models') return response({ models: options.omlx || options.both ? [{ id: 'example-8bit', estimated_size: 1000,
      model_type: 'llm', model_context_length: 65536, loaded, actual_size: loaded ? 2048 : 0 }] : [] });
    if (path === '/api/show') return response({ capabilities: ['completion'], details: { quantization_level: 'Q8_0' }, model_info: { 'example.context_length': 65536 } });
    if (path === '/api/ps') return response({ models: loaded ? [{ name: 'example:8b', size: 2048 }] : [] });
    if (path.endsWith('/unload') || path === '/api/generate' && body.keep_alive === 0) {
      if (options.failUnload) return new Response('', { status: 500 });
      loaded = false; return response({ done: true });
    }
    if (path === '/v1/tokenize') { loaded = true; return response({ count: 512 }); }
    if (path === '/v1/completions') {
      loaded = true;
      return response({ usage: { prompt_tokens: 512, prompt_tokens_per_second: 256, generation_tokens_per_second: 32,
        prompt_tokens_details: { cached_tokens: options.cached ? 512 : 0 } } });
    }
    if (path === '/api/generate') {
      loaded = true;
      if (options.failGenerate) throw new Error('TEST engine failure');
      samples++;
      return response({ done: true, prompt_eval_count: options.calibration && samples === 1 ? 513 : 512,
        prompt_eval_duration: [2e9, 1e9, 4e9][(samples - 1) % 3], eval_count: 64,
        eval_duration: [2e9, 1e9, 4e9][(samples - 1) % 3] });
    }
    throw new Error('Unexpected fake request');
  }) as typeof fetch;
  return { calls, deps: { fetch: fetcher, admit: vi.fn(async () => true), verifyListener: vi.fn(async () => true) } };
}
const measured: ModelInventoryRow = { id: 'example', engine: 'ollama', contextLength: 65536, quantization: 'Q8_0',
  residentBytes: 2048, prefillTokensPerSecond: 256, decodeTokensPerSecond: 64, servableTiers: [], status: 'measured' };

describe('model inventory', () => {
  it('requires every actual listener to bind numeric loopback', () => {
    expect(loopbackListenerNames('p123\nf3\nn127.0.0.1:11434\nn[::1]:11434\n')).toBe(true);
    for (const value of ['', 'p123\n', 'n*:11434', 'n[::]:11434', 'n192.168.1.1:11434',
      'n127.0.0.1:11434\nn*:11434']) expect(loopbackListenerNames(value)).toBe(false);
  });
  it.each(['http://127.0.0.1:11434', 'http://[::1]:8000/'])('accepts numeric loopback %s', value => {
    expect(inventoryEndpoint(value)).toBe(new URL(value).origin);
  });
  it.each(['http://localhost:8000', 'http://0.0.0.0:8000', 'http://192.168.1.1', 'https://127.0.0.1',
    'http://127.1', 'http://2130706433', 'http://[::]', 'http://127.0.0.1/path', 'http://127.0.0.1?key=TEST',
    'http://user:TEST@127.0.0.1'])('refuses unsafe origin %s', value => {
    expect(() => inventoryEndpoint(value)).toThrow();
  });
  it('maps independent tiers using context, speed and quantization thresholds', () => {
    expect(modelTiers(measured)).toEqual(['fast', 'work', 'frontier']);
    expect(modelTiers({ ...measured, quantization: 'Q4_K_M' })).toEqual(['fast', 'work']);
    expect(modelTiers({ ...measured, quantization: 'MXFP4' })).toEqual(['fast', 'work']);
    expect(modelTiers({ ...measured, quantization: 'unknown' })).toEqual([]);
    expect(modelTiers({ ...measured, contextLength: 8192 })).toEqual(['fast']);
    expect(modelTiers({ ...measured, decodeTokensPerSecond: 8 })).toEqual(['frontier']);
    expect(modelTiers({ ...measured, prefillTokensPerSecond: 24 })).toEqual([]);
    expect(modelTiers({ ...measured, status: 'refused' })).toEqual([]);
  });
  it('is default off and validates both origins before contact', async () => {
    const { deps } = fixture();
    await expect(measureModelInventory({}, deps)).rejects.toThrow('disabled');
    await expect(measureModelInventory({ enabled: true, omlx: 'http://0.0.0.0' }, deps)).rejects.toThrow('loopback');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('takes medians of three cold samples, measuring resident rather than disk bytes', async () => {
    const { calls, deps } = fixture();
    const result = await measureModelInventory({ enabled: true }, deps);
    expect(result.models[0]).toMatchObject({ status: 'measured', residentBytes: 2048,
      prefillTokensPerSecond: 256, decodeTokensPerSecond: 32, servableTiers: ['work', 'frontier'] });
    expect(deps.admit).toHaveBeenCalledTimes(3);
    expect(calls.filter(call => call.path === '/api/generate').map(call => call.body.keep_alive))
      .toEqual(['5m', 0, '5m', 0, '5m', 0]);
    expect(calls.filter(call => call.body.raw).every(call => call.body.prompt === ' hello'.repeat(512))).toBe(true);
  });
  it('calibrates tokenizer overhead then measures the same exact 512-token prompt three times', async () => {
    const { calls, deps } = fixture({ calibration: true });
    const result = await measureModelInventory({ enabled: true }, deps);
    expect(result.models[0]?.status).toBe('measured');
    const prompts = calls.filter(call => call.body.raw).map(call => call.body.prompt);
    expect(prompts).toEqual([' hello'.repeat(512), ...Array(3).fill(' hello'.repeat(511))]);
    expect(calls.filter(call => call.body.keep_alive === 0)).toHaveLength(4);
  });
  it('unloads after inference failure', async () => {
    const { calls, deps } = fixture({ failGenerate: true });
    expect((await measureModelInventory({ enabled: true }, deps)).models[0]?.status).toBe('unavailable');
    expect(calls.some(call => call.body.keep_alive === 0)).toBe(true);
  });
  it('stops immediately when unload cannot be confirmed', async () => {
    const { calls, deps } = fixture({ failUnload: true });
    await expect(measureModelInventory({ enabled: true }, deps)).rejects.toThrow('unload');
    expect(calls.filter(call => call.body.raw)).toHaveLength(1);
  });
  it('refuses admission without sending any load or unload request', async () => {
    const { calls, deps } = fixture(); deps.admit.mockResolvedValue(false);
    expect((await measureModelInventory({ enabled: true }, deps)).models[0]?.status).toBe('refused');
    expect(calls.some(call => call.path === '/api/generate')).toBe(false);
  });
  it('refuses to evict existing work', async () => {
    const { calls, deps } = fixture({ resident: true });
    await expect(measureModelInventory({ enabled: true }, deps)).rejects.toThrow('resident');
    expect(calls.some(call => call.path === '/api/generate')).toBe(false);
  });
  it('refuses wildcard listeners before fetching', async () => {
    const { deps } = fixture(); deps.verifyListener.mockResolvedValue(false);
    expect((await measureModelInventory({ enabled: true }, deps)).unavailableEngines).toEqual(['ollama', 'omlx']);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it('does not follow redirects or expose API failure text', async () => {
    const { deps } = fixture();
    deps.fetch = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('error'); return new Response('', { status: 302, headers: { Location: 'http://192.168.1.1' } });
    }) as typeof fetch;
    expect((await measureModelInventory({ enabled: true }, deps)).unavailableEngines).toHaveLength(2);
    expect(deps.admit).not.toHaveBeenCalled();
  });
  it('measures oMLX using its own timing, memory and unload APIs', async () => {
    const { calls, deps } = fixture({ omlx: true });
    expect((await measureModelInventory({ enabled: true }, deps)).models[0]).toMatchObject({ engine: 'omlx', status: 'measured',
      quantization: '8bit', residentBytes: 2048, prefillTokensPerSecond: 256, decodeTokensPerSecond: 32 });
    expect(calls.filter(call => call.path.endsWith('/unload'))).toHaveLength(3);
  });
  it('finishes every Ollama unload before starting any oMLX sample', async () => {
    const { calls, deps } = fixture({ both: true });
    const result = await measureModelInventory({ enabled: true }, deps);
    expect(result.models.map(row => row.status)).toEqual(['measured', 'measured']);
    const operations = calls.filter(call => call.path === '/api/generate' || call.path === '/v1/completions' || call.path.endsWith('/unload'));
    expect(operations.map(call => call.path === '/api/generate' ? call.body.keep_alive === 0 ? 'unload ollama' : 'load ollama'
      : call.path.endsWith('/unload') ? 'unload omlx' : 'load omlx')).toEqual([
      ...Array.from({ length: 3 }, () => ['load ollama', 'unload ollama']).flat(),
      ...Array.from({ length: 3 }, () => ['load omlx', 'unload omlx']).flat(),
    ]);
  });
  it('refuses overlapping in-process inventories', async () => {
    const { deps } = fixture();
    let release!: () => void; let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.admit.mockImplementation(async () => { entered(); await gate; return true; });
    const first = measureModelInventory({ enabled: true }, deps);
    await admitted;
    try { await expect(measureModelInventory({ enabled: true }, deps)).rejects.toThrow('already running'); }
    finally { release(); }
    expect((await first).models[0]?.status).toBe('measured');
  });
  it('rejects oMLX cache hits and still unloads', async () => {
    const { calls, deps } = fixture({ omlx: true, cached: true });
    expect((await measureModelInventory({ enabled: true }, deps)).models[0]?.status).toBe('unsupported');
    expect(calls.filter(call => call.path.endsWith('/unload'))).toHaveLength(1);
  });
});
