import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { isLocalModel, localMemorySnapshot, localModelFit, localModelsVitals, memoryFit } from '../src/core/resources/local-memory-fit.js';

const GiB = 1024 ** 3;
const host = { totalBytes: 64 * GiB, freeBytes: 36 * GiB, swapGrowth: 0 };
it('reserves exactly 25%, charges context and refuses even one byte below the floor', () => {
  expect(memoryFit('qwen-27b', 18 * GiB, 8192, host).verdict).toBe('fits');
  expect(memoryFit('qwen-27b', 18 * GiB, 8192, { ...host, freeBytes: host.freeBytes - 1 }).verdict).toBe('does-not-fit');
  expect(memoryFit('qwen-27b', 18 * GiB, 65536, host).verdict).toBe('does-not-fit');
});
it.each([null, -1, NaN, Infinity])('keeps unknown/invalid sizes %s unknown', size => {
  expect(memoryFit('qwen', size, 8192, host)).toMatchObject({ verdict: 'unknown', residentBytes: null, requiredBytes: null });
});
it('refuses growing or unknown swap and malformed memory without inventing headroom', () => {
  expect(memoryFit('qwen', GiB, 8192, { ...host, swapGrowth: 1 }).verdict).toBe('swap-growing');
  for (const memory of [null, { ...host, swapGrowth: null }, { ...host, freeBytes: Infinity }])
    expect(memoryFit('qwen', GiB, 8192, memory).verdict).toBe('unknown');
  expect(memoryFit('qwen', GiB, NaN, host).contextBytes).toBeNull();
});
it.each(['omlx', 'mlx', 'llama-server', 'ollama', 'local-coder', 'codex-local', 'local-omlx', 'lmstudio'])('identifies %s as local', engine => {
  expect(isLocalModel(engine)).toBe(true); expect(isLocalModel('codex-personal')).toBe(false);
});
it('reads bounded metadata, refuses stale/future/symlink evidence, and distinguishes inventory from loaded models', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-fit-'));
  try {
    const source = { resources: { machine: { sampledAtMs: 100_000, ram: { totalBytes: host.totalBytes, freeBytes: host.freeBytes }, swap: { growthBytesPerSecond: 0 } },
      models: { models: [{ id: 'qwen', engine: 'omlx', residentBytes: 18 * GiB }] } } };
    writeFileSync(join(root, 'fleet.json'), JSON.stringify(source));
    expect(localModelFit('qwen', 8192, localMemorySnapshot(root, 100_000)).residentBytes).toBe(18 * GiB);
    expect(localMemorySnapshot(root, 100_000).memory!.totalBytes).toBeGreaterThanOrEqual(totalmem());
    for (const now of [99_999, 130_001]) expect(localMemorySnapshot(root, now).memory).toBeNull();
    expect(localModelsVitals(root, 100_000)).toMatchObject({ loaded_models: null, last_unload_reason: null, models: [{ loaded: null }] });
    rmSync(join(root, 'fleet.json')); symlinkSync(join(root, 'missing'), join(root, 'fleet.json'));
    expect(localMemorySnapshot(root, 100_000).memory).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
