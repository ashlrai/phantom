import { describe, expect, it } from 'vitest';
import { FLEET_KEPT_SCHEMA, summarizeFleetKept } from '../src/cli/fleet-kept.js';

const J1 = 'RQ-PHX-FAKEJOB01';
const J2 = 'RQ-PHX-FAKEJOB02';
const J3 = 'RQ-PHX-FAKEJOB03';
const J4 = 'RQ-PHX-FAKEJOB04';
const J5 = 'RQ-PHX-FAKEJOB05';

const ledger = (...lines: (Record<string, unknown> | string)[]) =>
  lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');

describe('summarizeFleetKept edge cases', () => {
  it('marks a kept id with no ledger row as unknown', () => {
    const text = ledger(
      { job: 'RQ-PHX-OTHERJOB99', class: 'abort_push', ts: '2026-11-04T01:00:00Z' },
      { job: J1, class: 'abort_pr', ts: '2026-11-04T01:00:00Z' },
    );
    const report = summarizeFleetKept([J2, J1], text);
    expect(report.reasons).toEqual([
      { reason: 'abort_pr', count: 1, oldest: [J1] },
      { reason: 'unknown', count: 1, oldest: [J2] },
    ]);
  });

  it('ignores rows with an empty or missing class so an older classed row still counts', () => {
    const text = ledger(
      { job: J1, class: 'abort_push', ts: '2026-11-04T01:00:00Z' },
      { job: J1, class: '', ts: '2026-11-04T03:00:00Z' },
      { job: J1, ts: '2026-11-04T04:00:00Z' },
      { job: J1, class: '   ', ts: '2026-11-04T05:00:00Z' },
      { job: J2, class: '', ts: '2026-11-04T01:00:00Z' },
      { job: J2, ts: '2026-11-04T02:00:00Z' },
      { job: J3, class: 42, ts: '2026-11-04T01:00:00Z' },
    );
    const report = summarizeFleetKept([J1, J2, J3], text);
    expect(report.reasons).toEqual([
      { reason: 'abort_push', count: 1, oldest: [J1] },
      { reason: 'unknown', count: 2, oldest: [J2, J3] },
    ]);
  });

  it('lets the newest ts win even when the newer row is earlier in the file', () => {
    const text = ledger(
      { job: J1, class: 'empty', ts: '2026-11-04T05:00:00Z' },
      { job: J1, class: 'abort_push', ts: '2026-11-04T01:00:00Z' },
    );
    expect(summarizeFleetKept([J1], text).reasons).toEqual([
      { reason: 'empty', count: 1, oldest: [J1] },
    ]);
  });

  it('maps a class outside abort_push/abort_pr/empty to other', () => {
    const text = ledger(
      { job: J1, class: 'needs_human', ts: '2026-11-04T01:00:00Z' },
      { job: J2, class: ' abort_pr ', ts: '2026-11-04T01:00:00Z' },
    );
    const report = summarizeFleetKept([J1, J2], text);
    expect(report.reasons).toEqual([
      { reason: 'abort_pr', count: 1, oldest: [J2] },
      { reason: 'other', count: 1, oldest: [J1] },
    ]);
  });

  it('accepts job_id when job is missing', () => {
    const text = ledger(
      { job_id: J1, class: 'abort_pr', ts: '2026-11-04T01:00:00Z' },
      { job: J2, job_id: 'RQ-PHX-FAKEJOB99', class: 'empty', ts: '2026-11-04T01:00:00Z' },
      { job: null, job_id: J3, class: 'merged_ok', ts: '2026-11-04T01:00:00Z' },
    );
    const report = summarizeFleetKept([J1, J2, J3], text);
    expect(report.reasons).toEqual([
      { reason: 'abort_pr', count: 1, oldest: [J1] },
      { reason: 'empty', count: 1, oldest: [J2] },
      { reason: 'other', count: 1, oldest: [J3] },
    ]);
  });

  it('skips malformed JSON lines without throwing', () => {
    const text = ledger(
      'not json at all',
      '{"job":"RQ-PHX-FAKEJOB01","class":"abort_push"',
      '   ',
      '123',
      'null',
      '[1,2,3]',
      '"a bare string"',
      { job: J1, class: 'abort_push', ts: '2026-11-04T01:00:00Z' },
      { job: J2, class: 'empty', ts: '2026-11-04T02:00:00Z' },
      '{oops',
    );
    expect(() => summarizeFleetKept([J1, J2], text)).not.toThrow();
    const report = summarizeFleetKept([J1, J2], text);
    expect(report.reasons).toEqual([
      { reason: 'abort_push', count: 1, oldest: [J1] },
      { reason: 'empty', count: 1, oldest: [J2] },
    ]);
  });

  it('caps oldest at 3 ids, oldest first, with ids lacking a ts sorted last by name', () => {
    const text = ledger(
      { job: J1, class: 'empty', ts: '2026-11-04T02:00:00Z' },
      { job: J2, class: 'empty', ts: '2026-11-04T01:00:00Z' },
      { job: J3, class: 'empty', ts: 'not-a-date' },
      { job: J4, class: 'empty' },
      { job: J5, class: 'empty', ts: 1720000000000 },
    );
    const report = summarizeFleetKept([J5, J4, J3, J1, J2], text);
    const empty = report.reasons.find(g => g.reason === 'empty');
    expect(empty).toEqual({ reason: 'empty', count: 5, oldest: [J2, J1, J3] });
  });

  it('omits zero-member groups and reports kept as the input length', () => {
    const text = ledger(
      { job: J1, class: 'abort_pr', ts: '2026-11-04T01:00:00Z' },
      { job: J2, class: 'empty', ts: '2026-11-04T01:00:00Z' },
    );
    const kept = [J1, J2, J3];
    const report = summarizeFleetKept(kept, text);
    expect(report.schema).toBe(FLEET_KEPT_SCHEMA);
    expect(report.readOnly).toBe(true);
    expect(report.kept).toBe(kept.length);
    expect(report.reasons.map(g => g.reason)).toEqual(['abort_pr', 'empty', 'unknown']);
    expect(report.reasons.every(g => g.count > 0 && g.oldest.length >= 1 && g.oldest.length <= 3)).toBe(true);
  });
});
