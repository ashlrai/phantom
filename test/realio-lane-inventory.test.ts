import { describe, expect, it } from 'vitest';
import { realIoLaneInventory } from '../scripts/realio-lane-inventory.mjs';
import configuration from '../vitest.config.js';
import { SERIAL_CPU_TEST_FILES } from './config/serial-cpu-lane-membership.mjs';
import { REAL_IO_TEST_FILES } from './config/realio-lane-membership.mjs';

describe('real-I/O lane inventory', () => {
  it('counts only discovered members and keeps other tests in the unit lane', () => {
    expect(realIoLaneInventory(['test/io.test.ts'], ['test/io.test.ts', 'test/unit.test.ts']))
      .toEqual({ stale: [], overlap: [], serialCpuCount: 0, realIoCount: 1, unitCount: 1 });
  });

  it('reports every absent fleet dependency instead of counting uncollected tests', () => {
    const absent = ['test/fleet-coordination.test.ts', 'test/fleet-cli.test.ts', 'test/fleet-snapshot.test.ts'];
    expect(realIoLaneInventory(['test/io.test.ts', ...absent], ['test/io.test.ts']))
      .toEqual({ stale: absent, overlap: [], serialCpuCount: 0, realIoCount: 1, unitCount: 0 });
  });

  it('normalizes Windows separators in both inventories and deduplicates identities', () => {
    expect(realIoLaneInventory(
      ['test\\nested\\io.test.ts', 'test/nested/io.test.ts', 'test\\missing.test.ts'],
      ['test/nested/io.test.ts', 'test\\unit.test.ts', 'test/unit.test.ts'],
    )).toEqual({ stale: ['test/missing.test.ts'], overlap: [], serialCpuCount: 0, realIoCount: 1, unitCount: 1 });
  });

  it('never reports negative counts when no registered tests are collected', () => {
    expect(realIoLaneInventory(['test/missing.test.ts'], []))
      .toEqual({ stale: ['test/missing.test.ts'], overlap: [], serialCpuCount: 0, realIoCount: 0, unitCount: 0 });
    expect(realIoLaneInventory([], ['test/unit.test.ts']))
      .toEqual({ stale: [], overlap: [], serialCpuCount: 0, realIoCount: 0, unitCount: 1 });
  });
});


describe('serial CPU collection partition', () => {
  it('counts a serial CPU member once and fails overlapping or stale memberships visibly', () => {
    expect(realIoLaneInventory(['test/io.test.ts'], ['test/io.test.ts', 'test/cpu.test.ts', 'test/unit.test.ts'], ['test/cpu.test.ts']))
      .toEqual({ stale: [], overlap: [], realIoCount: 1, serialCpuCount: 1, unitCount: 1 });
    expect(realIoLaneInventory(['test/cpu.test.ts'], ['test/cpu.test.ts'], ['test/cpu.test.ts', 'test/missing.test.ts']))
      .toEqual({ stale: ['test/missing.test.ts'], overlap: ['test/cpu.test.ts'], realIoCount: 1, serialCpuCount: 0, unitCount: 0 });
  });

  it('keeps the complete measured file in exactly one late project with unchanged bounds', () => {
    const config = configuration as { test: { include?: unknown; pool?: string; projects: Array<{ test: Record<string, unknown> }> } };
    const project = (name: string) => config.test.projects.find((entry) => entry.test.name === name)!.test;
    expect(config.test.include).toBeUndefined();
    expect(config.test.pool).toBe('forks');
    expect(SERIAL_CPU_TEST_FILES).toEqual(['test/memory-evaluation-performance.test.ts']);
    expect(project('unit').exclude).toEqual(expect.arrayContaining([...SERIAL_CPU_TEST_FILES]));
    expect(project('real-io').include).toEqual(REAL_IO_TEST_FILES);
    expect(REAL_IO_TEST_FILES).not.toContain(SERIAL_CPU_TEST_FILES[0]);
    expect(project('serial-cpu')).toMatchObject({ include: [...SERIAL_CPU_TEST_FILES], maxWorkers: 1,
      fileParallelism: false, testTimeout: 5000, hookTimeout: 5000, sequence: { groupOrder: 3 } });
    expect(project('unit').sequence).toEqual({ groupOrder: 1 });
    expect(project('real-io').sequence).toEqual({ groupOrder: 2 });
  });
});
