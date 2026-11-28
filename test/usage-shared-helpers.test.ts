import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asPlainObject,
  hasCodexHomeSegment,
  isCanonicalIsoTimestamp,
  isFiniteNumber,
  isPlainObject,
  nonNegativeFinite,
  parseDispatchStatusEnvelope,
  parseEpochSecondsOrIsoMs,
  round1,
  round2,
  round3,
  runwayHours,
  runWithDeadline,
} from '../src/core/usage/runway.js';
import { readDispatchStatus as paceReadDispatchStatus } from '../src/core/usage/pace.js';
import { readDispatchStatus as spendReadDispatchStatus, spendCountdown } from '../src/core/usage/spend.js';
import {
  openUsageBrowserSession,
  optionalAbsolutePath,
  writeUsageFileAtomic,
  type BrowserSession,
} from '../src/core/usage/live/browser.js';
import { readActiveLanes } from '../src/core/usage/resource-live/engine.js';

const tempDirs: string[] = [];
async function makeTempDir(prefix = 'usage-shared-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('usage shared pure helpers', () => {
  it('validates plain objects, finite numbers, and decimal rounding', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(asPlainObject('bad')).toEqual({});
    expect(isFiniteNumber(42)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(nonNegativeFinite(0)).toBe(0);
    expect(nonNegativeFinite(-0.1)).toBeNull();
    expect(round1(1.26)).toBe(1.3);
    expect(round2(1.236)).toBe(1.24);
    expect(round3(1.2346)).toBe(1.235);
  });

  it('enforces canonical ISO timestamps and bounded epoch-second parsing', () => {
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00.000Z')).toBe(true);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00Z')).toBe(false);
    expect(isCanonicalIsoTimestamp('2026-11-26T12:00:00+00:00')).toBe(false);
    expect(isCanonicalIsoTimestamp('not-a-date')).toBe(false);
    expect(isCanonicalIsoTimestamp(123)).toBe(false);

    expect(parseEpochSecondsOrIsoMs('2026-11-26T12:00:00.000Z')).toBe(Date.parse('2026-11-26T12:00:00.000Z'));
    expect(parseEpochSecondsOrIsoMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(Number.isNaN(parseEpochSecondsOrIsoMs(1e13))).toBe(true);
    expect(Number.isNaN(parseEpochSecondsOrIsoMs(Number.POSITIVE_INFINITY))).toBe(true);
    expect(Number.isNaN(parseEpochSecondsOrIsoMs(null))).toBe(true);
  });

  it('detects .codex home segments without false positives', () => {
    expect(hasCodexHomeSegment('/Users/op/.codex')).toBe(true);
    expect(hasCodexHomeSegment('/Users/op/.codex-2/auth.json')).toBe(true);
    expect(hasCodexHomeSegment('.codex/sessions')).toBe(true);
    expect(hasCodexHomeSegment('/Users/op/my.codex/data')).toBe(false);
    expect(hasCodexHomeSegment('/Users/op/.ashlr-runs/queue')).toBe(false);
  });

  it('parses dispatchd status envelopes and enforces freshness bounds', () => {
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    const fresh = parseDispatchStatusEnvelope(
      { schema: 'dispatchd.status.v1', last_tick: '2026-11-26T11:58:30.000Z', budget: { claude: {} } },
      now,
    );
    expect(fresh.fresh).toBe(true);
    expect(fresh.asOf).toBe('2026-11-26T11:58:30.000Z');
    expect(fresh.budget).toEqual({ claude: {} });

    const stale = parseDispatchStatusEnvelope(
      { schema: 'dispatchd.status.v1', last_tick: '2026-11-26T11:57:59.000Z', budget: { claude: {} } },
      now,
    );
    expect(stale.fresh).toBe(false);

    const future = parseDispatchStatusEnvelope(
      { schema: 'dispatchd.status.v1', last_tick: '2026-11-26T12:00:01.000Z' },
      now,
    );
    expect(future.fresh).toBe(false);

    const wrongSchema = parseDispatchStatusEnvelope(
      { schema: 'other.v1', last_tick: '2026-11-26T12:00:00.000Z' },
      now,
    );
    expect(wrongSchema.fresh).toBe(false);
  });

  it('keeps spendCountdown aligned with runwayHours and shares readDispatchStatus', () => {
    expect(spendReadDispatchStatus).toBe(paceReadDispatchStatus);
    for (const hours of [0.25, 3.25, 50.5]) {
      expect(spendCountdown(hours)).toBe(runwayHours(hours));
    }
    expect(spendCountdown(0)).toBeNull();
    expect(spendCountdown(-1)).toBeNull();
    expect(spendCountdown(null)).toBeNull();
  });

  it('settles runWithDeadline cleanly for values, errors, and timeouts', async () => {
    expect(await runWithDeadline(() => 'sync', 50)).toEqual({ kind: 'value', value: 'sync' });
    expect(await runWithDeadline(async () => 42, 50)).toEqual({ kind: 'value', value: 42 });
    expect(await runWithDeadline(() => { throw new Error('boom'); }, 50)).toEqual({ kind: 'error' });
    expect(await runWithDeadline(async () => Promise.reject(new Error('async boom')), 50)).toEqual({ kind: 'error' });

    const lateReject = runWithDeadline(
      () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 30)),
      5,
    );
    expect(await lateReject).toEqual({ kind: 'timeout' });
    await new Promise(resolve => setTimeout(resolve, 40));
  });
});

describe('usage browser & status file helpers', () => {
  it('validates optional absolute paths and writes private atomic files', async () => {
    expect(optionalAbsolutePath('/tmp/runs')).toBe('/tmp/runs');
    expect(optionalAbsolutePath('relative/runs')).toBeUndefined();
    expect(optionalAbsolutePath(undefined)).toBeUndefined();

    const dir = await makeTempDir();
    const target = join(dir, 'snapshot.json');
    await writeUsageFileAtomic(target, '{"ok":true}\n');
    expect(await readFile(target, 'utf8')).toBe('{"ok":true}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('opens, refuses, and degrades usage browser sessions consistently', async () => {
    const home = await makeTempDir();
    const fakeSession: BrowserSession = {
      newPage: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(fakeSession);
    const opened = await openUsageBrowserSession({ home, headed: true, launch });
    expect(opened).toEqual({ status: 'opened', session: fakeSession });
    expect(launch).toHaveBeenCalledWith(join(home, '.ashlr-runs', 'usage-browser'), { headless: false });

    const refused = await openUsageBrowserSession({ home: '/tmp/.codex', headed: false, launch });
    expect(refused).toEqual({ status: 'refused' });

    const unavailable = await openUsageBrowserSession({
      home,
      headed: false,
      launch: vi.fn().mockRejectedValue(new Error('missing playwright')),
    });
    expect(unavailable).toEqual({ status: 'unavailable' });
  });

  it('refuses symlinked status.json files when reading active lanes', async () => {
    const dir = await makeTempDir();
    const runsDir = join(dir, 'runs');
    const queueDir = join(runsDir, 'queue');
    const external = join(dir, 'external.json');
    const now = Date.parse('2026-11-26T12:00:00.000Z');
    await writeFile(external, JSON.stringify({ last_tick: new Date(now).toISOString(), lanes: { claude: { running: 1 } } }));
    await mkdir(queueDir, { recursive: true });
    await symlink(external, join(queueDir, 'status.json'));

    expect((await readActiveLanes(runsDir, now)).size).toBe(0);
  });
});
