import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Observes (and can fail) the node:fs calls that add or remove a directory
// entry. root bypasses DAC mode bits, so a 0o500 directory still accepts new
// entries (a lock file, a temp file, a rename) from uid 0. As root the hook
// raises the EACCES a user gets from the kernel for any entry change beneath
// a read-only directory, and records each attempt so the case can assert the
// read made none.
const entryHook = vi.hoisted(() => ({
  readOnlyDirs: [] as string[],
  attempts: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const guarded = (target: unknown): boolean => entryHook.readOnlyDirs.some((dir) => String(target).startsWith(`${dir}/`));
  const deny = (syscall: string, target: unknown): never => {
    entryHook.attempts.push(`${syscall} ${String(target)}`);
    throw Object.assign(new Error(`EACCES: permission denied, ${syscall} '${String(target)}'`), {
      code: 'EACCES',
      errno: -13,
      syscall,
      path: String(target),
    });
  };
  const creates = (flags: unknown): boolean => typeof flags === 'string'
    ? /[wax]/.test(flags)
    : typeof flags === 'number' && (flags & actual.constants.O_CREAT) !== 0;
  const missing = (target: unknown): boolean => !actual.existsSync(String(target));
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (guarded(args[0]) && creates(args[1]) && missing(args[0])) deny('open', args[0]);
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  const writeFileSync = ((...args: Parameters<typeof actual.writeFileSync>) => {
    if (guarded(args[0]) && missing(args[0])) deny('open', args[0]);
    actual.writeFileSync(...args);
  }) as typeof actual.writeFileSync;
  const appendFileSync = ((...args: Parameters<typeof actual.appendFileSync>) => {
    if (guarded(args[0]) && missing(args[0])) deny('open', args[0]);
    actual.appendFileSync(...args);
  }) as typeof actual.appendFileSync;
  const mkdirSync = ((...args: Parameters<typeof actual.mkdirSync>) => {
    if (guarded(args[0]) && missing(args[0])) deny('mkdir', args[0]);
    return actual.mkdirSync(...args);
  }) as typeof actual.mkdirSync;
  const linkSync = ((...args: Parameters<typeof actual.linkSync>) => {
    if (guarded(args[1])) deny('link', args[1]);
    actual.linkSync(...args);
  }) as typeof actual.linkSync;
  const symlinkSync = ((...args: Parameters<typeof actual.symlinkSync>) => {
    if (guarded(args[1])) deny('symlink', args[1]);
    actual.symlinkSync(...args);
  }) as typeof actual.symlinkSync;
  const renameSync = ((...args: Parameters<typeof actual.renameSync>) => {
    if (guarded(args[0]) || guarded(args[1])) deny('rename', args[guarded(args[0]) ? 0 : 1]);
    actual.renameSync(...args);
  }) as typeof actual.renameSync;
  const unlinkSync = ((...args: Parameters<typeof actual.unlinkSync>) => {
    if (guarded(args[0])) deny('unlink', args[0]);
    actual.unlinkSync(...args);
  }) as typeof actual.unlinkSync;
  const rmSync = ((...args: Parameters<typeof actual.rmSync>) => {
    if (guarded(args[0]) && !missing(args[0])) deny('rm', args[0]);
    actual.rmSync(...args);
  }) as typeof actual.rmSync;
  const rmdirSync = ((...args: Parameters<typeof actual.rmdirSync>) => {
    if (guarded(args[0])) deny('rmdir', args[0]);
    actual.rmdirSync(...args);
  }) as typeof actual.rmdirSync;
  const wrapped = { openSync, writeFileSync, appendFileSync, mkdirSync, linkSync, symlinkSync, renameSync, unlinkSync, rmSync, rmdirSync };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});
const RUNNING_AS_ROOT = process.getuid?.() === 0;
import {
  cutoffObservationCheckpointLedgerPath,
  cutoffObservationCheckpointRootPath,
  readCutoffObservationCheckpoints,
  readCutoffObservationCheckpointsSnapshot,
  recordCutoffObservationCheckpoint,
} from '../src/core/fleet/cutoff-observation-checkpoints.js';
import {
  captureEnrollmentCutoffSnapshotV2,
  type EnrollmentCutoffSnapshotV2,
} from '../src/core/fleet/enrollment-cutoff-snapshot.js';
import { readFleetCutoffCheckpointStatus } from '../src/core/fleet/cutoff-observation-status.js';
import { loadOrCreateKey, provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const key = Buffer.alloc(32, 23);
let home = '';
let repo = '';
let oldHome: string | undefined;
let oldAshlrHome: string | undefined;

function enrollmentFingerprint(repos: string[]): string {
  return createHash('sha256').update(JSON.stringify(['enrollment-source:v1', repos])).digest('hex');
}

function snapshot(capturedAt: string, branch = 'main', identityKey = key): EnrollmentCutoffSnapshotV2 {
  const source = {
    sourceState: 'healthy' as const,
    complete: true,
    repos: [repo],
    fingerprint: enrollmentFingerprint([repo]),
  };
  const result = captureEnrollmentCutoffSnapshotV2({
    now: () => capturedAt,
    monotonicNow: () => 0,
    identityKey: () => identityKey,
    readSource: () => ({ ...source, repos: [...source.repos] }),
    resolveDefaultBranch: () => branch,
    inspectRepository: () => ({
      repo,
      realPath: repo,
      dev: 1,
      ino: 2,
      gitEntryDigest: 'a'.repeat(64),
    }),
  });
  if (!result.ok) throw new Error(`snapshot fixture failed: ${result.reason}`);
  return result.snapshot;
}

function maximumSnapshot(capturedAt: string): EnrollmentCutoffSnapshotV2 {
  const repos = Array.from({ length: 64 }, (_, index) => {
    const prefix = `/${String(index).padStart(2, '0')}-`;
    return `${prefix}${'r'.repeat(4_096 - prefix.length)}`;
  });
  const source = {
    sourceState: 'healthy' as const,
    complete: true,
    repos,
    fingerprint: enrollmentFingerprint(repos),
  };
  const result = captureEnrollmentCutoffSnapshotV2({
    now: () => capturedAt,
    monotonicNow: () => 0,
    identityKey: () => key,
    readSource: () => ({ ...source, repos: [...source.repos] }),
    resolveDefaultBranch: () => 'b'.repeat(1_024),
    inspectRepository: (path) => ({
      repo: path,
      realPath: path,
      dev: 1,
      ino: 2,
      gitEntryDigest: 'a'.repeat(64),
    }),
  });
  if (!result.ok) throw new Error(`maximum snapshot fixture failed: ${result.reason}`);
  return result.snapshot;
}

function record(value: EnrollmentCutoffSnapshotV2, now = value.capturedAt) {
  return recordCutoffObservationCheckpoint(value, {
    now: () => now,
    keyProvider: () => key,
  });
}

function read() {
  return readCutoffObservationCheckpoints(() => key);
}

beforeEach(() => {
  oldHome = process.env.HOME;
  oldAshlrHome = process.env.ASHLR_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-m383-')));
  repo = resolve(home, 'repo');
  process.env.HOME = home;
  delete process.env.ASHLR_HOME;
});

afterEach(() => {
  entryHook.readOnlyDirs.length = 0;
  entryHook.attempts.length = 0;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = oldAshlrHome;
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});

describe('M383 authenticated cutoff observation checkpoints', () => {
  it('distinguishes a missing source from a verified chained observation history', () => {
    expect(read()).toMatchObject({
      checkpoints: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
      cutoffAuthority: false,
      denominatorComplete: false,
      policyEligible: false,
      rollbackProtected: false,
      historicalAuthority: false,
    });

    const first = snapshot('2026-07-12T09:20:00.000Z');
    const second = snapshot('2026-07-12T09:21:00.000Z', 'trunk');
    expect(record(first)).toMatchObject({ recorded: 1, replayed: 0, failed: 0 });
    expect(record(second)).toMatchObject({ recorded: 1, replayed: 0, failed: 0 });

    const result = read();
    expect(result).toMatchObject({
      sourceState: 'healthy', complete: true, physicalRows: 2, releasedRows: 2,
      unreleasedRows: 0, latestCapturedAt: second.capturedAt,
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
      rollbackProtected: false, historicalAuthority: false,
    });
    expect(result.checkpoints.map((entry) => ({
      sequence: entry.sequence,
      previous: entry.previousEntryDigest,
      snapshot: entry.snapshot.snapshotDigest,
    }))).toEqual([
      { sequence: 1, previous: null, snapshot: first.snapshotDigest },
      { sequence: 2, previous: result.checkpoints[0]!.entryDigest, snapshot: second.snapshotDigest },
    ]);
    expect(result.root).toMatchObject({
      sequence: 2,
      entryDigest: result.checkpoints[1]!.entryDigest,
      cutoffAuthority: false,
      denominatorComplete: false,
      policyEligible: false,
      rollbackProtected: false,
      historicalAuthority: false,
    });
    if (process.platform !== 'win32') {
      expect(statSync(cutoffObservationCheckpointLedgerPath()).mode & 0o777).toBe(0o600);
      expect(statSync(cutoffObservationCheckpointRootPath()).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.ashlr', 'fleet')).mode & 0o777).toBe(0o700);
    }
  });

  it('replays the same authenticated observation without growing the chain', () => {
    const value = snapshot('2026-07-12T09:22:00.000Z');
    expect(record(value)).toMatchObject({ recorded: 1 });
    const bytes = readFileSync(cutoffObservationCheckpointLedgerPath());
    expect(record(value, '2026-07-12T09:23:00.000Z')).toMatchObject({
      recorded: 0, replayed: 1, recoveredRows: 0, failed: 0,
    });
    expect(readFileSync(cutoffObservationCheckpointLedgerPath())).toEqual(bytes);
  });

  it('replays any historical observation without duplicating it', () => {
    const first = snapshot('2026-07-12T09:22:00.000Z');
    const second = snapshot('2026-07-12T09:23:00.000Z', 'trunk');
    expect(record(first)).toMatchObject({ recorded: 1 });
    expect(record(second)).toMatchObject({ recorded: 1 });
    const bytes = readFileSync(cutoffObservationCheckpointLedgerPath());

    expect(record(first, '2026-07-12T09:24:00.000Z')).toMatchObject({
      recorded: 0, replayed: 1, recoveredRows: 0, failed: 0,
    });
    expect(readFileSync(cutoffObservationCheckpointLedgerPath())).toEqual(bytes);
    expect(read()).toMatchObject({ sourceState: 'healthy', releasedRows: 2 });
  });

  it('withholds an fsynced orphan tail until root recovery and then replays it exactly once', () => {
    const first = snapshot('2026-07-12T09:24:00.000Z');
    const second = snapshot('2026-07-12T09:25:00.000Z');
    expect(record(first)).toMatchObject({ recorded: 1 });
    const firstRoot = readFileSync(cutoffObservationCheckpointRootPath());
    expect(record(second)).toMatchObject({ recorded: 1 });
    writeFileSync(cutoffObservationCheckpointRootPath(), firstRoot, { mode: 0o600 });

    expect(read()).toMatchObject({
      sourceState: 'degraded', complete: false, releasedRows: 1, unreleasedRows: 1,
      stopReasons: ['unreleased-tail'], cutoffAuthority: false,
    });
    expect(record(second, '2026-07-12T09:26:00.000Z')).toMatchObject({
      recorded: 0, replayed: 1, recoveredRows: 1, failed: 0,
    });
    expect(read()).toMatchObject({
      sourceState: 'healthy', complete: true, releasedRows: 2, unreleasedRows: 0,
    });
  });

  it('never claims rollback protection when an older valid ledger and root pair is restored', () => {
    const first = snapshot('2026-07-12T09:25:00.000Z');
    const second = snapshot('2026-07-12T09:26:00.000Z', 'trunk');
    expect(record(first)).toMatchObject({ recorded: 1 });
    const oldLedger = readFileSync(cutoffObservationCheckpointLedgerPath());
    const oldRoot = readFileSync(cutoffObservationCheckpointRootPath());
    expect(record(second)).toMatchObject({ recorded: 1 });

    writeFileSync(cutoffObservationCheckpointLedgerPath(), oldLedger, { mode: 0o600 });
    writeFileSync(cutoffObservationCheckpointRootPath(), oldRoot, { mode: 0o600 });
    expect(read()).toMatchObject({
      sourceState: 'healthy', complete: true, releasedRows: 1,
      rollbackProtected: false, historicalAuthority: false,
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
    });
  });

  it('recovers a missing genesis root and an incomplete append under the writer lock', () => {
    const first = snapshot('2026-07-12T09:26:00.000Z');
    const second = snapshot('2026-07-12T09:27:00.000Z', 'trunk');
    expect(record(first)).toMatchObject({ recorded: 1 });
    rmSync(cutoffObservationCheckpointRootPath());
    expect(record(first, '2026-07-12T09:28:00.000Z')).toMatchObject({
      recorded: 0, replayed: 1, recoveredRows: 1, failed: 0,
    });

    appendFileSync(cutoffObservationCheckpointLedgerPath(), '{"partial":', { mode: 0o600 });
    expect(read()).toMatchObject({
      sourceState: 'degraded', complete: false, releasedRows: 1,
      unreleasedRows: 1, stopReasons: ['invalid-row'],
    });
    expect(record(second, '2026-07-12T09:29:00.000Z')).toMatchObject({
      recorded: 1, replayed: 0, recoveredRows: 1, failed: 0,
    });
    expect(read()).toMatchObject({
      sourceState: 'healthy', complete: true, releasedRows: 2, unreleasedRows: 0,
    });
  });

  it('never releases a root-required scheduler row whose root publication was interrupted', () => {
    const cancelled = snapshot('2026-07-12T09:29:30.000Z');
    const replacement = snapshot('2026-07-12T09:29:31.000Z', 'trunk');
    expect(recordCutoffObservationCheckpoint(cancelled, {
      keyProvider: () => key,
      recoveryPolicy: 'root-required',
    })).toMatchObject({ recorded: 1 });
    rmSync(cutoffObservationCheckpointRootPath());

    expect(record(replacement, '2026-07-12T09:29:32.000Z')).toMatchObject({
      recorded: 1, replayed: 0, recoveredRows: 1, failed: 0,
    });
    const result = read();
    expect(result).toMatchObject({ sourceState: 'healthy', releasedRows: 1, unreleasedRows: 0 });
    expect(result.checkpoints.map((entry) => entry.snapshot.snapshotDigest)).toEqual([
      replacement.snapshotDigest,
    ]);
  });

  it('binds replay to the exact scheduler capture attempt', () => {
    const value = snapshot('2026-07-12T09:25:30.000Z');
    const firstAttempt = '11111111-1111-4111-8111-111111111111';
    const secondAttempt = '22222222-2222-4222-8222-222222222222';
    expect(recordCutoffObservationCheckpoint(value, {
      keyProvider: () => key,
      recoveryPolicy: 'root-required',
      captureAttemptId: firstAttempt,
    })).toMatchObject({ recorded: 1, replayed: 0 });
    expect(recordCutoffObservationCheckpoint(value, {
      keyProvider: () => key,
      recoveryPolicy: 'root-required',
      captureAttemptId: secondAttempt,
    })).toMatchObject({ recorded: 1, replayed: 0 });
    expect(recordCutoffObservationCheckpoint(value, {
      keyProvider: () => key,
      recoveryPolicy: 'root-required',
      captureAttemptId: secondAttempt,
    })).toMatchObject({ recorded: 0, replayed: 1 });
    expect(read().checkpoints.map((entry) => entry.captureAttemptId)).toEqual([firstAttempt, secondAttempt]);
  });

  it('discards an unauthenticated partial genesis append before the first root exists', () => {
    mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    mkdirSync(join(home, '.ashlr', 'fleet'), { mode: 0o700 });
    writeFileSync(cutoffObservationCheckpointLedgerPath(), '{"partial":', { mode: 0o600 });
    const value = snapshot('2026-07-12T09:30:00.000Z');

    expect(record(value)).toMatchObject({
      recorded: 1, replayed: 0, recoveredRows: 1, invalid: 0, failed: 0,
    });
    expect(read()).toMatchObject({ sourceState: 'healthy', releasedRows: 1, unreleasedRows: 0 });
  });

  it('pins one valid provenance key for each read and write transaction', () => {
    const value = snapshot('2026-07-12T09:30:00.000Z');
    let writeCalls = 0;
    expect(recordCutoffObservationCheckpoint(value, {
      keyProvider: () => (++writeCalls === 1 ? key : Buffer.alloc(32, 9)),
    })).toMatchObject({ recorded: 1, invalid: 0, failed: 0 });
    expect(writeCalls).toBe(1);

    let readCalls = 0;
    expect(readCutoffObservationCheckpoints(
      () => (++readCalls === 1 ? key : Buffer.alloc(32, 9)),
    )).toMatchObject({ sourceState: 'healthy', releasedRows: 1 });
    expect(readCalls).toBe(1);

    let snapshotReadCalls = 0;
    expect(readCutoffObservationCheckpointsSnapshot(
      () => (++snapshotReadCalls === 1 ? key : Buffer.alloc(32, 9)),
    )).toMatchObject({ sourceState: 'healthy', releasedRows: 1 });
    expect(snapshotReadCalls).toBe(1);
  });

  it('provides a non-mutating authenticated snapshot read for status', () => {
    expect(record(snapshot('2026-07-12T09:30:30.000Z'))).toMatchObject({ recorded: 1 });
    const fleetPath = join(home, '.ashlr', 'fleet');
    const lock = join(fleetPath, '.cutoff-observation-checkpoints.lock');
    chmodSync(fleetPath, 0o500);
    if (RUNNING_AS_ROOT) entryHook.readOnlyDirs.push(fleetPath);
    try {
      expect(readCutoffObservationCheckpointsSnapshot(() => key)).toMatchObject({
        sourceState: 'healthy', complete: true, releasedRows: 1,
      });
      expect(statSync(fleetPath).mode & 0o777).toBe(0o500);
      expect(existsSync(lock)).toBe(false);
      if (RUNNING_AS_ROOT) {
        // The snapshot never tried to add or remove an entry under fleet/ ...
        expect(entryHook.attempts).toEqual([]);
        // ... and the guard is live: the lock create the mutating reader makes is refused.
        expect(() => writeFileSync(lock, 'x')).toThrow(/EACCES/);
        expect(entryHook.attempts).toEqual([`open ${lock}`]);
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      entryHook.readOnlyDirs.length = 0;
      chmodSync(fleetPath, 0o700);
    }
  });

  it('keeps the complete status call path read-only when key recovery is required', () => {
    const persistentKey = loadOrCreateKey();
    const value = snapshot('2026-07-12T09:30:45.000Z', 'main', persistentKey);
    expect(recordCutoffObservationCheckpoint(value, {
      keyProvider: () => persistentKey,
    })).toMatchObject({ recorded: 1 });
    expect(readFleetCutoffCheckpointStatus('2026-07-12T09:31:00.000Z')).toMatchObject({
      state: 'available', releasedCheckpoints: 1,
    });

    const keyPath = provenanceKeyPath();
    const installerTemp = `${keyPath}.123.${'c'.repeat(24)}.tmp`;
    linkSync(keyPath, installerTemp);
    expect(readFleetCutoffCheckpointStatus('2026-07-12T09:31:00.000Z')).toMatchObject({
      state: 'degraded', releasedCheckpoints: 0,
    });
    expect(statSync(keyPath).nlink).toBe(2);
    expect(existsSync(installerTemp)).toBe(true);
  });

  it('persists the maximum capture-valid 64-repository snapshot', () => {
    const value = maximumSnapshot('2026-07-12T09:31:00.000Z');
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(record(value)).toMatchObject({ recorded: 1, invalid: 0, failed: 0 });
    expect(read()).toMatchObject({ sourceState: 'healthy', releasedRows: 1 });
  });

  it('fails closed for row tamper, chain splice, torn tails, and root tamper', () => {
    const first = snapshot('2026-07-12T09:27:00.000Z');
    const second = snapshot('2026-07-12T09:28:00.000Z');
    expect(record(first)).toMatchObject({ recorded: 1 });
    expect(record(second)).toMatchObject({ recorded: 1 });
    const ledgerPath = cutoffObservationCheckpointLedgerPath();
    const rootPath = cutoffObservationCheckpointRootPath();
    const ledger = readFileSync(ledgerPath, 'utf8');
    const root = readFileSync(rootPath, 'utf8');

    const tampered = ledger.replace(second.snapshotDigest, 'f'.repeat(64));
    writeFileSync(ledgerPath, tampered, { mode: 0o600 });
    expect(read()).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['invalid-row'] });

    writeFileSync(ledgerPath, `${ledger.trimEnd().split('\n').reverse().join('\n')}\n`, { mode: 0o600 });
    expect(read()).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['invalid-row'] });

    writeFileSync(ledgerPath, `${ledger}partial-tail`, { mode: 0o600 });
    expect(read()).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['invalid-row'] });

    writeFileSync(ledgerPath, ledger, { mode: 0o600 });
    const parsedRoot = JSON.parse(root) as Record<string, unknown>;
    parsedRoot['entryDigest'] = '0'.repeat(64);
    writeFileSync(rootPath, `${JSON.stringify(parsedRoot)}\n`, { mode: 0o600 });
    expect(read()).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['invalid-root'] });
  });

  it('rejects wrong keys, snapshot tamper, missing roots, and unsafe storage', () => {
    const value = snapshot('2026-07-12T09:29:00.000Z');
    expect(recordCutoffObservationCheckpoint(value, { keyProvider: () => Buffer.alloc(32, 9) }))
      .toMatchObject({ invalid: 1, recorded: 0 });
    expect(record({ ...value, cutoffAuthority: true } as unknown as EnrollmentCutoffSnapshotV2))
      .toMatchObject({ invalid: 1, recorded: 0 });
    expect(record(value)).toMatchObject({ recorded: 1 });
    expect(readCutoffObservationCheckpoints(() => Buffer.alloc(32, 9))).toMatchObject({
      sourceState: 'degraded', complete: false,
    });

    rmSync(cutoffObservationCheckpointRootPath());
    expect(read()).toMatchObject({ sourceState: 'degraded', complete: false, stopReasons: ['io-error'] });

    rmSync(join(home, '.ashlr'), { recursive: true, force: true });
    writeFileSync(join(home, '.ashlr'), 'not-a-directory', 'utf8');
    expect(record(value)).toMatchObject({ failed: 1, recorded: 0 });
  });

  it('rejects hardlinked and symlinked ledgers plus writer-lock contention', () => {
    const first = snapshot('2026-07-12T09:32:00.000Z');
    const second = snapshot('2026-07-12T09:33:00.000Z', 'trunk');
    expect(record(first)).toMatchObject({ recorded: 1 });
    const ledgerPath = cutoffObservationCheckpointLedgerPath();
    const aliasPath = `${ledgerPath}.alias`;
    linkSync(ledgerPath, aliasPath);
    expect(read()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'] });
    expect(record(second)).toMatchObject({ failed: 1, recorded: 0 });
    rmSync(aliasPath);

    const originalPath = `${ledgerPath}.original`;
    writeFileSync(originalPath, readFileSync(ledgerPath), { mode: 0o600 });
    rmSync(ledgerPath);
    symlinkSync(originalPath, ledgerPath);
    expect(read()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'] });
    rmSync(ledgerPath);
    writeFileSync(ledgerPath, readFileSync(originalPath), { mode: 0o600 });
    rmSync(originalPath);

    const lock = acquireLocalStoreLock(
      join(home, '.ashlr', 'fleet', '.cutoff-observation-checkpoints.lock'),
      0,
    );
    expect(lock).not.toBeNull();
    try {
      expect(recordCutoffObservationCheckpoint(second, {
        lockWaitMs: 0,
        keyProvider: () => key,
      })).toMatchObject({ failed: 1, recorded: 0 });
    } finally {
      if (lock) releaseLocalStoreLock(lock);
    }
    expect(record(second)).toMatchObject({ recorded: 1, failed: 0 });
  });

  it('recovers and replays at capacity but refuses a new 257th checkpoint', () => {
    const values = Array.from({ length: 257 }, (_, index) =>
      snapshot(new Date(Date.UTC(2026, 6, 13, 0, index)).toISOString()));
    for (const value of values.slice(0, 255)) {
      expect(record(value)).toMatchObject({ recorded: 1, failed: 0 });
    }
    const root255 = readFileSync(cutoffObservationCheckpointRootPath());
    expect(record(values[255]!)).toMatchObject({ recorded: 1, failed: 0 });
    writeFileSync(cutoffObservationCheckpointRootPath(), root255, { mode: 0o600 });

    expect(record(values[255]!)).toMatchObject({
      recorded: 0, replayed: 1, recoveredRows: 1, failed: 0,
    });
    expect(record(values[0]!)).toMatchObject({ recorded: 0, replayed: 1, failed: 0 });
    expect(record(values[256]!)).toMatchObject({ recorded: 0, replayed: 0, failed: 1 });
    expect(read()).toMatchObject({
      sourceState: 'healthy', complete: true, releasedRows: 256, unreleasedRows: 0,
    });
  });
});
