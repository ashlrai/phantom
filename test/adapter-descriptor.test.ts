import { describe, expect, it } from 'vitest';
import { parseAdapterDescriptors, projectAdapterEvidence } from '../src/core/providers/adapter-descriptor.js';

const revision = `sha256:${'a'.repeat(64)}`;
const other = `sha256:${'b'.repeat(64)}`;
const adapter = {
  id: 'sample.shell', revision, source: 'fixture', purpose: 'tool', transport: 'cli',
  capabilities: [{ id: 'workspace.read', outputSchemaDigest: revision }, { id: 'project.read' }],
};
const catalog = (adapters: unknown[] = [adapter]) => ({ schema: 'phantom.adapter-descriptor.v1', adapters });
const observed = {
  id: adapter.id, revision, source: 'local-probe', observedAtMs: 100, expiresAtMs: 200,
};
const observations = (rows: unknown[] = []) => ({ schema: 'phantom.adapter-observation.v1', observations: rows });

describe('offline adapter descriptors', () => {
  it('normalizes descriptor and capability order without changing caller data', () => {
    const mcp = { ...adapter, id: 'mcp.sample', transport: 'mcp-http' };
    const catalog1 = catalog([adapter, mcp]);
    const catalog2 = catalog([{ ...mcp, capabilities: [...mcp.capabilities].reverse() }, adapter]);
    const parsed = parseAdapterDescriptors(catalog1);
    expect(parsed).toEqual(parseAdapterDescriptors(catalog2));
    expect(parsed.adapters.map(row => row.id)).toEqual(['mcp.sample', 'sample.shell']);
    expect(parsed.adapters[0]?.capabilities.map(row => row.id)).toEqual(['project.read', 'workspace.read']);
    expect(adapter.capabilities[0]?.id).toBe('workspace.read');
  });

  it('rejects unknown versions, unknown keys at every level and invalid digests', () => {
    const invalid = [
      { ...catalog(), schema: 'phantom.adapter-descriptor.v2' },
      { ...catalog(), command: 'fake' },
      catalog([{ ...adapter, endpoint: 'invalid-example' }]),
      catalog([{ ...adapter, capabilities: [{ id: 'read', rawSchema: {} }] }]),
      catalog([{ ...adapter, revision: 'sha256:bad' }]),
    ];
    for (const value of invalid) expect(() => parseAdapterDescriptors(value)).toThrow('Invalid adapter descriptor catalog.');
  });

  it('requires bounded, canonical IDs and bounded lists', () => {
    for (const value of ['../name', 'Name', 'a..b', 'a'.repeat(81), 'x y']) {
      expect(() => parseAdapterDescriptors(catalog([{ ...adapter, id: value }]))).toThrow('Invalid adapter descriptor catalog.');
    }
    const tooMany = Array.from({ length: 257 }, (_, i) => ({ ...adapter, id: `adapter-${i}` }));
    expect(() => parseAdapterDescriptors(catalog(tooMany))).toThrow('Invalid adapter descriptor catalog.');
    const capabilities = Array.from({ length: 33 }, (_, i) => ({ id: `cap-${i}` }));
    expect(() => parseAdapterDescriptors(catalog([{ ...adapter, capabilities }]))).toThrow('Invalid adapter descriptor catalog.');
  });

  it('refuses ambiguous repeated adapter IDs, capability IDs and observations', () => {
    expect(() => parseAdapterDescriptors(catalog([adapter, { ...adapter, revision: other }]))).toThrow('Duplicate adapter id.');
    const capabilities = [{ id: 'read' }, { id: 'read', outputSchemaDigest: revision }];
    expect(() => parseAdapterDescriptors(catalog([{ ...adapter, capabilities }]))).toThrow('Duplicate capability id.');
    expect(() => projectAdapterEvidence(catalog(), observations([observed, { ...observed, revision: other }]), 110))
      .toThrow('Duplicate adapter observation id.');
  });

  it('keeps missing, stale, future and different-revision records out of current evidence', () => {
    for (const [rows, now, expected] of [
      [[], 110, { state: 'unknown', reason: 'missing' }],
      [[observed], 200, { state: 'stale', reason: 'expired' }],
      [[observed], 99, { state: 'unknown', reason: 'future' }],
      [[{ ...observed, revision: other }], 110, { state: 'unknown', reason: 'revision-mismatch' }],
      [[{ ...observed, id: 'other' }], 110, { state: 'unknown', reason: 'missing' }],
    ] as const) {
      expect(projectAdapterEvidence(catalog(), observations([...rows]), now)[0]?.evidence).toEqual(expected);
    }
  });

  it('reports matching fresh evidence without claiming readiness or eligibility', () => {
    const [result] = projectAdapterEvidence(catalog(), observations([observed]), 100);
    expect(result?.evidence).toEqual({ state: 'reported', source: 'local-probe', observedAtMs: 100, expiresAtMs: 200 });
    expect(result).not.toHaveProperty('ready');
    expect(result).not.toHaveProperty('eligible');
  });

  it('rejects malformed observation envelopes, ambiguous timestamps and arbitrary data', () => {
    for (const value of [
      { ...observations(), schema: 'phantom.adapter-observation.v2' },
      observations([{ ...observed, account: 'private' }]),
      observations([{ ...observed, expiresAtMs: 100 }]),
      observations([{ ...observed, expiresAtMs: 100 + 86_400_001 }]),
    ]) expect(() => projectAdapterEvidence(catalog(), value, 110)).toThrow(/Invalid adapter observation/);
    expect(() => projectAdapterEvidence(catalog(), observations(), Infinity)).toThrow('Invalid adapter observation time.');
  });
});
