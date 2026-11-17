/** RQ-PHX-HISTORYRETENTIONCLI342S: end-to-end qualification of recheck-history
 * retention. RECHECK_LOG_MAX_LINES+2 synthetic fixed-clock observations go
 * through the real appendRecheckRecord, then `fleet recheck-record --last 2
 * --json --envelope` reads the real store. Proves the newest rows survive in
 * newest-first order, the oldest rows are gone from disk, a current BLOCKED
 * verdict is never upgraded by an older row's lastVerified evidence, and a
 * fresh root reads as absent rather than as successful history. Every root is
 * a fresh temp dir; no real host, ledger or channel is read. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import type { FleetRecheck, FleetRecheckState } from '../src/core/fleet/fleet-recheck.js';
import {
  appendRecheckRecord, RECHECK_LOG_MAX_LINES, recheckLogPath,
  type ReadRecords, type RecheckRecord,
} from '../src/core/fleet/recheck-record.js';

const HOME = '/home/fakeuser';
const BASE_MS = Date.parse('2026-11-14T00:00:00.000Z');
const asOfAt = (i: number): string => new Date(BASE_MS + i * 60_000).toISOString();

const TOTAL = RECHECK_LOG_MAX_LINES + 2;
const NEWEST = TOTAL - 1; // current observation: BLOCKED, no current owner or task
const DONE = TOTAL - 2; // older retained row carrying a lastVerified triple
const DONE_ID = `fake-done-${DONE}`;
const DONE_OWNER = 'fake-owner-a';

type Kind = 'routine' | 'done' | 'blocked';
const kindOf = (i: number): Kind => (i === NEWEST ? 'blocked' : i === DONE ? 'done' : 'routine');

/** Synthetic verdict for observation i. Routine rows are UNKNOWN with one
 * missing reason per section, each naming i, so retention can be checked per
 * section. The done row is VERIFIED with a lastVerified triple and no current
 * task. The blocked row is BLOCKED with no current task, owner or lastVerified. */
function observation(i: number): FleetRecheck {
  const kind = kindOf(i);
  const asOf = asOfAt(i);
  const routine = kind === 'routine';
  const blocked = kind === 'blocked';
  const reasons = (section: string): string[] => (routine ? [`${section} reason ${i}`] : []);
  const taskReasons = blocked ? [`task reason ${i}`] : reasons('task');
  const overallState: FleetRecheckState = routine ? 'UNKNOWN' : blocked ? 'BLOCKED' : 'VERIFIED';
  const taskState: FleetRecheckState = routine ? 'UNKNOWN' : blocked ? 'BLOCKED' : 'VERIFIED';
  const otherState: FleetRecheckState = routine ? 'UNKNOWN' : 'VERIFIED';
  const lastVerified = kind === 'done'
    ? { id: DONE_ID, owner: DONE_OWNER, claimReceipt: 'fake-receipt-1', asOf: asOfAt(i - 1), source: 'fake-source-1' }
    : null;
  const overallMissing = [
    ...reasons('runtime'), ...reasons('claims'), ...reasons('bridge'), ...taskReasons,
  ];
  return {
    schema: 'fleet.recheck.v1',
    asOf,
    sections: {
      runtime: {
        state: otherState, source: 'fake-runtime', asOf, host: 'fake-host', platform: 'fakeos',
        tailnetName: 'fake-tailnet-node', installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
        fleetState: { path: 'fake-state.json', mtime: asOf, ageSeconds: 60, stale: false },
        reasons: [], missing: reasons('runtime'),
      },
      claims: {
        state: otherState, source: 'fake-claims', asOf, active: 0, expiredClaims: 0,
        top: [], claims: [], missing: reasons('claims'),
      },
      bridge: {
        state: otherState, source: 'fake-bridge', asOf, channels: [],
        missingBridge: routine ? `bridge reason ${i}` : null, missing: reasons('bridge'),
      },
      task: {
        state: taskState, source: 'fake-task', asOf, task: null, unowned: 0, unclaimed: 0,
        lastVerified, liveWorker: null, missing: taskReasons,
      },
    },
    overall: { state: overallState, missing: overallMissing },
  };
}

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recheck-retention-342s-'));
  roots.push(dir);
  return dir;
}

/** Runs the real CLI handler and captures what it printed. */
async function run(root: string, args: string[]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetRecheckRecord(args, { root });
    return {
      code,
      stdout: out.mock.calls.map(call => String(call[0])),
      stderr: err.mock.calls.map(call => String(call[0])),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const ENVELOPE = ['--last', '2', '--json', '--envelope'];
let store: string;

beforeAll(() => {
  store = freshRoot();
  for (let i = 0; i < TOTAL; i++) {
    const res = appendRecheckRecord(store, observation(i), HOME);
    if (!res.ok) throw new Error(`append ${i} failed: ${res.reason}`);
  }
}, 60_000);

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('recheck history retention through the real store and CLI', () => {
  it('keeps exactly the newest RECHECK_LOG_MAX_LINES rows on disk and removes the oldest two', () => {
    const lines = readFileSync(recheckLogPath(store), 'utf8').split('\n').filter(l => l !== '');
    expect(lines).toHaveLength(RECHECK_LOG_MAX_LINES);
    const rows = lines.map(l => JSON.parse(l) as RecheckRecord);
    const asOfs = rows.map(r => r.asOf);
    expect(asOfs[0]).toBe(asOfAt(2));
    expect(asOfs.at(-1)).toBe(asOfAt(NEWEST));
    expect(asOfs).not.toContain(asOfAt(0));
    expect(asOfs).not.toContain(asOfAt(1));
    expect(new Set(asOfs).size).toBe(RECHECK_LOG_MAX_LINES);
    // Oldest-retained row keeps its per-section reasons and timestamps intact.
    expect(rows[0]!.sections.missing).toEqual({
      overall: ['runtime reason 2', 'claims reason 2', 'bridge reason 2', 'task reason 2'],
      runtime: ['runtime reason 2'], claims: ['claims reason 2'], bridge: ['bridge reason 2'], task: ['task reason 2'],
    });
    expect(rows[0]!.sections.runtime.asOf).toBe(asOfAt(2));
    expect(rows[0]!.sections.task.lastVerified).toBeNull();
    // Evicted observations leave no trace of their reasons in the log.
    expect(readFileSync(recheckLogPath(store), 'utf8')).not.toMatch(/ reason [01]"/);
  });

  it('returns exactly the newest two rows, newest first, with ok outcome and no skips', async () => {
    const res = await run(store, ENVELOPE);
    expect(res.code).toBe(0);
    expect(res.stderr).toEqual([]);
    expect(res.stdout).toHaveLength(1);
    const env = JSON.parse(res.stdout[0]!) as ReadRecords;
    expect(Object.keys(env).sort()).toEqual(['missing', 'outcome', 'rows', 'skipped']);
    expect(env.outcome).toBe('ok');
    expect(env.skipped).toBe(0);
    expect(env.missing).toBe(false);
    expect(env.rows.map(r => r.asOf)).toEqual([asOfAt(NEWEST), asOfAt(DONE)]);
  });

  it('keeps the current BLOCKED verdict BLOCKED and never promotes an older lastVerified triple', async () => {
    const env = JSON.parse((await run(store, ENVELOPE)).stdout[0]!) as ReadRecords;
    const [current, older] = env.rows as [RecheckRecord, RecheckRecord];
    expect(current.overall).toBe('BLOCKED');
    expect(current.sections.task).toMatchObject({
      state: 'BLOCKED', id: null, owner: null, claimReceipt: null, lastVerified: null,
    });
    expect(current.sections.missing).toEqual({
      overall: [`task reason ${NEWEST}`], runtime: [], claims: [], bridge: [], task: [`task reason ${NEWEST}`],
    });
    expect(JSON.stringify(current)).not.toContain(DONE_ID);
    expect(JSON.stringify(current)).not.toContain(DONE_OWNER);
    // The older row keeps its own VERIFIED verdict and its own evidence triple,
    // without the claimReceipt or source the record never retains.
    expect(older.overall).toBe('VERIFIED');
    expect(older.sections.task.lastVerified).toEqual({ id: DONE_ID, owner: DONE_OWNER, asOf: asOfAt(DONE - 1) });
    expect(older.sections.task.lastVerified).not.toHaveProperty('claimReceipt');
    expect(older.sections.task.lastVerified).not.toHaveProperty('source');
    expect(older.sections.task).toMatchObject({ id: null, owner: null });
  });

  it('prints the human rows with the current BLOCKED reason and no promoted evidence', async () => {
    const res = await run(store, ['--last', '2']);
    expect(res.code).toBe(0);
    expect(res.stdout).toEqual([
      `${asOfAt(NEWEST)} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=BLOCKED missing=task reason ${NEWEST}`,
      `${asOfAt(DONE)} VERIFIED runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=VERIFIED`,
    ]);
    expect(res.stdout.join('\n')).not.toContain(DONE_ID);
  });

  it('reads a fresh root as absent history, distinct from retained successful history', async () => {
    const fresh = freshRoot();
    const absent = await run(fresh, ENVELOPE);
    expect(absent.code).toBe(0);
    expect(absent.stderr).toEqual([]);
    const absentEnv = JSON.parse(absent.stdout[0]!) as Record<string, unknown>;
    expect(absentEnv).toEqual({ rows: [], skipped: 0, missing: true });
    expect(absentEnv).not.toHaveProperty('outcome');
    expect(existsSync(recheckLogPath(fresh))).toBe(false);

    const retained = JSON.parse((await run(store, ENVELOPE)).stdout[0]!) as ReadRecords;
    expect(retained.missing).toBe(false);
    expect(retained.outcome).toBe('ok');
    expect(retained.rows.length).toBeGreaterThan(0);
  });
});
