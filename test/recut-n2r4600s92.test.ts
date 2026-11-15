import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSyncIoInSource } from '../scripts/check-verse-sync-io.mjs';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';

describe('fleet runs sync I/O guard', () => {
  it('accepts the private fleet state operations in the route module', () => {
    expect(createFleetRunsApi).toBeTypeOf('function');
    const source = readFileSync('src/core/verse/fleet-runs-api.ts', 'utf8');
    expect(findSyncIoInSource(source)).toEqual([]);
  });
});
