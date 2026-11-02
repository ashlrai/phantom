import { describe, expect, it } from 'vitest';
import type { DispatchManifestEvent, DispatchManifestEventsReadResult } from '../src/core/fleet/dispatch-manifest.js';
import { summarizeDispatchManifestEvidence } from '../src/core/fleet/dispatch-manifest-summary.js';

function event(id: string, overrides: Partial<DispatchManifestEvent> = {}): DispatchManifestEvent {
  return {
    schemaVersion: 1, manifestId: id, ts: '2026-10-30T10:00:00.000Z', mode: 'concurrent', dryRun: false,
    claimedItemIds: ['private-claimed', 'private-unassigned'],
    assignments: [{ itemId: 'private-claimed', source: 'issue', repo: 'private-repo', title: 'private-title', backend: 'codex' }],
    unassigned: [{ itemId: 'private-unassigned', reason: 'no-slots' }], slots: { codex: 1 },
    backendCounts: { codex: 1 }, counts: { claimed: 2, assigned: 1, unassigned: 1 }, ...overrides,
  };
}

function read(events: DispatchManifestEvent[] = [], overrides: Partial<DispatchManifestEventsReadResult> = {}): DispatchManifestEventsReadResult {
  return {
    events, sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
    filesRead: 0, bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 0, ...overrides,
  };
}

const zero = { manifests: 0, claimed: 0, assigned: 0, unassigned: 0, assignmentsByBackend: {} };

describe('dispatch manifest intent summary', () => {
  it('distinguishes healthy, missing and degraded empty evidence', () => {
    const healthy = summarizeDispatchManifestEvidence(read());
    expect(healthy).toMatchObject({ coverage: 'complete', total: zero, dryRun: zero, live: zero, earliestTimestamp: null, latestTimestamp: null });
    const missing = read([], { sourceState: 'missing', sourcePresent: false });
    expect(summarizeDispatchManifestEvidence(missing)).toMatchObject({ coverage: 'unknown', sourceQuality: { sourceState: 'missing', complete: true }, total: zero });
    const degraded = read([], { sourceState: 'degraded', complete: false, invalidRows: 2, unreadableFiles: 1, stopReasons: ['io-error'] });
    expect(summarizeDispatchManifestEvidence(degraded)).toMatchObject({ coverage: 'partial', sourceQuality: { invalidRows: 2, unreadableFiles: 1, stopReasons: ['io-error'] }, total: zero });
  });

  it('preserves every source-quality field for a truncated read and counts only observed evidence', () => {
    const input = read([event('one')], { sourceState: 'degraded', complete: false, stopReasons: ['file-limit', 'event-limit'], filesRead: 2, bytesRead: 456, rowsScanned: 3, invalidRows: 1, unreadableFiles: 0 });
    const { events: _events, ...quality } = input;
    const result = summarizeDispatchManifestEvidence(input);
    expect(result.sourceQuality).toEqual(quality);
    expect(result.coverage).toBe('partial');
    expect(result.total).toEqual({ manifests: 1, claimed: 2, assigned: 1, unassigned: 1, assignmentsByBackend: { codex: 1 } });
  });

  it('separates dry-run and live intent and counts assignments by backend', () => {
    const dry = event('dry', { dryRun: true, ts: '2026-10-30T09:00:00-02:00', assignments: [
      { itemId: 'item-1', source: 'todo', repo: 'repo', title: 'title', backend: 'claude' },
      { itemId: 'item-2', source: 'todo', repo: 'repo', title: 'title', backend: 'codex' },
    ], unassigned: [], claimedItemIds: ['item-1', 'item-2'] });
    const result = summarizeDispatchManifestEvidence(read([dry, event('live')]));
    expect(result.total).toEqual({ manifests: 2, claimed: 4, assigned: 3, unassigned: 1, assignmentsByBackend: { claude: 1, codex: 2 } });
    expect(result.dryRun).toEqual({ manifests: 1, claimed: 2, assigned: 2, unassigned: 0, assignmentsByBackend: { claude: 1, codex: 1 } });
    expect(result.live).toEqual({ manifests: 1, claimed: 2, assigned: 1, unassigned: 1, assignmentsByBackend: { codex: 1 } });
    expect(result).toMatchObject({ coverage: 'complete', earliestTimestamp: '2026-10-30T10:00:00.000Z', latestTimestamp: '2026-10-30T11:00:00.000Z' });
    expect(JSON.stringify(result)).not.toMatch(/private|item-1|item-2|"repo"|"title"/);
  });

  it('deduplicates equivalent records and excludes all variants of conflicting IDs regardless of order', () => {
    const first = event('duplicate');
    const reordered = { ...first, counts: { unassigned: 1, assigned: 1, claimed: 2 }, slots: { codex: 1 } };
    const conflict = event('conflict');
    const different = event('conflict', { dryRun: true });
    const events = [first, reordered, conflict, different, conflict, event('other')];
    const a = summarizeDispatchManifestEvidence(read(events));
    const b = summarizeDispatchManifestEvidence(read([...events].reverse()));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ coverage: 'partial', duplicateRows: 3, conflictingManifests: 1, total: { manifests: 2, claimed: 4, assigned: 2 }, dryRun: zero });
    expect(JSON.stringify(a)).not.toMatch(/"manifestId"|"duplicate"|"conflict"|private-claimed/);
  });

  it('keeps invalid timestamps out of bounds while reporting their uncertainty', () => {
    const invalid = event('bad-time', { ts: 'not a timestamp' });
    const valid = event('valid', { ts: '2026-09-01T00:00:00Z' });
    const result = summarizeDispatchManifestEvidence(read([invalid, valid]));
    expect(result).toMatchObject({ coverage: 'partial', invalidTimestampCount: 1, earliestTimestamp: '2026-09-01T00:00:00.000Z', latestTimestamp: '2026-09-01T00:00:00.000Z', total: { manifests: 2 } });
    expect(summarizeDispatchManifestEvidence(read([invalid]))).toMatchObject({ earliestTimestamp: null, latestTimestamp: null });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('does not mutate input and returns detached mutable output', () => {
    const input = read([event('one')], { stopReasons: ['row-limit'], complete: false, sourceState: 'degraded' });
    const before = structuredClone(input);
    const result = summarizeDispatchManifestEvidence(input);
    expect(input).toEqual(before);
    result.sourceQuality.stopReasons.push('io-error');
    result.total.assignmentsByBackend.codex = 99;
    result.dryRun.assignmentsByBackend.codex = 10;
    expect(input).toEqual(before);
    expect(result.live.assignmentsByBackend.codex).toBe(1);
    expect(summarizeDispatchManifestEvidence(input).total.assignmentsByBackend.codex).toBe(1);
  });
});
