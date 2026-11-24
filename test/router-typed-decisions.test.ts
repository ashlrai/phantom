import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { explainRoutes } from '../src/core/queue/route-explain.js';
import {
  foldTypedDecisions, readTypedDecisions, TYPED_DECISIONS_LEDGER_RELATIVE,
} from '../src/core/router/typed-decisions.js';

const ROW_SCHEMA = 'route.explain.v1';
const observed = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: ROW_SCHEMA, event: 'route.explain', ts: 1000.5, advisory: true,
  status: 'observed',
  decision: { lane: 'seat', model: 'gpt-6.1-sol', effort: 'medium', speed_tier: 'workhorse',
    reason_codes: ['cost-prior', 'free-capacity'] },
  duration_ms: 412, attempts: 1, candidate_count: 3,
  ...over,
});
const unavailable = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: ROW_SCHEMA, event: 'route.explain', ts: 1001, advisory: true,
  status: 'unavailable', ...over,
});

it('folds observed and unavailable journal rows into bounded tallies and metric summaries', () => {
  const text = [
    observed(),
    observed({ ts: 1002, decision: { lane: 'seat', model: 'gpt-6.1-sol', effort: 'high',
      speed_tier: 'premium', reason_codes: ['cost-prior', 'free-capacity', 'free-capacity'] },
      duration_ms: 788, candidate_count: 5 }),
    observed({ ts: 1003, decision: { lane: 'local', model: 'qwen3-coder', effort: 'low',
      speed_tier: 'everyday', reason_codes: ['local-fast'] }, duration_ms: 120 }),
    unavailable(),
    '',
  ].join('\n');
  const digest = foldTypedDecisions(text, '/runs/metrics/route.explain.jsonl', false);
  expect(digest).toMatchObject({
    schema: 'route.typed-decisions.v1', state: 'read', truncated: false,
    path: '/runs/metrics/route.explain.jsonl', records: 4, invalid_rows: 0,
    observed: 3, unavailable: 1, oldest_ts: 1000.5, newest_ts: 1003,
  });
  expect(digest.lanes).toEqual([{ key: 'seat', decisions: 2 }, { key: 'local', decisions: 1 }]);
  expect(digest.models).toEqual([{ key: 'gpt-6.1-sol', decisions: 2 }, { key: 'qwen3-coder', decisions: 1 }]);
  expect(digest.reason_codes).toEqual([
    { key: 'cost-prior', decisions: 2 }, { key: 'free-capacity', decisions: 2 },
    { key: 'local-fast', decisions: 1 },
  ]);
  expect(digest.duration_ms).toEqual({ known: 3, mean: 440, max: 788 });
  expect(digest.attempts).toEqual({ known: 3, mean: 1, max: 1 });
  expect(digest.candidate_count).toEqual({ known: 3, mean: 3.7, max: 5 });
});

it('keeps malformed metrics unrecorded without discarding the decision and counts contract violations as invalid rows', () => {
  const good = observed({ duration_ms: -4, attempts: 1.5, candidate_count: 1.5 });
  const digest = foldTypedDecisions([
    good,
    '{not json',
    JSON.stringify({ schema: 'other.v1', event: 'route.explain', ts: 1, advisory: true, status: 'observed' }),
    JSON.stringify({ schema: ROW_SCHEMA, event: 'route.explain', ts: 1, advisory: false, status: 'observed' }),
    JSON.stringify({ schema: ROW_SCHEMA, event: 'route.explain', ts: 'soon', advisory: true, status: 'observed' }),
    JSON.stringify({ schema: ROW_SCHEMA, event: 'route.explain', ts: 1, advisory: true, status: 'bogus' }),
    observed({ status: 'observed', decision: null }),
    observed({ decision: { lane: 'bad lane!', model: 'm', effort: 'low', speed_tier: 'everyday', reason_codes: ['local-fast'] } }),
    observed({ decision: { lane: 'seat', model: 'm', effort: 'extreme', speed_tier: 'everyday', reason_codes: ['local-fast'] } }),
    observed({ decision: { lane: 'seat', model: 'm', effort: 'low', speed_tier: 'galaxy', reason_codes: ['local-fast'] } }),
    observed({ decision: { lane: 'seat', model: 'm', effort: 'low', speed_tier: 'everyday', reason_codes: [] } }),
    observed({ decision: { lane: 'seat', model: 'm', effort: 'low', speed_tier: 'everyday', reason_codes: ['not-a-code'] } }),
    observed({ decision: { lane: 'seat', model: 'm', effort: 'low', speed_tier: 'everyday', reason_codes: ['local-fast'] },
      duration_ms: 'fast', attempts: -1, candidate_count: Number.MAX_SAFE_INTEGER + 1 }),
  ].join('\n'), '/x', true);
  expect(digest.records).toBe(2);
  expect(digest.invalid_rows).toBe(11);
  expect(digest.observed).toBe(2);
  expect(digest.truncated).toBe(true);
  // Every recorded metric on the two valid rows was malformed, so both stay unrecorded — never zeroed.
  expect(digest.duration_ms).toEqual({ known: 0, mean: null, max: null });
  expect(digest.attempts).toEqual({ known: 0, mean: null, max: null });
  expect(digest.candidate_count).toEqual({ known: 0, mean: null, max: null });
});

it('reports missing, non-file and symlinked journals as degraded states with empty tallies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'typed-decisions-'));
  try {
    const missing = await readTypedDecisions({ runsDir: root });
    expect(missing).toMatchObject({ state: 'missing', records: 0, observed: 0, unavailable: 0,
      lanes: [], duration_ms: { known: 0, mean: null, max: null },
      attempts: { known: 0, mean: null, max: null }, oldest_ts: null });
    await mkdir(join(root, 'metrics'));
    await mkdir(join(root, TYPED_DECISIONS_LEDGER_RELATIVE));
    expect((await readTypedDecisions({ runsDir: root })).state).toBe('not-file');
    await rm(join(root, TYPED_DECISIONS_LEDGER_RELATIVE), { recursive: true });
    const evidence = join(root, 'evidence.jsonl');
    await writeFile(evidence, observed());
    await symlink(evidence, join(root, TYPED_DECISIONS_LEDGER_RELATIVE));
    const linked = await readTypedDecisions({ runsDir: root });
    expect(linked.state).toBe('unreadable');
    expect(linked.records).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reads the journal tail with an honest truncation flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'typed-decisions-tail-'));
  try {
    await mkdir(join(root, 'metrics'));
    const path = join(root, TYPED_DECISIONS_LEDGER_RELATIVE);
    const first = observed({ ts: 1 });
    const second = unavailable({ ts: 2 });
    await writeFile(path, `${first}\n${second}\n`);
    const whole = await readTypedDecisions({ runsDir: root });
    expect(whole).toMatchObject({ state: 'read', truncated: false, records: 2, observed: 1, unavailable: 1 });
    // A tail window that starts mid-first-line drops the cut row and reports truncated.
    const cut = await readTypedDecisions({ runsDir: root, limit: second.length + 2 });
    expect(cut).toMatchObject({ state: 'read', truncated: true, records: 1, observed: 0, unavailable: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('surfaces the typed-decision digest on route explain without changing availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'typed-decisions-explain-'));
  try {
    const bare = await explainRoutes(root);
    expect(bare.typed_decisions).toMatchObject({ state: 'missing', records: 0 });
    expect(bare.available).toBe(false);
    await mkdir(join(root, 'metrics'));
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'metrics/route.explain.jsonl'), `${observed()}\n${unavailable()}\n`);
    await writeFile(join(root, 'queue/route-state.json'), '{}');
    const report = await explainRoutes(root);
    expect(report.available).toBe(true);
    expect(report.typed_decisions).toMatchObject({ schema: 'route.typed-decisions.v1', state: 'read',
      records: 2, observed: 1, unavailable: 1 });
    expect(report.typed_decisions?.lanes).toEqual([{ key: 'seat', decisions: 1 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
