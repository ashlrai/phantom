import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetCapsRoute } from '../src/cli/fleet-caps-route.js';
import { BUILTIN_ENGINE_REGISTRY } from '../src/core/run/engine-registry.js';

const registry = JSON.parse(readFileSync('capabilities/registry.v1.json', 'utf8'));
const doc = readFileSync('docs/CAPABILITY-REGISTRY.md', 'utf8');
const examples = [...doc.matchAll(/^phm fleet caps-route (.+)$/gm)].map(match => match[1].split(' '));

async function run(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdFleetCapsRoute(args);
    return { code, receipt: JSON.parse(String(log.mock.lastCall?.[0])) };
  } finally { log.mockRestore(); }
}

describe('documented caps-route examples', () => {
  it('resolve committed ids and refuse absent dispatch without provider execution', async () => {
    expect(examples).toHaveLength(2);
    for (const args of examples) {
      const surface = registry.surfaces.find((s: { id: string }) => s.id === args[args.indexOf('--surface') + 1]);
      const model = registry.models.find((m: { id: string }) => m.id === args[args.indexOf('--model') + 1]);
      expect(surface).toBeDefined(); expect(model).toBeDefined();
      expect(surface.lane).toBe(model.lane);
      expect(surface.dispatch).toBeUndefined();
      expect(await run(args)).toMatchObject({ code: 1, receipt: { ok: false, reason: 'Surface has no commissioned execution adapter.' } });
    }
  });

  it('reports real engine and hosted metadata when those declarations are present', async () => {
    const copy = structuredClone(registry);
    copy.surfaces.find((s: { id: string }) => s.id === 'codex-cli').dispatch = 'engine';
    copy.surfaces.find((s: { id: string }) => s.id === 'glm-lite').dispatch = 'hosted';
    const dir = mkdtempSync(join(tmpdir(), 'caps-doc-'));
    const file = join(dir, 'registry.json');
    try {
      writeFileSync(file, JSON.stringify(copy));
      for (const args of examples) {
        const surface = copy.surfaces.find((s: { id: string }) => s.id === args[args.indexOf('--surface') + 1]);
        const model = copy.models.find((m: { id: string }) => m.id === args[args.indexOf('--model') + 1]);
        const result = await run([...args, '--registry', file]);
        expect(result.code).toBe(0);
        expect(result.receipt).toMatchObject({ ok: true, adapter: surface.dispatch, model: model.providerModelId });
        if (surface.dispatch === 'engine') {
          expect(model.catalogId.split(':')[0]).toBe(surface.engine);
          expect(result.receipt).toMatchObject({ engine: surface.engine, transport: BUILTIN_ENGINE_REGISTRY[surface.engine].kind });
        } else {
          expect(result.receipt.hops.length).toBeGreaterThan(0);
          for (const hop of result.receipt.hops) expect(copy.hosting).toContainEqual(hop);
          expect(result.receipt.hops.at(-1).guest).toBe(surface.id);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns exit 2 and JSON for each missing required argument', async () => {
    for (const flag of ['--surface', '--model', '--json']) {
      const args = [...examples[0]]; const index = args.indexOf(flag);
      args.splice(index, flag === '--json' ? 1 : 2);
      expect(await run(args)).toMatchObject({ code: 2, receipt: { ok: false } });
    }
  });
});
