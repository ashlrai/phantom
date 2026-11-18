import { expect, it } from 'vitest';
import { buildEmptiesReport, ledgerFinishes } from '../src/core/fleet/empties.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const row = (job: string, event: string, minute: number, extra: object = {}) =>
  JSON.stringify({ job, event, lane: 'codex', ts: new Date(now - minute * 60_000).toISOString(), ...extra });
const report = (lines: string[]) => buildEmptiesReport({
  ledger: ledgerFinishes(lines.join('\n'), now, 24), evidence: new Map(), hours: 24, metricsPath: 'fixture',
});

it.each([{}, { pool_error: '' }])('isolates a later completed retry with fields %j', fields => {
  const lines = [
    row('RQ-RETRY', 'launch', 10),
    row('RQ-RETRY', 'finish', 9, { empty: true, exit_code: 124, pool_error: 'failure', tokens_total: 500 }),
    row('RQ-OTHER', 'finish', 8, { empty: false, exit_code: 1, pool_error: 'other', tokens_total: 42 }),
    row('RQ-RETRY', 'launch', 7),
    row('RQ-RETRY', 'finish', 6, { empty: true, ...fields }),
  ];
  const ledger = ledgerFinishes(lines.join('\n'), now, 24);
  expect(ledger.finishes.find(finish => finish.id === 'RQ-RETRY')).toMatchObject({ tokens: null, exitCode: null, poolError: false });
  const result = report(lines);
  expect(result).toMatchObject({ finishes: 2, empties: 1, tokens: null, tokens_unknown_jobs: 1 });
  expect(result.reasons.find(reason => reason.reason === 'unknown')?.count).toBe(1);
  expect(result.reasons.find(reason => reason.reason === 'timeout')?.count).toBe(0);
  expect(result.reasons.find(reason => reason.reason === 'model_error')?.count).toBe(0);
});

it('enriches complementary rows within an attempt and retains the latest completed finish after a new launch', () => {
  const lines = [
    row('RQ-SAME', 'launch', 10),
    row('RQ-SAME', 'outcome', 9, { empty: true, exit_code: 1, pool_error: 'failure', tokens_total: 23 }),
    row('RQ-OTHER', 'finish', 8, { empty: true, tokens_total: 7 }),
    row('RQ-SAME', 'finish', 7, { empty: true }),
    row('RQ-SAME', 'launch', 6),
  ];
  expect(ledgerFinishes(lines.join('\n'), now, 24).finishes.find(finish => finish.id === 'RQ-SAME'))
    .toMatchObject({ tokens: 23, exitCode: 1, poolError: true });
  expect(report(lines)).toMatchObject({ finishes: 2, empties: 2, tokens: 30, tokens_unknown_jobs: 0 });
});

it('keeps malformed and unreadable evidence unknown', () => {
  const result = report(['{broken', row('RQ-UNKNOWN', 'finish', 2, { empty: true, tokens_total: 'bad', exit_code: 'bad' })]);
  expect(result).toMatchObject({ malformed_lines: 1, tokens: null, tokens_unknown_jobs: 1, notes_missing: 1 });
  expect(result.reasons.find(reason => reason.reason === 'unknown')?.count).toBe(1);
  expect(buildEmptiesReport({ ledger: null, evidence: new Map(), hours: 24, metricsPath: 'fixture' }))
    .toMatchObject({ metrics: 'unreadable', finishes: null, empties: null, tokens: null, malformed_lines: null });
});
