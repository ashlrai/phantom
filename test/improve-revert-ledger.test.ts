import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REVERT_LEDGER_BYTES,
  readRevertOutcomeRecords,
  recordRevertOutcomes,
  revertOutcomesLedgerPath,
  standingRevertKeys,
  validateRevertOutcomeRecord,
} from '../src/core/improve/revert-ledger.js';
import { revertedPrKeys, type RevertOutcomeRecord } from '../src/core/improve/reverted.js';
import { cmdFleetReverts } from '../src/cli/fleet-reverts.js';
import type { ObserveExec } from '../src/core/improve/observe.js';

const MERGE = 'a'.repeat(40);
const REVERT = 'c'.repeat(40);
const RELAND = 'd'.repeat(40);
const HEAD_SHA = 'f'.repeat(40);
const MERGED_AT = '2026-10-27T00:00:00.000Z';
const REVERTED_AT = '2026-10-27T10:00:00.000Z';
const plus = (hours: number) => new Date(Date.parse(MERGED_AT) + hours * 3_600_000).toISOString();

const rec = (over: Partial<RevertOutcomeRecord> = {}): RevertOutcomeRecord => ({
  repository: 'ashlrai/phantom',
  number: 5,
  pr: 'ashlrai/phantom#5',
  mergeSha: MERGE,
  mergedAt: MERGED_AT,
  revertedBy: REVERT,
  revertedAt: REVERTED_AT,
  revertLatencyMs: 10 * 3_600_000,
  relandedBy: null,
  ...over,
});

const dirs: string[] = [];
function tmpdirPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revert-ledger-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('validateRevertOutcomeRecord', () => {
  it('accepts a well-formed record and returns a clean copy', () => {
    const record = rec({ extra: 'dropped' } as Partial<RevertOutcomeRecord>);
    expect(validateRevertOutcomeRecord(record)).toEqual(rec());
  });

  it('rejects pr keys that do not match repository+number and malformed fields', () => {
    expect(() => validateRevertOutcomeRecord(rec({ pr: 'ashlrai/phantom#9' }))).toThrow('PR key');
    expect(() => validateRevertOutcomeRecord(rec({ mergeSha: 'xyz' }))).toThrow('merge commit');
    expect(() => validateRevertOutcomeRecord(rec({ revertedBy: 'notasha' }))).toThrow('revert commit');
    expect(() => validateRevertOutcomeRecord(rec({ relandedBy: 42 as unknown as string }))).toThrow('reland');
    expect(() => validateRevertOutcomeRecord(rec({ mergedAt: 'not a date' }))).toThrow('times');
    expect(() => validateRevertOutcomeRecord(rec({ revertLatencyMs: Number.NaN }))).toThrow('latency');
    expect(() => validateRevertOutcomeRecord(null)).toThrow('object');
  });
});

describe('revertOutcomesLedgerPath', () => {
  it('lives under the isolated ASHLR_HOME improve directory', () => {
    expect(revertOutcomesLedgerPath()).toBe(join(process.env.ASHLR_HOME!, 'improve', 'revert-outcomes.jsonl'));
  });
});

describe('recordRevertOutcomes / readRevertOutcomeRecords', () => {
  it('round-trips records through the append-only ledger', () => {
    const path = join(tmpdirPath(), 'improve', 'revert-outcomes.jsonl');
    const result = recordRevertOutcomes([rec(), rec({ number: 6, pr: 'ashlrai/phantom#6' })], { path, now: new Date(MERGED_AT) });
    expect(result).toMatchObject({ appended: 2, duplicates: 0, path });
    const read = readRevertOutcomeRecords(path);
    expect(read.intact).toBe(true);
    expect(read.records).toEqual([rec(), rec({ number: 6, pr: 'ashlrai/phantom#6' })]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('skips exact duplicates but appends a reland found by a deeper scan', () => {
    const path = join(tmpdirPath(), 'revert-outcomes.jsonl');
    recordRevertOutcomes([rec()], { path });
    const again = recordRevertOutcomes([rec()], { path });
    expect(again).toMatchObject({ appended: 0, duplicates: 1 });
    // Same PR and revert commit but relandedBy now set: different evidence, must append.
    const relanded = recordRevertOutcomes([rec({ relandedBy: RELAND })], { path });
    expect(relanded).toMatchObject({ appended: 1, duplicates: 0 });
    const read = readRevertOutcomeRecords(path);
    expect(read.records).toHaveLength(2);
    expect(standingRevertKeys(read.records).has('ashlrai/phantom#5')).toBe(false);
  });

  it('dedups within a single batch too', () => {
    const path = join(tmpdirPath(), 'revert-outcomes.jsonl');
    const result = recordRevertOutcomes([rec(), rec()], { path });
    expect(result).toMatchObject({ appended: 1, duplicates: 1 });
  });

  it('reports a missing ledger as an empty intact read', () => {
    const read = readRevertOutcomeRecords(join(tmpdirPath(), 'nope.jsonl'));
    expect(read).toEqual({ records: [], intact: true, reasons: [], state: 'missing' });
  });

  it('keeps the verified prefix and refuses appends after a corrupt line', () => {
    const path = join(tmpdirPath(), 'revert-outcomes.jsonl');
    recordRevertOutcomes([rec()], { path });
    writeFileSync(path, 'not json\n', { flag: 'a' });
    const read = readRevertOutcomeRecords(path);
    expect(read.intact).toBe(false);
    expect(read.reasons[0]).toBe('unreadable-line-2');
    expect(read.records).toHaveLength(1);
    expect(() => recordRevertOutcomes([rec({ number: 7, pr: 'ashlrai/phantom#7' })], { path })).toThrow('not intact');
    // The refused append left the file byte-identical.
    expect(readRevertOutcomeRecords(path).records).toHaveLength(1);
  });

  it('refuses oversized ledgers and invalid record shapes on write', () => {
    const path = join(tmpdirPath(), 'revert-outcomes.jsonl');
    writeFileSync(path, 'x'.repeat(64));
    const read = readRevertOutcomeRecords(path, { maxBytes: 32 });
    expect(read).toMatchObject({ intact: false, reasons: ['ledger-too-large'], records: [] });
    expect(MAX_REVERT_LEDGER_BYTES).toBeGreaterThan(0);
    expect(() => recordRevertOutcomes([rec({ pr: 'wrong#5' })], { path: join(tmpdirPath(), 'ok.jsonl') })).toThrow('PR key');
  });
});

describe('standingRevertKeys', () => {
  it('keeps only PRs whose newest record has no reland', () => {
    const keys = standingRevertKeys([
      rec(),
      rec({ number: 6, pr: 'ashlrai/phantom#6' }),
      rec({ number: 7, pr: 'ashlrai/phantom#7', relandedBy: RELAND }),
      rec({ relandedBy: RELAND }), // later record for #5 clears it
    ]);
    expect([...keys].sort()).toEqual(['ashlrai/phantom#6']);
  });
});

describe('revertedPrKeys with recorded scan detections', () => {
  it('includes git-detected reverts and honours reland clearing', () => {
    const scan = { records: [rec(), rec({ number: 8, pr: 'ashlrai/phantom#8', relandedBy: RELAND })], intact: true, reasons: [], state: 'read' as const };
    const keys = revertedPrKeys([], [], scan);
    expect(keys.has('ashlrai/phantom#5')).toBe(true);
    expect(keys.has('ashlrai/phantom#8')).toBe(false);
  });

  it('contributes nothing when the ledger is not intact', () => {
    const scan = { records: [rec()], intact: false, reasons: ['unreadable-line-1'], state: 'unreadable' as const };
    const keys = revertedPrKeys([], [], scan);
    expect(keys.size).toBe(0);
  });
});

describe('cmdFleetReverts --record', () => {
  const MERGE_LOG = [
    `${REVERT}\x1f${plus(10)}\x1fRevert "x"\n\nThis reverts commit ${MERGE}.\x1e`,
    `${MERGE}\x1f${MERGED_AT}\x1fx (#5)\x1e`,
  ].join('');
  const exportsJson = JSON.stringify([{
    url: 'https://github.com/ashlrai/phantom/pull/5',
    number: 5,
    mergeCommit: { oid: MERGE },
    mergedAt: MERGED_AT,
  }]);
  const fakeExec: ObserveExec = (_cmd, args) => {
    if (args.includes('-n1')) return `${HEAD_SHA}\x1f${plus(100)}`;
    return MERGE_LOG;
  };

  it('appends detected records through the injected writer and reports counts', async () => {
    const seen: RevertOutcomeRecord[][] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'prs.json', '--record', '--json'], {
      read: async () => exportsJson,
      exec: fakeExec,
      record: (records) => {
        seen.push([...records]);
        return { appended: records.length, duplicates: 0, path: '/tmp/revert-outcomes.jsonl' };
      },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]![0]).toMatchObject({ pr: 'ashlrai/phantom#5', revertedBy: REVERT });
    const body = JSON.parse(String(out.mock.calls[0]![0])) as { recorded?: { appended: number } };
    expect(body.recorded).toMatchObject({ appended: 1, duplicates: 0 });
  });

  it('writes nothing without --record and fails loudly when the ledger refuses', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls = 0;
    const code = await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'prs.json', '--record'], {
      read: async () => exportsJson,
      exec: fakeExec,
      record: () => {
        calls += 1;
        throw new Error('Revert outcomes ledger is not intact (unreadable-line-2); refusing to append.');
      },
    });
    expect(calls).toBe(1);
    expect(code).toBe(1);
    expect(String(err.mock.calls.at(-1)![0])).toContain('revert ledger:');
    // Without --record the writer is never invoked.
    calls = 0;
    await cmdFleetReverts(['--repo-dir', '/repo', '--prs', 'prs.json', '--json'], {
      read: async () => exportsJson,
      exec: fakeExec,
      record: () => { calls += 1; return { appended: 0, duplicates: 0, path: 'x' }; },
    });
    expect(calls).toBe(0);
  });
});
