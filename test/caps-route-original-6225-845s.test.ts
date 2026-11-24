import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { parseCapsRegistry } from '../src/core/caps/registry.js';
import { routeSurfaceModel } from '../src/core/caps/dispatch.js';

const fixture = () => JSON.parse(readFileSync('test/fixtures/caps/minimal.registry.json', 'utf8'));
describe('original surface route receipts', () => {
  it('returns explicit CLI and local transports and refuses catalog mismatch', () => {
    const doc = fixture();
    doc.surfaces[0].dispatch = 'engine'; doc.surfaces[5].dispatch = 'engine';
    const reg = parseCapsRegistry(doc);
    expect(routeSurfaceModel(reg, 'claude-code', 'claude-opus-5-5')).toMatchObject({ ok: true, engine: 'claude', model: 'claude-opus-5-5', transport: 'cli-agent' });
    expect(routeSurfaceModel(reg, 'local-omlx', 'qwen-local')).toMatchObject({ ok: true, transport: 'api-model', engine: 'local-coder' });
    doc.models[2].lane = 'claude';
    expect(routeSurfaceModel(parseCapsRegistry(doc), 'claude-code', 'gpt-6.1-sol')).toMatchObject({ ok: false, reason: expect.stringMatching(/catalog engine/) });
  });
  it('preserves hosted edges and refuses unavailable metadata and missing paths', () => {
    const doc = fixture(); doc.surfaces[4].dispatch = 'hosted';
    const reg = parseCapsRegistry(doc);
    expect(routeSurfaceModel(reg, 'glm-lite', 'glm-5.3')).toMatchObject({ ok: true, adapter: 'hosted', hops: [{ host: 'devin-cli', guest: 'glm-lite', via: 'devin-subagent' }] });
    expect(routeSurfaceModel(reg, 'claude-code', 'claude-opus-5-5')).toMatchObject({ ok: false });
    reg.surfaces[0].dispatch = 'unavailable';
    expect(routeSurfaceModel(reg, 'claude-code', 'claude-opus-5-5')).toMatchObject({ ok: false });
    reg.hosting = [];
    expect(routeSurfaceModel(reg, 'glm-lite', 'glm-5.3')).toMatchObject({ ok: false });
    expect(routeSurfaceModel(reg, 'missing', 'glm-5.3')).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown surface/) });
    expect(routeSurfaceModel(reg, 'claude-code', 'missing')).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown model/) });
  });
  it('dispatches through the fleet CLI, validates input and makes no file changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caps-route-')); const file = join(dir, 'registry.json');
    const doc = fixture(); doc.surfaces[0].dispatch = 'engine'; writeFileSync(file, JSON.stringify(doc));
    const before = readFileSync(file, 'utf8');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const run = (args: string[]) => cmdFleet(['caps-route', ...args], FLEET_SUBCOMMAND_LOADERS);
      expect(await run(['--surface', 'claude-code', '--model', 'claude-opus-5-5', '--registry', file, '--json'])).toBe(0);
      expect(JSON.parse(String(output.mock.lastCall?.[0]))).toMatchObject({ ok: true, adapter: 'engine' });
      for (const args of [['--surface'], ['--json', '--json'], ['--unknown'], ['--surface', 'a', '--surface', 'b', '--model', 'c', '--json']]) expect(await run(args)).toBe(2);
      expect(await run(['--surface', 'unknown', '--model', 'x', '--registry', file, '--json'])).toBe(1);
      writeFileSync(file, '{');
      expect(await run(['--surface', 'a', '--model', 'b', '--registry', file, '--json'])).toBe(1);
      writeFileSync(file, before);
      expect(readdirSync(dir)).toEqual(['registry.json']); expect(readFileSync(file, 'utf8')).toBe(before);
    } finally { output.mockRestore(); }
  });
});
