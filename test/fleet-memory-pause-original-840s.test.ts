import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetMemory } from '../src/core/fleet/memory-state.js';
import { buildFleetStatus } from '../src/core/fleet/status.js';
import type { AshlrConfig } from '../src/core/types.js';

const off = { state: 'off', since: null, reasons: [] };
const unknown = { state: 'unknown', since: null, reasons: [] };
const on = (reason: string) => ({ state: 'on', since: null, reasons: reason ? [reason] : [] });
const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30,
  categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
} as AshlrConfig;

describe('fleet memory pause scopes', () => {
  let root: string;
  let paths: { pausePath: string; metricsPath: string; admissionPath: string };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-pause-'));
    paths = { pausePath: join(root, 'PAUSE'), metricsPath: join(root, 'metrics'), admissionPath: join(root, 'waits') };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each([
    ['local only', null, 'local pressure', off, on('local pressure')],
    ['global only', 'global pressure', null, on('global pressure'), off],
    ['both', 'global pressure', 'local pressure', on('global pressure'), on('local pressure')],
    ['absent', null, null, off, off],
    ['empty', '', '', on(''), on('')],
  ])('serializes %s observations and preserves legacy metrics', async (_label, global, local, globalExpected, localExpected) => {
    if (global !== null) await writeFile(paths.pausePath, global);
    if (local !== null) await writeFile(join(root, 'PAUSE_LOCAL'), local);
    await writeFile(paths.metricsPath, '{"freeMemoryPercent":5,"swapUsedBytes":42}');
    await writeFile(paths.admissionPath, '{"admissionWaitsByPool":{"work":2}}');
    const memory = await readFleetMemory(paths);
    expect(memory).toEqual({
      pause: { state: global === null ? 'absent' : 'present', reason: global || null },
      pauseState: { global: globalExpected, local: localExpected },
      freeMemoryPercent: 5, swapUsedBytes: 42, admissionWaitsByPool: { work: 2 },
    });
    const snapshot = JSON.parse(JSON.stringify(await buildFleetStatus(cfg, { memoryPaths: paths })));
    expect(snapshot.schema).toBe('fleet.v1');
    expect(snapshot.memory).toEqual(memory);
  });

  it('preserves independent unknowns for unreadable directories in JSON', async () => {
    await mkdir(paths.pausePath);
    await mkdir(join(root, 'PAUSE_LOCAL'));
    const memory = await readFleetMemory(paths);
    expect(memory).toEqual({
      pause: { state: 'unknown', reason: null }, pauseState: { global: unknown, local: unknown },
      freeMemoryPercent: null, swapUsedBytes: null, admissionWaitsByPool: null,
    });
    const snapshot = JSON.parse(JSON.stringify(await buildFleetStatus(cfg, { memoryPaths: paths })));
    expect(snapshot.memory).toEqual(memory);
  });

  it('honors an explicit local path independently of the global path', async () => {
    const pauseLocalPath = join(root, 'custom-local');
    await writeFile(pauseLocalPath, 'custom reason');
    expect((await readFleetMemory({ ...paths, pauseLocalPath })).pauseState).toEqual({ global: off, local: on('custom reason') });
  });
});
