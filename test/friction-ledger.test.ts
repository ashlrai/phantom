/**
 * test/friction-ledger.test.ts — the phm friction miners, ledger fold and
 * CLI seams, all against fixtures in a temporary runs dir.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFrictionLedger, foldFrictionLedger, frictionNoteRow, frictionScanRow,
  mineFriction, readFrictionInput,
} from '../src/core/fleet/friction.js';
import { cmdFriction } from '../src/cli/friction.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString();
const local = (hAgo: number) => new Date(NOW - hAgo * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
const J = (o: object) => JSON.stringify(o);
const item = (report: ReturnType<typeof mineFriction>, id: string) => report.items.find(i => i.id === id)!;

const jobs = [
  J({ event: 'enqueue', job: 'RQ-A', lane: 'devin', tier: 'work', ts: iso(30) }),
  J({ event: 'enqueue', job: 'RQ-B', lane: 'devin', tier: 'work', ts: iso(10) }),
  J({ event: 'enqueue', job: 'RQ-C', lane: 'codex', tier: 'standard', ts: iso(2) }),   // invalid tier
  J({ event: 'finish', job: 'RQ-X', lane: 'devin', ts: iso(20), empty: true, exit_code: 0 }),
  J({ event: 'finish', job: 'RQ-Y', lane: 'devin', ts: iso(19), empty: false, exit_code: 3 }),
  J({ event: 'finish', job: 'RQ-Z', lane: 'claude', ts: iso(18), empty: false, pool_error: 'usage_limit' }),
  J({ event: 'finish', job: 'RQ-W', lane: 'devin', ts: iso(4), empty: false }),        // relogin after auth hold
  J({ event: 'autobackoff_hold', lane: 'devin', job: 'RQ-V', ts: iso(8), pattern: 'claude_auth_401', auth_failures: 2 }),
  J({ event: 'autobackoff_hold', lane: 'claude', job: 'RQ-U', ts: iso(7), pattern: 'usage_limit' }),
  J({ event: 'autobackoff_skip', lane: 'devin', job: 'RQ-T', ts: iso(6), pattern: 'usage_limit' }),
  J({ event: 'precheck_parked', job: 'RQ-S', lane: 'devin', ts: iso(5), code: 13 }),
].join('\n');
const events = [
  `${local(15)} LAUNCH_DEFERRED RQ-1 PAUSED (requeued)`,
  `${local(14)} USAGE_LIMIT_SEEN codex RQ-2 codex_usage_limit: provider named the reset`,
  `${local(13)} AUTH_FAILURE_SEEN claude RQ-3 claude_auth_401: run produced work, no hold`,
  `${local(12)} LANE_HOLD devin autobackoff pattern=claude_auth_401 job=RQ-4 until=x src=default`,
  `${local(11)} LANE_HOLD claude credits exhausted (credits_exhausted); supervisor clears held`,
  `${local(10)} ROUTE RQ-5 devin->codex-personal`,
  `${local(9)} PARKED-DEP RQ-6 deps=RQ-7,RQ-8`,
  `${local(200)} ROUTE RQ-9 old->older`,   // outside the 7d window
].join('\n');
const ready = [
  'RQ-A\tphantom\tdevin\twork\tqueue/prompts/RQ-A.md',          // enqueue 30h ago, no launch: stale
  'RQ-B\tphantom\tdevin\twork\tqueue/prompts/RQ-B.md',          // 10h, no launch: stale
  'RQ-C\tphantom\tdevin\tplatinum\tqueue/prompts/RQ-C.md',      // invalid tier
  'PARKED-DEP.devin\tRQ-6\tdevin\twork\tphantom\tqueue/prompts/RQ-6.md',
  'RQ-NEW\tphantom\tdevin\twork\tqueue/prompts/RQ-NEW.md',      // never enqueued: age unknown
].join('\n');
const guardian = J({ 'ashlrai/phantom': { state: 'red', red_first: iso(26), attempts: 2, cur_job: 'RQ-FIX-1' }, 'ashlrai/locus': { state: 'green' } });
const slots = J({ devin: { held: true, held_by: 'autobackoff', held_until: iso(-1) }, claude: { held: true, held_by: 'phantom mason 2026-11-03' }, 'codex-personal': { target: 10 } });

function fixture(over: Partial<Parameters<typeof mineFriction>[0]> = {}) {
  return mineFriction({ jobs, events, ready, guardian, slots, overrides: J({ devin: { floor: 3 } }), keep: 'RQ-KEPT\nRQ-A\n', now: NOW, ...over });
}

describe('phm friction miners', () => {
  it('counts 7d signals per item with evidence and score ordering', () => {
    const r = fixture();
    expect(r.schema).toBe('phm.friction.v1');
    expect(item(r, 'empty-finishes').signals).toMatchObject({ bad: 3, empty: 1, refused: 1, failed: 1 });
    expect(item(r, 'requeues').signals.requeued).toBe(1);
    expect(item(r, 'lane-auth').signals).toMatchObject({ auth_failures: 2, auth_holds: 1, relogins: 1 });
    expect(item(r, 'quota-exhaustion').signals).toMatchObject({ usage_limits: 5, finish_errors: 1, credit_holds: 1, backoff_holds: 1 });
    expect(item(r, 'invalid-tier').signals).toMatchObject({ ready_rows: 1, enqueued: 1 });
    expect(item(r, 'red-main').signals).toMatchObject({ repos_red: 1, max_red_hours: 26 });
    expect(item(r, 'stale-ready').signals).toMatchObject({ unclaimed: 2, unknown_age: 1 });
    expect(item(r, 'manual-interventions').signals).toMatchObject({ manual_holds: 1, budget_overrides: 1, kept_jobs: 2 });
    expect(item(r, 'wrong-route').signals).toMatchObject({ route_moves: 1, route_holds: 0 });
    expect(item(r, 'holds').signals).toMatchObject({ hold_events: 4, lanes_held: 2, parked_rows: 1, precheck_parks: 1 });
    expect(item(r, 'empty-finishes').evidence[0]).toContain('jobs.jsonl');
    expect(item(r, 'empty-finishes').score).toBe(13.5);  // 3 unlock x 3 bad x 3 blast / 2 cost
    expect(r.items[0]!.score ?? -1).toBeGreaterThanOrEqual(r.items.at(-1)!.score ?? -1);
  });
  it('keeps signals unknown (null), never zero, when sources are missing', () => {
    const r = mineFriction({ now: NOW });
    expect(item(r, 'empty-finishes').signals.bad).toBeNull();
    expect(item(r, 'empty-finishes').score).toBeNull();
    expect(item(r, 'empty-finishes').status).toBe('quiet');
    expect(r.sources['metrics/jobs.jsonl']).toBe('missing');
  });
  it('reports real zeros from read sources and ignores stale events', () => {
    const r = fixture({ jobs: J({ event: 'finish', job: 'RQ-1', ts: iso(200), empty: true }) });
    expect(item(r, 'empty-finishes').signals.bad).toBe(0);
    expect(item(r, 'wrong-route').signals.route_moves).toBe(1); // the 200h-old ROUTE line is not counted
  });
  it('scrubs secret-shaped text out of evidence', () => {
    const token = 'sk-ant-' + 'a1'.repeat(30);
    const r = fixture({ events: `${local(1)} AUTH_FAILURE_SEEN claude RQ-3 ${token}: refused` });
    expect(JSON.stringify(r.items)).not.toContain(token);
  });
});

describe('phm friction ledger', () => {
  it('appends a scan row only when counts change, and folds before/after', () => {
    const report = fixture();
    const fold = foldFrictionLedger('');
    const row = frictionScanRow(report, fold, NOW);
    expect(row).not.toBeNull();
    const folded = foldFrictionLedger(row!);
    expect(foldFrictionLedger(JSON.stringify({ kind: 'scan', ts: iso(50), items: { holds: 9 } }) + '\n' + row!)
      .scans.get('holds')).toMatchObject({ before: 9, after: 4 });
    expect(frictionScanRow(report, folded, NOW + 1000)).toBeNull();
  });
  it('folds notes into owner/status, marks fixed+recurring as regressed', () => {
    const ledger = [
      J({ kind: 'note', ts: iso(3), item: 'holds', status: 'in-progress', owner: 'core' }),
      J({ kind: 'note', ts: iso(2), item: 'empty-finishes', status: 'fixed' }),
      J({ kind: 'bogus' }), 'not json',
    ].join('\n');
    const r = fixture({ ledger });
    expect(item(r, 'holds')).toMatchObject({ status: 'in-progress', owner: 'core' });
    expect(item(r, 'empty-finishes').status).toBe('regressed');
    expect(item(r, 'requeues').status).toBe('open');
  });
  it('validates note rows against the item catalog', () => {
    expect(frictionNoteRow('holds', 'fixed', 'core', NOW)).toContain('"item":"holds"');
    expect(frictionNoteRow('nope', 'fixed', undefined, NOW)).toBeNull();
    expect(frictionNoteRow('holds', 'done', undefined, NOW)).toBeNull();
    expect(frictionNoteRow('holds', 'fixed', 'bad/slash', NOW)).toBeNull();
  });
});

describe('phm friction command', () => {
  it('reads a runs dir, appends the ledger and prints the report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'friction-'));
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'guardian'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs);
    await writeFile(join(dir, 'queue', 'dispatch-events.log'), events);
    await writeFile(join(dir, 'queue', 'ready.tsv'), ready);
    await writeFile(join(dir, 'guardian', 'state.json'), guardian);
    const input = await readFrictionInput(dir);
    const report = mineFriction({ ...input, now: NOW });
    expect(item(report, 'invalid-tier').signals.ready_rows).toBe(1);
    const row = frictionScanRow(report, foldFrictionLedger(input.ledger ?? ''), NOW);
    await appendFrictionLedger(dir, [row!]);
    const ledger = await readFile(join(dir, 'friction', 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('"kind":"scan"');
    const notes = await cmdFriction(['note', 'holds', '--status', 'in-progress', '--owner', 'core', '--runs-dir', dir, '--json']);
    expect(notes).toBe(0);
    expect(await readFile(join(dir, 'friction', 'ledger.jsonl'), 'utf8')).toContain('"kind":"note"');
    expect(await cmdFriction(['note', 'holds', '--status', 'bogus', '--runs-dir', dir])).toBe(2);
    expect(await cmdFriction(['--runs-dir'])).toBe(2);
  });
});

it('reports large and inconsistent finish diffs without guessing their cause', () => {
  const ts = new Date().toISOString();
  const jobs = [
    { event: 'finish', job: 'RQ-LARGE', ts, diff_files: 2, diff_lines: 500, empty: false },
    { event: 'finish', job: 'RQ-INCONSISTENT', ts, diff_files: 0, diff_lines: 1, empty: true },
    { event: 'finish', job: 'RQ-NORMAL', ts, diff_files: 1, diff_lines: 10, empty: false },
  ].map(row => JSON.stringify(row)).join('\n');
  const item = mineFriction({ jobs }).items.find(row => row.id === 'anomalous-diffs');
  expect(item?.signals.finishes).toBe(2);
  expect(item?.evidence).toHaveLength(2);
  expect(mineFriction({}).items.find(row => row.id === 'anomalous-diffs')?.signals.finishes).toBeNull();
});
