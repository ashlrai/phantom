import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AutoMergeCanaryReadResult, AutoMergeCanaryStateV1 } from '../src/core/fleet/automerge-canary-store.js';
import { AUTOMERGE_CANARY_ENFORCE_SUPPORTED } from '../src/core/fleet/automerge-canary-store.js';
import { buildCanaryShadowReport, formatCanaryShadowReport } from '../src/core/fleet/automerge-canary-shadow-report.js';

function rev(epochId: string, revision: number, ev: Partial<NonNullable<AutoMergeCanaryStateV1['lastShadowEvidence']>> | null, counters = { attempts: 0, eligible: 0, rejected: 0, bindingMismatches: 0, inspectionErrors: 0, casRetries: 0 }): AutoMergeCanaryStateV1 {
  return {
    epochId,
    revision,
    shadowCounters: counters,
    lastShadowEvidence: ev === null ? null : {
      observationDigest: `d${revision}`,
      observedAt: `2026-10-2${revision}T00:00:00.000Z`,
      outcome: 'eligible',
      mismatchFields: [],
      headOid: `${'a'.repeat(39)}${revision}`,
      fileCount: 1,
      lineCount: 3,
      ...ev,
    },
  } as unknown as AutoMergeCanaryStateV1;
}

function read(state: AutoMergeCanaryStateV1 | null, revisions: AutoMergeCanaryStateV1[], extra: Partial<AutoMergeCanaryReadResult> = {}): AutoMergeCanaryReadResult {
  return {
    enforceSupported: false, sourceState: state ? 'healthy' : 'missing', severity: 'none',
    status: state ? 'shadow' : 'inactive', active: !!state, state, revisions,
    terminalEpochs: [], diagnostics: [], limitExceeded: false, ...extra,
  };
}

describe('canary Shadow Report', () => {
  it('an empty store reports zero counts and grants no authority', () => {
    const r = buildCanaryShadowReport(read(null, []));
    expect(r).toMatchObject({ authority: 'observation-only', activationPermitted: false, counterfactual: true, epochId: null, counterfactualYield: null, wouldHaveMerged: [], blocked: [] });
  });

  it('lists would-merge and blocked evidence for the current epoch, deduplicated', () => {
    const counters = { attempts: 4, eligible: 1, rejected: 1, bindingMismatches: 1, inspectionErrors: 1, casRetries: 0 };
    const r1 = rev('e1', 1, { outcome: 'eligible' });
    const r2 = rev('e1', 2, { outcome: 'binding-mismatch', mismatchFields: ['headOid', 'baseOid'] });
    const r2dup = rev('e1', 2, { outcome: 'binding-mismatch', mismatchFields: ['headOid', 'baseOid'] });
    const r3 = rev('e1', 3, { outcome: 'inspection-error' }, counters);
    const other = rev('e0', 4, { outcome: 'eligible' });
    const r = buildCanaryShadowReport(read(r3, [other, r1, r2, r2dup, r3]));
    expect(r.epochId).toBe('e1');
    expect(r.counters).toEqual({ attempts: 4, eligible: 1, rejected: 1, bindingMismatches: 1, evidenceUnknown: 1 });
    expect(r.counterfactualYield).toBe(0.25);
    expect(r.wouldHaveMerged.map((e) => e.headOid)).toEqual([`${'a'.repeat(39)}1`]);
    expect(r.blocked.map((e) => e.outcome)).toEqual(['binding-mismatch', 'inspection-error']);
    expect(r.blocked[0]!.mismatchFields).toEqual(['baseOid', 'headOid']);
    expect(r.blockingFieldCounts).toEqual({ baseOid: 1, headOid: 1 });
  });

  it('carries degraded source state and diagnostics through', () => {
    const r = buildCanaryShadowReport(read(null, [], { sourceState: 'degraded', status: 'critical', severity: 'critical', diagnostics: ['chain-broken', 'future-time'] }));
    expect(r.source).toEqual({ state: 'degraded', status: 'critical', diagnostics: ['chain-broken', 'future-time'] });
  });

  it('truncates long lists to the 50 most recent entries', () => {
    const revs = Array.from({ length: 60 }, (_, i) => ({ ...rev('e1', i, null), lastShadowEvidence: { ...rev('e1', i, {}).lastShadowEvidence!, observationDigest: `d${i}`, observedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() } }) as AutoMergeCanaryStateV1);
    const r = buildCanaryShadowReport(read(revs[59]!, revs));
    expect(r.wouldHaveMerged).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it('text output labels the report counterfactual and observation-only', () => {
    const text = formatCanaryShadowReport(buildCanaryShadowReport(read(null, [])), false);
    expect(text).toContain('observation-only, counterfactual; grants no authority');
    expect(JSON.parse(formatCanaryShadowReport(buildCanaryShadowReport(read(null, [])), true)).kind).toBe('automerge-canary-shadow-report');
  });

  it('is read-only: imports types only and no store writers, enforce stays unsupported', () => {
    const src = readFileSync(new URL('../src/core/fleet/automerge-canary-shadow-report.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^import type \{/m);
    for (const writer of ['activateShadow', 'activateEnforce', 'appendShadowObservation', 'appendRevision', 'haltShadow', 'writeFile', 'node:fs']) {
      expect(src).not.toContain(writer);
    }
    expect(AUTOMERGE_CANARY_ENFORCE_SUPPORTED).toBe(false);
  });
});
