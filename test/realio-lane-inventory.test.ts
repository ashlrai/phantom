import { describe, expect, it } from 'vitest';
import { realIoLaneInventory } from '../scripts/realio-lane-inventory.mjs';

describe('real-I/O lane inventory', () => {
  it('counts only discovered members and keeps other tests in the unit lane', () => {
    expect(realIoLaneInventory(['test/io.test.ts'], ['test/io.test.ts', 'test/unit.test.ts']))
      .toEqual({ stale: [], realIoCount: 1, unitCount: 1 });
  });

  it('reports every absent fleet dependency instead of counting uncollected tests', () => {
    const absent = ['test/fleet-coordination.test.ts', 'test/fleet-cli.test.ts', 'test/fleet-snapshot.test.ts'];
    expect(realIoLaneInventory(['test/io.test.ts', ...absent], ['test/io.test.ts']))
      .toEqual({ stale: absent, realIoCount: 1, unitCount: 0 });
  });

  it('normalizes Windows separators in both inventories and deduplicates identities', () => {
    expect(realIoLaneInventory(
      ['test\\nested\\io.test.ts', 'test/nested/io.test.ts', 'test\\missing.test.ts'],
      ['test/nested/io.test.ts', 'test\\unit.test.ts', 'test/unit.test.ts'],
    )).toEqual({ stale: ['test/missing.test.ts'], realIoCount: 1, unitCount: 1 });
  });

  it('never reports negative counts when no registered tests are collected', () => {
    expect(realIoLaneInventory(['test/missing.test.ts'], []))
      .toEqual({ stale: ['test/missing.test.ts'], realIoCount: 0, unitCount: 0 });
    expect(realIoLaneInventory([], ['test/unit.test.ts']))
      .toEqual({ stale: [], realIoCount: 0, unitCount: 1 });
  });
});
