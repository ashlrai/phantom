import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asObservabilityRecord, fetchWithTimeout, isNonNegativeFinite, isNonNegativeSafeInt,
  isObservabilityRecord, isPositiveSafeInt, parseStrictUtcIsoMs, readBoundedRegularFile, uuidV5Url,
} from '../src/core/observability/hop-events.js';
import { buildFleetHop, FLEET_HOP_EVENT, FLEET_HOP_ID_RE } from '../src/core/observability/fleet-hop.js';
import { buildMergedPrCostRollup } from '../src/core/observability/rollup.js';
import { cmdTelemetry, diagnoseMergeThroughput } from '../src/cli/telemetry.js';

const tmpDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('observability shared helpers', () => {
  it('validates plain records, numeric bounds, strict UTC ISO timestamps, and UUIDv5', () => {
    expect(isObservabilityRecord({ a: 1 })).toBe(true);
    expect([null, [], 'x'].some(isObservabilityRecord)).toBe(false);
    expect(asObservabilityRecord({ k: 'v' })).toEqual({ k: 'v' });
    expect(asObservabilityRecord([])).toBeNull();
    expect(isNonNegativeFinite(0) && isNonNegativeFinite(1.5)).toBe(true);
    expect([-0.1, Infinity, NaN, '0'].some(isNonNegativeFinite)).toBe(false);
    expect(isNonNegativeSafeInt(0) && isPositiveSafeInt(1)).toBe(true);
    expect([1.5, -1, Number.MAX_SAFE_INTEGER + 1].some(isNonNegativeSafeInt)).toBe(false);
    expect(isPositiveSafeInt(0)).toBe(false);

    expect(parseStrictUtcIsoMs('2026-06-01T12:00:00Z')).toBe(Date.parse('2026-06-01T12:00:00.000Z'));
    expect(parseStrictUtcIsoMs('2026-06-01T12:00:00.250Z', true)).toBe(Date.parse('2026-06-01T12:00:00.250Z'));
    expect(parseStrictUtcIsoMs('2026-06-01T12:00:00Z', true)).toBeNull();
    expect(parseStrictUtcIsoMs('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseStrictUtcIsoMs('2026-06-01T12:00:00+00:00')).toBeNull();

    const id = uuidV5Url('phantom-router:test');
    expect(id).toBe(uuidV5Url('phantom-router:test'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(uuidV5Url('https://phm.dev/queue.v1/test'));
  });

  it('enforces bounded fetch deadlines with credential-free AbortError', async () => {
    const okRes = new Response('ok', { status: 200 });
    expect(await fetchWithTimeout('https://example.test', { method: 'GET' }, 500, async () => okRes)).toBe(okRes);

    vi.useFakeTimers();
    const stalled = fetchWithTimeout('https://example.test', { method: 'POST' }, 50, (_url, init) =>
      new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('secret-leak')), { once: true }); }));
    const rejection = expect(stalled).rejects.toMatchObject({ name: 'AbortError', message: 'Request timed out' });
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('reads regular files within maxBytes and rejects oversize files or directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-shared-'));
    tmpDirs.push(dir);
    const small = join(dir, 'small.json');
    writeFileSync(small, '{"ok":true}', 'utf8');
    expect(await readBoundedRegularFile(small, 64)).toBe('{"ok":true}');
    await expect(readBoundedRegularFile(small, 4)).rejects.toThrow(/maximum size/);
    await expect(readBoundedRegularFile(dir, 64)).rejects.toThrow(/regular file/);
  });

  it('shares fleet-hop constants with merged-PR rollup and keeps telemetry CLI status/merge-throughput working', async () => {
    const hop = buildFleetHop({ job_id: 'job-1', pr: 7, station: 'merged', pool: 'codex', enter_ts: '2026-06-01T00:00:00Z', exit_ts: '2026-06-01T00:01:00Z', tokens: 100, usd: 0.01 });
    expect(hop?.event).toBe(FLEET_HOP_EVENT);
    expect(FLEET_HOP_ID_RE.test('job-1')).toBe(true);
    expect(buildMergedPrCostRollup([hop]).mergedPrs[0]?.totals.tokens).toBe(100);

    const home = mkdtempSync(join(tmpdir(), 'obs-tel-home-'));
    tmpDirs.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { chunks.push(String(chunk)); return true; });
    expect(await cmdTelemetry(['status', '--json'])).toBe(0);
    expect(JSON.parse(chunks.join(''))).toMatchObject({ m19ModulesAvailable: true, sinkMode: 'local' });
    vi.unstubAllEnvs();

    const diag = diagnoseMergeThroughput({
      start: '2026-06-01T00:00:00Z', end: '2026-06-01T02:00:00Z', complete: true,
      observations: [{ id: 'pr-1', state: 'merged', mergedAt: '2026-06-01T01:00:00Z' }],
    });
    expect(diag.mergesPerHour).toBe(0.5);
    expect(() => diagnoseMergeThroughput({ start: '2026-02-30T00:00:00Z', end: '2026-06-01T02:00:00Z', complete: true, observations: [] })).toThrow();
  });
});
