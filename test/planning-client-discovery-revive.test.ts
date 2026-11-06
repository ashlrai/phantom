import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

const probes = vi.hoisted(() => ({ authAccesses: [] as string[], installed: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  const guarded = Object.fromEntries(Object.entries(real).map(([name, value]) => {
    if (typeof value !== 'function' || !/^(read|write|append|access|stat|lstat|realpath|open|rm|unlink|rename|copy|cp|readdir|mkdir)/.test(name)) return [name, value];
    return [name, (...args: unknown[]) => {
      for (const arg of args.slice(0, 2)) {
        if (typeof arg === 'string' && /[\\/]\.codex[^\\/]*[\\/]auth[^\\/]*/.test(arg)) {
          probes.authAccesses.push(name);
          throw new Error('Forbidden Codex auth filesystem access');
        }
      }
      return Reflect.apply(value, real, args);
    }];
  }));
  return { ...real, ...guarded };
});
vi.mock('../src/core/run/engines.js', async original => ({
  ...await original<typeof import('../src/core/run/engines.js')>(),
  engineInstalled: probes.installed,
  spawnEngine: probes.spawn,
}));
vi.mock('../src/core/decide/resource-choice.js', () => ({ adviseResourceChoice: async () => null }));

import { listFrontierClients, resolvePlanningClient } from '../src/core/generative/invent.js';
import { resolveFrontierJudgeClient } from '../src/core/fleet/manager.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const config = (): AshlrConfig => ({
  models: { ollama: 'http://127.0.0.1:9' },
  foundry: { judgeAllowedBackends: ['codex', 'local'] },
} as unknown as AshlrConfig);

describe('real guarded resolver discovery without auth filesystem access', () => {
  it.each(['.codex', '.codex-2'])('resolves Codex with Claude absent without inspecting %s credentials', async profile => {
    vi.stubEnv('CODEX_HOME', join(homedir(), profile));
    probes.installed.mockImplementation(engine => engine === 'codex');
    const cfg = config();
    // The unchanged auto resolver falls back locally. Planning must explicitly
    // try Codex, using the real guarded resolver rather than a fake adapter.
    expect(resolveFrontierJudgeClient(cfg)?.model).not.toMatch(/^gpt-/);
    expect((await resolvePlanningClient(cfg))?.model).toMatch(/^gpt-/);
    expect(probes.authAccesses).toEqual([]);
    expect(probes.spawn).not.toHaveBeenCalled();
  });

  it('preserves the real resolver confinement refusal without opening personal auth', async () => {
    probes.installed.mockImplementation(engine => engine === 'codex');
    const cfg = config();
    cfg.foundry!.confinement = { codex: { mode: 'os', autonomous: true } };
    expect((await listFrontierClients(cfg)).find(client => client.engine === 'codex')?.available).toBe(false);
    expect((await resolvePlanningClient(cfg))?.model).not.toMatch(/^gpt-/);
    expect(probes.authAccesses).toEqual([]);
    expect(probes.spawn).not.toHaveBeenCalled();
  });

  it('uses the existing OpenAI-compatible local transport for loopback oMLX', async () => {
    const cfg = config();
    cfg.models.ollama = 'http://127.0.0.1:8000';
    Object.assign(cfg.foundry!, { managerJudgeEngine: 'local', managerJudgeModel: 'qwen3' });
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'local plan' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    const client = await resolvePlanningClient(cfg);
    expect(await client?.complete('system', 'objective')).toBe('local plan');
    expect(request).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8000/v1/chat/completions',
      expect.objectContaining({ method: 'POST', body: expect.any(String) }));
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({
      model: 'qwen3', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'objective' }],
    });
    expect(probes.authAccesses).toEqual([]);
    expect(probes.spawn).not.toHaveBeenCalled();
  });
});
