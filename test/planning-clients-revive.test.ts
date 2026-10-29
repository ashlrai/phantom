import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { __resetLocalOnlyLatchForTests } from '../src/core/policy/local-only.js';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), advise: vi.fn(), complete: vi.fn(), availability: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
vi.mock('../src/core/fleet/manager.js', () => ({ resolveFrontierJudgeClient: mocks.resolve }));
vi.mock('../src/core/decide/resource-choice.js', () => ({ adviseResourceChoice: mocks.advise }));
vi.mock('../src/core/fabric/resource-monitor.js', () => ({ peekBackendAvailability: mocks.availability }));
import { listFrontierClients, resolvePlanningClient, inventWorkItems } from '../src/core/generative/invent.js';

const cfg = (engine = 'auto', endpoint = 'http://127.0.0.1:8000'): AshlrConfig => ({
  foundry: { managerJudgeEngine: engine }, models: { ollama: endpoint },
} as unknown as AshlrConfig);
const local = () => ({ model: 'local:qwen3', complete: mocks.complete });
const codex = () => ({ model: 'gpt-6.1-sol', complete: mocks.complete });

beforeEach(() => {
  __resetLocalOnlyLatchForTests();
  mocks.resolve.mockReset().mockImplementation((config: AshlrConfig) => {
    const engine = (config.foundry as Record<string, unknown>)?.['managerJudgeEngine'];
    return engine === 'codex' ? codex() : local();
  });
  mocks.advise.mockReset().mockResolvedValue(null);
  mocks.complete.mockReset().mockResolvedValue('[]');
  mocks.availability.mockReset().mockReturnValue(null);
});

describe('guarded planning adapters', () => {
  it('tries explicit Codex when auto falls back after missing Claude', async () => {
    expect((await resolvePlanningClient(cfg()))?.model).toBe('gpt-6.1-sol');
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      foundry: expect.objectContaining({ managerJudgeEngine: 'codex' }),
    }));
    expect((await listFrontierClients(cfg())).find(client => client.engine === 'claude')?.available).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('preserves Codex confinement refusal and never calls a rejected adapter', async () => {
    mocks.resolve.mockImplementation((config: AshlrConfig) =>
      (config.foundry as Record<string, unknown>)?.['managerJudgeEngine'] === 'codex' ? null : local());
    expect((await resolvePlanningClient(cfg()))?.model).toBe('local:qwen3');
    expect((await listFrontierClients(cfg())).find(client => client.engine === 'codex')).toMatchObject({
      available: false, reason: 'unavailable-or-not-admitted',
    });
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it('resolves the Grok CLI seat without substituting the Grok API', async () => {
    mocks.resolve.mockImplementation((config: AshlrConfig) =>
      (config.foundry as Record<string, unknown>)?.['managerJudgeEngine'] === 'grok-cli'
        ? { model: 'grok-cli:grok-4.7', complete: mocks.complete } : null);
    expect((await resolvePlanningClient(cfg()))?.model).toBe('grok-cli:grok-4.7');
  });

  it('preserves an explicit selected engine and never tries another CLI', async () => {
    expect((await resolvePlanningClient(cfg('codex')))?.model).toBe('gpt-6.1-sol');
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it('preserves explicit empty judge restrictions through every attempted candidate', async () => {
    mocks.resolve.mockImplementation((config: AshlrConfig) =>
      (config.foundry as Record<string, unknown>)?.['judgeAllowedBackends'] instanceof Array ? null : codex());
    const config = cfg();
    Object.assign(config.foundry!, { judgeAllowedBackends: [] });
    expect(await resolvePlanningClient(config)).toBeNull();
    for (const [candidate] of mocks.resolve.mock.calls) {
      expect(candidate.foundry.judgeAllowedBackends).toEqual([]);
    }
  });

  it('keeps loopback oMLX/local identity local', async () => {
    mocks.resolve.mockReturnValue(local());
    const result = await resolvePlanningClient(cfg('local'));
    expect(result?.model).toBe('local:qwen3');
    expect((await listFrontierClients(cfg('local'))).filter(client => client.available)).toEqual([
      { id: 'local', engine: 'local', model: 'local:qwen3', available: true, reason: 'adapter-resolved' },
    ]);
  });

  it('offers local alongside an available Claude adapter', async () => {
    mocks.resolve.mockImplementation((config: AshlrConfig) =>
      (config.foundry as Record<string, unknown>)?.['managerJudgeEngine'] === 'claude'
        ? { model: 'claude-sonnet-5', complete: mocks.complete } : local());
    mocks.advise.mockResolvedValue('local');
    expect((await resolvePlanningClient(cfg()))?.model).toBe('local:qwen3');
    expect(mocks.advise.mock.calls[0]?.[0].map((candidate: { id: string }) => candidate.id))
      .toEqual(['claude', 'local']);
  });

  it('does not offer a resource-exhausted Codex adapter to JEV', async () => {
    mocks.availability.mockImplementation(engine => engine === 'codex' ? 'exhausted' : null);
    expect((await resolvePlanningClient(cfg()))?.model).toBe('local:qwen3');
    expect((await listFrontierClients(cfg())).find(client => client.engine === 'codex')?.reason).toBe('resource-unavailable');
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it('excludes vendor CLIs under the existing local-only policy', async () => {
    const config = cfg();
    Object.assign(config.foundry!, { localOnly: true });
    expect((await resolvePlanningClient(config))?.model).toBe('local:qwen3');
    const inventory = await listFrontierClients(config);
    expect(inventory.filter(client => client.engine !== 'local').every(client =>
      !client.available && client.reason === 'policy-refused')).toBe(true);
    expect(mocks.advise).not.toHaveBeenCalled();
  });

  it('refuses a remote local fallback without authorizing network access', async () => {
    mocks.resolve.mockReturnValue(local());
    expect(await resolvePlanningClient(cfg('local', 'https://inference.example'))).toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('lets JEV select only one of the resolved adapters', async () => {
    mocks.advise.mockResolvedValue('local');
    expect((await resolvePlanningClient(cfg()))?.model).toBe('local:qwen3');
    expect(mocks.advise).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'codex', headroomPercent: null }),
      expect.objectContaining({ id: 'local', headroomPercent: null }),
    ], expect.objectContaining({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it('rejects JEV advice naming an unavailable client', async () => {
    mocks.advise.mockResolvedValue('claude');
    expect((await resolvePlanningClient(cfg()))?.model).toBe('gpt-6.1-sol');
  });

  it('discovery never reads or mutates either Codex home auth paths', async () => {
    const probes = [
      vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'accessSync'),
      vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs, 'rmSync'),
    ];
    try {
      await listFrontierClients(cfg());
      await resolvePlanningClient(cfg('codex'));
      for (const probe of probes) {
        expect(probe.mock.calls.map(args => String(args[0])).filter(path =>
          /[\\/]\.codex[^\\/]*[\\/]auth[^\\/]*/.test(path))).toEqual([]);
      }
    } finally {
      for (const probe of probes) probe.mockRestore();
    }
  });

  it('invent uses the selected guarded adapter for completion', async () => {
    const result = await inventWorkItems({ repo: '/tmp/project', repoState: 'ready', direction: 'improve' }, { cfg: cfg('codex') });
    expect(result).toEqual([]);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
});
