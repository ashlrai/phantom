import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cmdCaps } from '../src/cli/caps.js';
import { planSurfaceModelDispatch, routeSurfaceModel } from '../src/core/caps/dispatch.js';
import { parseCapsRegistry, validateCapsRegistry } from '../src/core/caps/registry.js';
import { BUILTIN_ENGINE_REGISTRY, compileArgv, planEngineDispatch } from '../src/core/run/engine-registry.js';
import { buildEngineCommand } from '../src/core/run/engines.js';
import type { AshlrConfig } from '../src/core/types.js';

const cfg = { foundry: {} } as AshlrConfig;
const raw = () => JSON.parse(readFileSync(new URL('../capabilities/registry.v1.json', import.meta.url), 'utf8'));
const registry = () => parseCapsRegistry(raw());

describe('OS-1 execution adapter schema', () => {
  it.each([
    { dispatch: 'engine', engine: undefined },
    { dispatch: 'engine', hostedOnly: true },
    { dispatch: 'hosted' },
    { dispatch: 'shell' },
    { dispatch: 'engine', engine: 'local-coder' },
    { dispatch: 'engine', kind: 'desktop' },
  ])('rejects incompatible or unknown execution adapters: %j', patch => {
    const doc = raw();
    Object.assign(doc.surfaces[0], patch);
    const result = validateCapsRegistry(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some(i => i.path === 'surfaces[0].dispatch')).toBe(true);
  });

  it('does not infer execution authority from a companion config adapter', () => {
    const doc = raw();
    delete doc.surfaces[0].dispatch;
    const reg = parseCapsRegistry(doc);
    expect(routeSurfaceModel(reg, 'claude-code', 'claude-fable-5-2')).toMatchObject({ ok: false, reason: expect.stringContaining('commissioned') });
    expect(routeSurfaceModel(reg, 'codex-desktop', 'gpt-6.1-sol').ok).toBe(false);
  });
});

describe('surface/model dispatch', () => {
  it('materializes the selected model on the selected CLI without changing the goal', () => {
    const goal = 'literal $CWD; `echo untouched`';
    const result = planSurfaceModelDispatch(registry(), 'codex-cli', 'gpt-6.1-terra', goal, cfg, { cwd: '/wt' });
    expect(result).toMatchObject({ ok: true, route: { engine: 'codex', model: 'gpt-6.1-terra' }, dispatch: { kind: 'cli-agent' } });
    if (!result.ok || result.dispatch.kind !== 'cli-agent') throw new Error('expected CLI');
    expect(result.dispatch.command).toEqual({ bin: 'codex', args: ['exec', '--model', 'gpt-6.1-terra', '--cd', '/wt', '--json', goal], cwd: '/wt' });
  });

  it('preserves the model on an in-process local API route', () => {
    expect(planSurfaceModelDispatch(registry(), 'local-omlx', 'qwen3.8-27b-local', 'task', cfg)).toMatchObject({
      ok: true, dispatch: { kind: 'api-model', engine: 'local-coder', model: 'qwen3.8:27b-ctx64k' },
    });
  });

  it('preserves hosting edges and refuses to bypass the host with a direct launch', () => {
    const reg = registry();
    expect(routeSurfaceModel(reg, 'glm-lite', 'glm-5.3')).toMatchObject({
      ok: true, adapter: 'hosted', model: 'glm-5.3',
      hops: [{ host: 'devin-cli', guest: 'glm-lite', via: 'devin-subagent' }],
    });
    expect(planSurfaceModelDispatch(reg, 'glm-lite', 'glm-5.3', 'task', cfg)).toMatchObject({ ok: false, reason: expect.stringContaining('host adapter') });
  });

  it('rejects unknown, cross-lane and same-lane wrong-engine model selections', () => {
    const reg = registry();
    expect(routeSurfaceModel(reg, 'missing', 'gpt-6.1-sol').ok).toBe(false);
    expect(routeSurfaceModel(reg, 'codex-cli', 'missing').ok).toBe(false);
    expect(routeSurfaceModel(reg, 'codex-cli', 'claude-fable-5-2').ok).toBe(false);
    const doc = raw();
    doc.surfaces.find((s: { id: string }) => s.id === 'codex-cli').engine = 'claude';
    expect(routeSurfaceModel(parseCapsRegistry(doc), 'codex-cli', 'gpt-6.1-sol')).toMatchObject({ ok: false, reason: expect.stringContaining('catalog engine') });
  });

  it('refuses configured transport replacement after surface selection', () => {
    const changed = { foundry: { engines: { codex: { id: 'codex', kind: 'api-model', tier: 'frontier' } } } } as AshlrConfig;
    expect(planSurfaceModelDispatch(registry(), 'codex-cli', 'gpt-6.1-sol', 'task', changed).ok).toBe(false);
  });
});

describe('transport adapter parity', () => {
  it.each(['claude', 'codex', 'devin-cli', 'aw', 'ashlrcode'])('keeps %s argv identical to the engine registry', engine => {
    const spec = BUILTIN_ENGINE_REGISTRY[engine]!;
    const options = { cwd: '/wt', model: 'chosen-model', autonomous: true };
    const expected = { bin: spec.bin ?? spec.bins?.[0] ?? spec.id,
      args: compileArgv(spec.argv!, { goal: 'task', ...options }, spec.autonomousArgv), cwd: '/wt' };
    expect(planEngineDispatch(engine, 'task', cfg, options)).toEqual({ kind: 'cli-agent', engine, command: expected });
    expect(buildEngineCommand(engine, 'task', cfg, options)).toEqual(expected);
  });

  it('supports a configured CLI without a provider branch', () => {
    const custom = { foundry: { engines: { example: { id: 'example', kind: 'cli-agent', tier: 'local', bin: 'example-agent',
      argv: ['$GOAL', { optModel: ['--model', '$MODEL'] }] } } } } as AshlrConfig;
    expect(buildEngineCommand('example', 'task', custom, { cwd: '/wt', model: 'selected' })).toEqual({
      bin: 'example-agent', args: ['task', '--model', 'selected'], cwd: '/wt',
    });
    expect(planEngineDispatch('toString', 'task', cfg)).toBeNull();
  });

  it('never turns llama-server into a CLI, including through configuration', () => {
    const changed = { foundry: { engines: { 'llama-server': { id: 'llama-server', kind: 'cli-agent', tier: 'mid', bin: 'unexpected', argv: ['$GOAL'] } } } } as AshlrConfig;
    expect(buildEngineCommand('llama-server', 'task', changed)).toBeNull();
    expect(buildEngineCommand('builtin', 'task', cfg)).toBeNull();
    expect(buildEngineCommand('unknown-engine', 'task', cfg)).toBeNull();
  });
});

describe('caps route CLI', () => {
  it('prints a read-only route receipt and rejects incomplete selections', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdCaps(['route', '--surface', 'codex-cli', '--model', 'gpt-6.1-sol', '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: true, adapter: 'engine', engine: 'codex', transport: 'cli-agent' });
      expect(await cmdCaps(['route', '--surface', 'codex-cli', '--json'])).toBe(2);
      expect(await cmdCaps(['route', '--surface', 'codex-desktop', '--model', 'gpt-6.1-sol', '--json'])).toBe(1);
    } finally { log.mockRestore(); }
  });
});
