import { describe, expect, it } from 'vitest';
import { resolveDotBridgeOwner } from '../src/core/comms/dot-bridge-owner.js';
import type { SurfaceOwnerReport } from '../src/core/fleet/surface-owner.js';

const report = (over: Partial<SurfaceOwnerReport>): SurfaceOwnerReport => ({
  schemaVersion: 1, authority: 'none', surface: 'dot-handoff', asOf: '2026-11-14T18:00:00.000Z',
  owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [], lastLanded: null, scannedPaths: [], reasons: [], ...over,
});

describe('resolveDotBridgeOwner', () => {
  it('returns the owner of exactly one advisory claim, asking for dot-handoff', async () => {
    const seen: string[] = [];
    const owner = await resolveDotBridgeOwner(async s => {
      seen.push(s);
      return report({ owner: 'agent-fake-1', ownerSource: 'advisory-claim' });
    });
    expect(owner).toBe('agent-fake-1');
    expect(seen).toEqual(['dot-handoff']);
  });
  it('returns null when no claim names the surface', async () => {
    expect(await resolveDotBridgeOwner(async () => report({}))).toBeNull();
  });
  it('returns null when two live claims leave the owner UNKNOWN', async () => {
    const two = [{ id: 'c1', agent: 'agent-fake-1', expiresInSeconds: 5 }, { id: 'c2', agent: 'agent-fake-2', expiresInSeconds: 5 }];
    expect(await resolveDotBridgeOwner(async () => report({ liveClaims: two }))).toBeNull();
  });
  it('returns null for an UNKNOWN owner even with an advisory source, and for a null report', async () => {
    expect(await resolveDotBridgeOwner(async () => report({ ownerSource: 'advisory-claim' }))).toBeNull();
    expect(await resolveDotBridgeOwner(async () => null)).toBeNull();
  });
  it('returns null when the reader throws', async () => {
    expect(await resolveDotBridgeOwner(async () => { throw new Error('boom /home/fake'); })).toBeNull();
  });
});
