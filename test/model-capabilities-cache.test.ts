import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { claudeModelOptions, legacyModelOptionFallback, MODEL_CAPABILITIES_TTL_MS, parseModelCapabilitiesResponse,
  readModelCapabilities, resetModelWindowCaches } from '../src/core/verse/model-windows.js';
import { KNOWN_MODELS, pickModel } from '../src/core/run/model-catalog.js';
import { probeThroughPhantom, probeWorker, refreshModelCapabilities } from '../scripts/probe-model-capabilities.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/model-capabilities/models.json', import.meta.url), 'utf8'));
// In-memory filesystem keeps this fixture suite in the hermetic unit lane.
const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execute }));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, openSync: vi.fn((path: string) => {
    if (!files.has(path)) throw new Error('absent');
    return path;
  }), closeSync: vi.fn(), fstatSync: vi.fn((path: string) => ({ isFile: () => true, size: Buffer.byteLength(files.get(path)!), mtimeMs: 1 })),
  readSync: vi.fn((path: string, buffer: Buffer, offset: number, length: number, position: number) =>
    Buffer.from(files.get(path)!).copy(buffer, offset, position, position + length)) };
});
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), rm: vi.fn(async (path: string) => { files.delete(path); }),
  writeFile: vi.fn(async (path: string, data: string) => { files.set(path, data); }),
  rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
}));
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => '/fixture-home' }));
const path = '/fixture-home/.ashlr/cache/model-capabilities.json';
afterEach(() => { files.clear(); resetModelWindowCaches(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('model capability cache', () => {
  it('retains explicit false, between_tools, server_tools and line without arbitrary response fields', () => {
    const [row] = parseModelCapabilitiesResponse(fixture)!;
    expect(row).toMatchObject({ line: 'opus', thinking: { enabled: false, between_tools: true }, serverTools: { code_execution: false } });
    expect(JSON.stringify(row)).not.toContain('must-not-be-cached');
  });
  it('rejects malformed, duplicate and empty responses; missing flags stay unknown', () => {
    for (const value of [null, {}, { data: [] }, { data: [fixture.data[0], fixture.data[0]] }, { data: [{ id: '../bad' }] }]) {
      expect(parseModelCapabilitiesResponse(value)).toBeNull();
    }
    expect(parseModelCapabilitiesResponse({ data: [{ id: 'claude-test' }] })?.[0]?.thinking).toEqual({});
  });
  it('refreshes atomically, throttles fresh probes and expires cached metadata', async () => {
    const probe = vi.fn(async () => fixture);
    expect(await refreshModelCapabilities({ path, now: 1000, probe })).toBe('updated');
    expect(await refreshModelCapabilities({ path, now: 1001, probe })).toBe('fresh');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readModelCapabilities(path, 999)).toBeNull();
    expect(readModelCapabilities(path, 1000 + MODEL_CAPABILITIES_TTL_MS)).toBeNull();
    expect(readModelCapabilities(path, 1001)?.models[0]?.thinking.between_tools).toBe(true);
    expect([...files.keys()]).toEqual([path]);
    expect(files.get(path)).not.toContain('ignored_private_field');
  });
  it('preserves the previous file when probe or validation fails', async () => {
    files.set(path, 'previous');
    await expect(refreshModelCapabilities({ path, probe: async () => { throw new Error('offline'); } })).rejects.toThrow();
    await expect(refreshModelCapabilities({ path, probe: async () => ({ data: [] }) })).rejects.toThrow();
    expect(files.get(path)).toBe('previous');
  });
  it('routes from cached explicit capabilities and passes metadata to adapter options', async () => {
    const now = Date.now();
    const response = structuredClone(fixture);
    response.data[0].capabilities.thinking.supported = false;
    await refreshModelCapabilities({ path, now, probe: async () => response });
    const option = claudeModelOptions(null).find(row => row.id === 'claude-opus-5-5')!;
    expect(option.providerCapabilities?.thinking.supported).toBe(false);
    expect(option.contextWindow).toBe(1_000_000);
    const snapshot = { id: option.id, label: option.label, contextWindow: 200_000, autoCompactAt: 167_000 };
    expect(legacyModelOptionFallback('claude', option.id, snapshot)?.providerCapabilities?.thinking.supported).toBe(false);
    expect(legacyModelOptionFallback('claude', option.id, snapshot)?.contextWindow).toBe(200_000);
    const excluded = new Set(KNOWN_MODELS.filter(row => row.id !== 'claude:claude-opus-5-5').map(row => row.id));
    const entry = pickModel({ engine: 'claude', excludeIds: excluded });
    expect(entry?.providerCapabilities?.id).toBe('claude-opus-5-5');
    expect(entry?.capabilities).not.toContain('reasoning');
    const reasoning = pickModel({ engine: 'claude', excludeIds: new Set(), capability: 'reasoning' });
    expect(reasoning?.id).not.toBe('claude:claude-opus-5-5');
  });
  it('falls back to static options for unreadable, corrupt or expired caches', () => {
    const original = claudeModelOptions(null);
    files.set(path, '{}');
    expect(claudeModelOptions(null)).toEqual(original);
    resetModelWindowCaches();
    files.set(path, JSON.stringify({ schema: 1, provider: 'anthropic', fetchedAt: 0, models: parseModelCapabilitiesResponse(fixture) }));
    expect(claudeModelOptions(null)).toEqual(original);
  });
});


describe('proxy-only probe worker', () => {
  it('always invokes the worker through Phantom and suppresses child diagnostics', async () => {
    execute.mockImplementation((_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, JSON.stringify(fixture)));
    expect(await probeThroughPhantom()).toEqual(fixture);
    expect(execute.mock.calls[0][0]).toBe('phantom');
    expect(execute.mock.calls[0][1].slice(0, 2)).toEqual(['exec', '--']);
    expect(execute.mock.calls[0][1].at(-1)).toBe('--worker');
    execute.mockImplementation((_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error('private child diagnostic'), 'private body'));
    await expect(probeThroughPhantom()).rejects.toThrow('Model capability probe failed');
  });
  function setup() {
    vi.stubEnv('ANTHROPIC_API_KEY', 'phm_fixture');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:12345/anthropic');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    return { output, request };
  }
  it('paginates fixture responses and emits only public metadata', async () => {
    const { output, request } = setup();
    request.mockResolvedValueOnce(Response.json({ ...fixture, has_more: true })).mockResolvedValueOnce(Response.json({
      data: [{ ...fixture.data[0], id: 'claude-sonnet-test', line: 'sonnet' }], has_more: false,
    }));
    await probeWorker();
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toContain('after_id=claude-opus-5-5');
    expect(String(request.mock.calls[0][0])).toContain('/anthropic/v1/models');
    const serialized = String(output.mock.calls[0][0]);
    expect(parseModelCapabilitiesResponse(JSON.parse(serialized))).toHaveLength(2);
    expect(serialized).not.toContain('must-not-be-cached');
  });
  it('refuses raw credentials, untrusted destinations and redirects before emitting data', async () => {
    const { output, request } = setup();
    vi.stubEnv('ANTHROPIC_API_KEY', 'non-placeholder-fixture');
    await expect(probeWorker()).rejects.toThrow();
    vi.stubEnv('ANTHROPIC_API_KEY', 'phm_fixture');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://untrusted.invalid');
    await expect(probeWorker()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:12345');
    request.mockResolvedValue(new Response('', { status: 302 }));
    await expect(probeWorker()).rejects.toThrow();
    expect(request.mock.calls[0][1].redirect).toBe('error');
    expect(output).not.toHaveBeenCalled();
  });
  it('rejects cursor cycles and HTTP errors without emitting partial results', async () => {
    const { output, request } = setup();
    request.mockResolvedValue(Response.json({ ...fixture, has_more: true }));
    await expect(probeWorker()).rejects.toThrow();
    expect(output).not.toHaveBeenCalled();
    request.mockResolvedValue(new Response('private diagnostic', { status: 401 }));
    await expect(probeWorker()).rejects.toThrow();
    expect(output).not.toHaveBeenCalled();
  });
});
