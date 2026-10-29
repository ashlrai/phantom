import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig, EngineId } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  installed: vi.fn<(engine: EngineId, cfg?: AshlrConfig) => boolean>(),
  run: vi.fn(),
}));

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
vi.mock('../src/core/run/engines.js', () => ({ engineInstalled: mocks.installed }));
vi.mock('../src/core/run/orchestrator.js', () => ({ runGoal: mocks.run }));
vi.mock('../src/core/run/provider-client.js', () => ({ getActiveClient: vi.fn() }));
vi.mock('../src/core/spec/spec-store.js', () => ({ authorSpec: vi.fn() }));

import { decomposeGoal, pickFrontierEngine } from '../src/core/goals/planner.js';

const config = (allowedBackends: EngineId[]): AshlrConfig => ({ foundry: { allowedBackends } } as AshlrConfig);

beforeEach(() => {
  mocks.installed.mockReset().mockReturnValue(false);
  mocks.run.mockReset().mockResolvedValue({ result: JSON.stringify([
    { title: 'Implement routing', detail: 'Use the admitted client.' },
    { title: 'Verify routing', detail: 'Exercise the selected engine.' },
  ]) });
});

describe('frontier planning selection', () => {
  it('picks Codex when Claude is absent and forwards the exact selected engine', async () => {
    mocks.installed.mockImplementation(engine => engine === 'codex');
    const cfg = config(['claude', 'codex']);
    expect(pickFrontierEngine(cfg)).toBe('codex');
    const milestones = await decomposeGoal('Restore frontier planning', cfg);
    expect(milestones.map(item => item.title)).toEqual(['Implement routing', 'Verify routing']);
    expect(mocks.run).toHaveBeenCalledWith(expect.any(String), cfg, expect.objectContaining({
      engine: 'codex', allowCloud: false, noMemory: true, tools: false,
    }));
  });

  it('preserves Claude preference only when it is available', () => {
    mocks.installed.mockReturnValue(true);
    expect(pickFrontierEngine(config(['claude', 'codex', 'grok-cli']))).toBe('claude');
  });

  it('uses an allowed installed Grok CLI after unavailable Claude and Codex', async () => {
    mocks.installed.mockImplementation(engine => engine === 'grok-cli');
    const cfg = config(['claude', 'codex', 'grok-cli']);
    expect(pickFrontierEngine(cfg)).toBe('grok-cli');
    await decomposeGoal('Restore frontier planning', cfg);
    expect(mocks.run).toHaveBeenCalledWith(expect.any(String), cfg, expect.objectContaining({ engine: 'grok-cli' }));
  });

  it('passes configuration to discovery so custom executable settings are honored', () => {
    const cfg = config(['codex']);
    mocks.installed.mockImplementation((engine, actualCfg) => engine === 'codex' && actualCfg === cfg);
    expect(pickFrontierEngine(cfg)).toBe('codex');
    expect(mocks.installed).toHaveBeenCalledExactlyOnceWith('codex', cfg);
  });

  it('does not discover or run excluded clients', async () => {
    mocks.installed.mockReturnValue(true);
    const cfg = config(['builtin']);
    expect(pickFrontierEngine(cfg)).toBeNull();
    await decomposeGoal('Restore frontier planning', cfg);
    expect(mocks.installed).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('falls back to deterministic planning when the selected client refuses', async () => {
    mocks.installed.mockImplementation(engine => engine === 'codex');
    mocks.run.mockRejectedValue(new Error('Admission refused'));
    const cfg = config(['codex']);
    const milestones = await decomposeGoal('Restore frontier planning', cfg);
    expect(milestones[0].title).toBe('Design');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('planner selection never accesses either Codex home auth paths', () => {
    // Discovery is an engine-owned CLI probe. The planner must not supplement
    // it by reading or mutating credentials, even when Claude is missing.
    const probes = [
      vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'lstatSync'),
      vi.spyOn(fs, 'accessSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'openSync'),
    ];
    try {
      mocks.installed.mockImplementation(engine => engine === 'codex');
      expect(pickFrontierEngine(config(['claude', 'codex']))).toBe('codex');
      for (const probe of probes) {
        const paths = probe.mock.calls.map(args => String(args[0]));
        expect(paths.filter(path => /[\\/]\.codex[^\\/]*[\\/]auth[^\\/]*/.test(path))).toEqual([]);
        expect(probe).not.toHaveBeenCalled();
      }
    } finally {
      for (const probe of probes) probe.mockRestore();
    }
  });
});
