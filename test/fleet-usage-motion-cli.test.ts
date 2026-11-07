/**
 * RQ-PHX-ZEROWASTEAUDIT31 — `ashlr fleet usage-audit` usage-motion audit.
 *
 * Contract: two distinct valid readings spanning ≥60m (latest ≤15m old) are
 * required before the audit may assert a lane's meter moved, idled or
 * stalled. An unchanged meter with queued/live work is a proven `incident`
 * (exit 1); missing/stale/single/conflicting/malformed evidence is
 * `insufficient-evidence` (exit 2); `moving`/`idle`/`reset-observed` are
 * definite non-incident results (exit 0). The command is read-only: input
 * files are byte-identical after a run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditUsageMotion, type UsageMotionAuditView } from '../src/core/fleet/usage-motion-audit.js';
import { cmdFleet } from '../src/cli/fleet.js';

let queueDir: string;
let scratch: string;
const t0 = Date.now();
const iso = (min: number) => new Date(t0 - min * 60_000).toISOString();
const reading = (pool: string, pctUsed: number, min: number, resetAt: string | null = '2030-01-01T00:00:00Z') =>
  JSON.stringify({ pool, pctUsed, resetAt, source: 'test-probe', fetchedAt: iso(min), writtenAt: iso(min) });
/** Canonical lanes the snapshot always projects; rising readings keep them provably `moving`. */
const canon = ['codex-cmp', 'codex-personal', 'devin', 'claude', 'grok-build', 'local-omlx', 'grok-ultra']
  .map(p => [reading(p, 10, 75), reading(p, 14, 5)].join('\n')).join('\n');

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'usage-motion-'));
  queueDir = join(scratch, 'queue');
  await mkdir(queueDir, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

const put = (name: string, text: string) => writeFile(join(queueDir, name), text);

/** Run the real CLI entry point; parse --json output when asked. */
async function runAudit(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const code = await cmdFleet(['usage-audit', ...args]);
  const out = log.mock.calls.map(c => String(c[0])).join('\n');
  const errText = err.mock.calls.map(c => String(c[0])).join('');
  return { code, out, err: errText, json: args.includes('--json') ? JSON.parse(out) as UsageMotionAuditView : null };
}

const laneOf = (json: UsageMotionAuditView, lane: string) => json.lanes.find(l => l.lane === lane)!;

describe('fleet usage-audit', () => {
  it('proves an unchanged-hour incident with queued/live work (exit 1), names it in text, and never touches inputs', async () => {
    const files = {
      'ready.tsv': 'id\tstatus\tpool\nRQ-FAKE-001\tREADY\tlane-alpha\n',
      'queue.v1.json': JSON.stringify({ schema: 'queue.v1', jobs: [{ id: 'RQ-FAKE-002', status: 'CLAIMED', pool: 'lane-alpha' }] }),
      'usage-readings.log': [reading('lane-alpha', 40, 75), reading('lane-alpha', 40, 62), reading('lane-alpha', 40, 3)].join('\n') + '\n',
    };
    for (const [n, t] of Object.entries(files)) await put(n, t);
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(1); // incident wins even though canonical lanes lack evidence
    expect(json!.schema).toBe('fleet.usage-motion.v1');
    expect(json!.incidents).toBe(1);
    expect(json!.lanes[0]).toMatchObject({ // incidents sort first
      lane: 'lane-alpha', classification: 'incident', queued: 1, live: 1,
      readings: 3, pctUsedFirst: 40, pctUsedLast: 40, pctUsedDelta: 0,
    });
    expect(json!.lanes[0]!.observedMinutes).toBeGreaterThanOrEqual(60);
    expect(json!.lanes[0]!.nextAction).toContain('fleet lanes');
    const human = await runAudit(['--queue-dir', queueDir]);
    expect(human.code).toBe(1);
    expect(human.out).toContain('INCIDENT');
    expect(human.out).toContain('lane-alpha');
    expect(human.out).toContain('used 40%→40%');
    expect(human.out).toContain('ashlr fleet doctor');
    expect(human.out).toContain('remaining quota is not consumption evidence');
    for (const [n, t] of Object.entries(files)) {
      expect(await readFile(join(queueDir, n), 'utf8')).toBe(t);
    }
  });

  it('classifies moving, idle and reset-observed lanes in one fully observed audit (exit 0)', async () => {
    await put('ready.tsv', 'id\tstatus\tpool\nRQ-B9\tDONE\tlane-beta\nRQ-G1\tREADY\tlane-gamma\nRQ-D1\tDONE\tlane-delta\n');
    await put('usage-readings.log', [
      canon,
      reading('lane-beta', 40, 80), reading('lane-beta', 55, 4),           // moving, empty queue
      reading('lane-gamma', 20, 90), reading('lane-gamma', 28, 5),          // moving, work queued
      reading('lane-delta', 12, 70), reading('lane-delta', 12, 6),          // idle, empty queue
      reading('lane-epsilon', 80, 70, '2030-01-01T00:00:00Z'),              // reset boundary crossed
      reading('lane-epsilon', 12, 4, '2030-01-02T00:00:00Z'),
    ].join('\n') + '\n');
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(0);
    expect(laneOf(json!, 'lane-beta')).toMatchObject({ classification: 'moving', pctUsedDelta: 15, queued: 0, live: 0 });
    expect(laneOf(json!, 'lane-gamma')).toMatchObject({ classification: 'moving', pctUsedDelta: 8, queued: 1 });
    expect(laneOf(json!, 'lane-delta')).toMatchObject({ classification: 'idle', pctUsedDelta: 0 });
    const eps = laneOf(json!, 'lane-epsilon');
    expect(eps.classification).toBe('reset-observed');
    expect(eps.pctUsedDelta).toBeNull(); // different reset windows are never subtracted
    expect(eps.resetBoundary).toBe('2030-01-02T00:00:00Z');
  });

  it('reports insufficient-evidence (exit 2) for stale, single and missing journal evidence', async () => {
    await put('ready.tsv', 'id\tstatus\tpool\nRQ-F1\tREADY\tlane-stale\nRQ-F2\tREADY\tlane-single\nRQ-F3\tREADY\tlane-none\n');
    await put('usage-readings.log', [
      reading('lane-stale', 40, 80), reading('lane-stale', 40, 20), // latest 20m > 15m bound
      reading('lane-single', 40, 2),
    ].join('\n') + '\n');
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(2);
    for (const lane of ['lane-stale', 'lane-single', 'lane-none']) {
      expect(laneOf(json!, lane).classification).toBe('insufficient-evidence');
    }
    expect(laneOf(json!, 'lane-stale').reason).toContain('20m old');
  });

  it('reports a missing journal explicitly', async () => {
    await put('ready.tsv', 'id\tstatus\tpool\nRQ-F4\tREADY\tlane-none\n');
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(2);
    expect(json!.sources.usageJournal.state).toBe('missing');
    expect(json!.lanes.every(l => l.classification === 'insufficient-evidence')).toBe(true);
  });

  it('marks malformed and conflicting rows insufficient, never healthy, and flags the journal degraded', async () => {
    const journal = [
      reading('lane-zeta', 40, 70), reading('lane-zeta', 40, 4),
      JSON.stringify({ pool: 'lane-zeta', pctUsed: 150, fetchedAt: iso(30) }),
      'not json at all',
      reading('lane-eta', 40, 70), JSON.stringify({ pool: 'lane-eta', pctUsed: 41, fetchedAt: iso(70) }),
      reading('lane-eta', 40, 4),
    ].join('\n') + '\n';
    await put('usage-readings.log', journal);
    await put('ready.tsv', 'id\tstatus\tpool\nRQ-F5\tREADY\tlane-zeta\nRQ-F6\tREADY\tlane-eta\n');
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(2);
    expect(json!.sources.usageJournal.state).toBe('degraded');
    expect(laneOf(json!, 'lane-zeta')).toMatchObject({ classification: 'insufficient-evidence', droppedReadings: 1 });
    expect(laneOf(json!, 'lane-eta')).toMatchObject({ classification: 'insufficient-evidence', conflicts: 1 });
    expect(await readFile(join(queueDir, 'usage-readings.log'), 'utf8')).toBe(journal);
  });

  it('keeps a journal-only lane with null queue counts and never guesses its work state', async () => {
    await put('usage-readings.log', [reading('lane-theta', 60, 72), reading('lane-theta', 60, 3)].join('\n') + '\n');
    const { code, json } = await runAudit(['--queue-dir', queueDir, '--json']);
    expect(code).toBe(2);
    expect(laneOf(json!, 'lane-theta'))
      .toMatchObject({ classification: 'insufficient-evidence', queued: null, live: null });
  });

  it('exits 2 on a relative or missing --queue-dir and on unknown options', async () => {
    expect((await runAudit(['--queue-dir', 'relative/dir'])).code).toBe(2);
    expect((await runAudit(['--queue-dir', 'relative/dir'])).err).toContain('absolute path');
    expect((await runAudit(['--queue-dir'])).code).toBe(2);
    expect((await runAudit(['--bogus'])).code).toBe(2);
    expect((await runAudit(['--bogus'])).err).toContain('unknown option');
  });

  it('--help prints usage and performs no I/O', async () => {
    const { code, out } = await runAudit(['--help', '--queue-dir', 'relative/dir']);
    expect(code).toBe(0); // help beats argument validation and never reads the dir
    expect(out).toContain('usage-audit');
    expect(out).toContain('fleet');
  });
});

describe('auditUsageMotion clock seam', () => {
  it('uses the injected clock for freshness and span decisions', async () => {
    const anchor = new Date('2026-10-31T23:00:00Z');
    const stamp = (min: number) => new Date(anchor.getTime() - min * 60_000).toISOString();
    const row = (pct: number, min: number) =>
      JSON.stringify({ pool: 'lane-iota', pctUsed: pct, resetAt: null, fetchedAt: stamp(min) });
    await put('ready.tsv', 'id\tstatus\tpool\nRQ-F9\tREADY\tlane-iota\n');
    await put('usage-readings.log', [row(30, 75), row(30, 10)].join('\n') + '\n');
    const audit = await auditUsageMotion({ queueDir, now: () => anchor });
    expect(audit.generatedAt).toBe(anchor.toISOString());
    expect(laneOf(audit, 'lane-iota')).toMatchObject({ classification: 'incident', observedMinutes: 65 });
    // Ten minutes later the newest reading is 20m old — past the 15m bound.
    const stale = await auditUsageMotion({ queueDir, now: () => new Date(anchor.getTime() + 10 * 60_000) });
    expect(laneOf(stale, 'lane-iota').classification).toBe('insufficient-evidence');
  });
});
