import { describe, expect, it, vi } from 'vitest';
import { fleetVerbsCatalog } from '../src/core/fleet/fleet-verbs-tool.js';

vi.mock('../src/cli/fleet-subcommand-registry.js', () => {
  throw new Error('Read-only catalog discovery must not import fleet command loaders');
});

describe('fleet verb registry discovery', () => {
  it('discovers real verbs and usage without importing the command registry', () => {
    const catalog = fleetVerbsCatalog();
    if (!('verbs' in catalog)) throw new Error(catalog.error);
    expect(catalog.schema).toBe('fleet.verbs.v1');
    expect(catalog.count).toBe(catalog.verbs.length);
    expect(catalog.count).toBeGreaterThan(0);
    expect(catalog.verbs).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'needs', usage: expect.any(String) }),
      expect.objectContaining({ verb: 'verbs', usage: expect.any(String) }),
    ]));
    expect(fleetVerbsCatalog('verbs')).toMatchObject({
      schema: 'fleet.verbs.v1', count: 1, verbs: [{ verb: 'verbs' }],
    });
  });
});
