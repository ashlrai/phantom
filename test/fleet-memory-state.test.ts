import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetMemory, type FleetMemoryPaths } from '../src/core/fleet/memory-state.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { buildFleetStatus, type FleetStatus } from '../src/core/fleet/status.js';
import type { AshlrConfig } from '../src/core/types.js';

describe('fleet.v1 local memory fixtures', () => {
  let root: string;
  let paths: Required<FleetMemoryPaths>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-memory-'));
    paths = {
      pausePath: join(root, 'PAUSE'),
      metricsPath: join(root, 'metrics.json'),
      admissionPath: join(root, 'waits.json'),
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('includes injectable local observations in the serialized fleet.v1 snapshot', async () => {
    await writeFile(paths.pausePath, 'memory admission held');
    const cfg = {
      version: 1, roots: [], editor: 'cursor', staleDays: 30,
      categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
    } as AshlrConfig;
    const status = await buildFleetStatus(cfg, { memoryPaths: paths });
    expect(JSON.parse(JSON.stringify(status))).toMatchObject({
      schema: 'fleet.v1',
      budgets: { pools: expect.any(Object) },
      memory: {
        pause: { state: 'present', reason: 'memory admission held' },
        freeMemoryPercent: null, swapUsedBytes: null, admissionWaitsByPool: null,
      },
    });
  });

  it('reads a PAUSE reason, memory metrics and waits per pool', async () => {
    await writeFile(paths.pausePath, ' low free memory\nwaiting for recovery\n');
    await writeFile(paths.metricsPath, JSON.stringify({ freeMemoryPercent: 4.5, swapUsedBytes: 1024 }));
    await writeFile(paths.admissionPath, JSON.stringify({ admissionWaitsByPool: { 'codex-personal': 3, work: 0 } }));
    expect(await readFleetMemory(paths)).toEqual({
      pause: { state: 'present', reason: 'low free memory\nwaiting for recovery' },
      freeMemoryPercent: 4.5, swapUsedBytes: 1024,
      admissionWaitsByPool: { 'codex-personal': 3, work: 0 },
    });
    const board = formatFleetStatus({
      generatedAt: '2026-10-26T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [], queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 }, killed: false, autonomyControlMode: 'disabled',
      memory: await readFleetMemory(paths),
    } satisfies FleetStatus);
    expect(board).toContain('Memory: PAUSE present (low free memory');
    expect(board).toContain('free: 4.5%; swap used: 1024 bytes');
    expect(board).toContain('"codex-personal":3');
  });

  it('reports absent PAUSE and missing optional files without claiming zero usage', async () => {
    expect(await readFleetMemory(paths)).toEqual({
      pause: { state: 'absent', reason: null },
      freeMemoryPercent: null, swapUsedBytes: null, admissionWaitsByPool: null,
    });
  });

  it('keeps valid metrics when PAUSE is absent and accepts observed zero values', async () => {
    await writeFile(paths.metricsPath, '{"freeMemoryPercent":100,"swapUsedBytes":0}');
    await writeFile(paths.admissionPath, '{"admissionWaitsByPool":{}}');
    expect(await readFleetMemory(paths)).toEqual({
      pause: { state: 'absent', reason: null },
      freeMemoryPercent: 100, swapUsedBytes: 0, admissionWaitsByPool: {},
    });
  });

  it('an empty PAUSE still gates launches, independent of corrupt metrics', async () => {
    await writeFile(paths.pausePath, '');
    await writeFile(paths.metricsPath, '{broken');
    expect(await readFleetMemory(paths)).toMatchObject({
      pause: { state: 'present', reason: null }, freeMemoryPercent: null, swapUsedBytes: null,
    });
  });

  it('reports unreadable sources as unknown without hiding another source', async () => {
    await mkdir(paths.pausePath);
    await mkdir(paths.metricsPath);
    await writeFile(paths.admissionPath, '{"admissionWaitsByPool":{"work":2}}');
    expect(await readFleetMemory(paths)).toEqual({
      pause: { state: 'unknown', reason: null }, freeMemoryPercent: null, swapUsedBytes: null,
      admissionWaitsByPool: { work: 2 },
    });
  });

  it.each([
    [null, null], [[], []],
    [{ freeMemoryPercent: -1, swapUsedBytes: -1 }, { admissionWaitsByPool: { work: -1 } }],
    [{ freeMemoryPercent: 101, swapUsedBytes: '1024' }, { admissionWaitsByPool: { work: 0.5 } }],
    [{ freeMemoryPercent: '10' }, { admissionWaitsByPool: [] }],
  ])('rejects invalid metric and admission shapes: %j', async (metrics, waits) => {
    await writeFile(paths.metricsPath, JSON.stringify(metrics));
    await writeFile(paths.admissionPath, JSON.stringify(waits));
    expect(await readFleetMemory(paths)).toMatchObject({
      freeMemoryPercent: null, swapUsedBytes: null, admissionWaitsByPool: null,
    });
  });
});
