import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNodeResults } from '../src/core/drive/nodes/results-read.js';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput } from '../src/core/leader/status-digest-sources.js';

const NOW = Date.UTC(2026, 10, 15, 3, 0, 0);
const HOUR = 3_600_000;
const FAKE_TOKEN = 'FAKE-CLAIM-TOKEN-123456';
const FAKE_LEADER = 'FAKE-LEADER-TOKEN-654321';
let root: string, dir: string;

function artifact(jobId: string, ageMs: number, body: Record<string, unknown> = {}): void {
  const path = join(dir, `${jobId}.json`);
  writeFileSync(path, JSON.stringify({ schema: 'phm-node-runner.v1', event: 'finish', jobId, token: FAKE_TOKEN, leaderToken: FAKE_LEADER, outcome: 'succeeded', outputBytes: 4242, ...body }) + '\n', { mode: 0o600 });
  utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'node-runs-401-')); dir = join(root, 'node-results'); mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

const ok = <T>(value: T) => ({ ok: true as const, value });
const base = (): StatusDigestInput => ({
  installedVersion: ok('1.0.0'), publishedVersion: ok('1.0.0'), updatePending: false,
  mergesLastHour: ok(1), mergesLast24h: ok(2), lanes: ok([]), needsMason: ok(0), topP0: ok(null),
});

describe('readNodeResults', () => {
  it('counts recent artifacts and picks the newest', () => {
    artifact('RQ-NEW', 3 * 60_000);
    artifact('RQ-MID', HOUR);
    artifact('RQ-OLD', 30 * HOUR);
    const s = readNodeResults({ dir, nowMs: NOW });
    expect(s).toMatchObject({ v: 1, authority: 'none', status: 'ok', inWindow: 2, unreadable: 0, truncated: false });
    expect(s.newest).toEqual({ jobId: 'RQ-NEW', at: new Date(NOW - 3 * 60_000).toISOString() });
  });
  it('reports none for a missing or empty dir', () => {
    expect(readNodeResults({ dir: join(root, 'absent'), nowMs: NOW }).status).toBe('none');
    expect(readNodeResults({ dir, nowMs: NOW }).status).toBe('none');
  });
  it('refuses a symlinked dir without reading', () => {
    artifact('RQ-A', 1000);
    const link = join(root, 'link');
    symlinkSync(dir, link);
    expect(readNodeResults({ dir: link, nowMs: NOW })).toMatchObject({ status: 'unavailable', reason: 'unsafe-dir', inWindow: 0, newest: null });
  });
  it('refuses a mode 0755 dir without reading', () => {
    artifact('RQ-A', 1000);
    chmodSync(dir, 0o755);
    expect(readNodeResults({ dir, nowMs: NOW })).toMatchObject({ status: 'unavailable', reason: 'unsafe-dir', newest: null });
  });
  it('counts corrupt, mismatched and symlinked files as unreadable, never as results', () => {
    artifact('RQ-GOOD', 1000);
    writeFileSync(join(dir, 'RQ-BAD.json'), '{not json', { mode: 0o600 });
    artifact('RQ-MISMATCH', 1000, { jobId: 'someone-else' });
    symlinkSync(join(dir, 'RQ-GOOD.json'), join(dir, 'RQ-LINK.json'));
    const s = readNodeResults({ dir, nowMs: NOW });
    expect(s).toMatchObject({ status: 'ok', inWindow: 1, unreadable: 3 });
  });
  it('rejects oversized files and marks truncation at max', () => {
    artifact('RQ-BIG', 1000, { pad: 'x'.repeat(20_000) });
    artifact('RQ-1', 2000); artifact('RQ-2', 3000);
    const s = readNodeResults({ dir, nowMs: NOW, max: 2 });
    expect(s.truncated).toBe(true);
    expect(s.unreadable).toBe(1);
    expect(s.inWindow).toBe(1);
  });
  it('never exposes tokens or output bytes', () => {
    artifact('RQ-A', 1000);
    const text = JSON.stringify(readNodeResults({ dir, nowMs: NOW }));
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_LEADER);
    expect(text).not.toContain('4242');
  });
});

describe('digest Node runs line', () => {
  it('renders source, window, as-of and the proof caveat without tokens', () => {
    artifact('RQ-X', 40 * 60_000); artifact('RQ-Y', HOUR);
    const lines = buildStatusDigest({ ...base(), nodeRuns: readNodeResults({ dir, nowMs: NOW }) });
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('Node runs (this computer, 24h, as of 03:00Z): 2 results, newest RQ-X at 02:20Z; artifacts are not completion proof');
    expect(lines.join('\n')).not.toMatch(/FAKE-/);
  });
  it('renders none and unknown lines', () => {
    expect(buildStatusDigest({ ...base(), nodeRuns: readNodeResults({ dir, nowMs: NOW }) })[5]).toBe('Node runs: none recorded on this computer');
    chmodSync(dir, 0o755);
    expect(buildStatusDigest({ ...base(), nodeRuns: readNodeResults({ dir, nowMs: NOW }) })[5]).toBe('Node runs unknown: unsafe-dir');
  });
  it('leaves the other lines unchanged when nodeRuns is undefined', () => {
    const without = buildStatusDigest(base());
    expect(without).toHaveLength(5);
    expect(buildStatusDigest({ ...base(), nodeRuns: readNodeResults({ dir, nowMs: NOW }) }).slice(0, 5)).toEqual(without);
  });
  it('gather turns a reader throw into an unknown line and honors an undefined override', async () => {
    const stubs = {
      installedVersion: () => '1.0.0', publishedVersion: async () => '1.0.0',
      mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
      runsState: async () => ({ lanes: [], sources: { status: 'healthy' }, runsDirPresent: true }),
      needs: () => ({ status: 'missing', items: [] }), inbox: async () => ({ sourceState: 'ok', entries: [] }),
      workClaims: undefined, peers: undefined, mergeLatency: undefined,
    };
    const thrown = await gatherStatusDigestInput(root, new Date(NOW), { ...stubs, nodeRuns: () => { throw new Error(`boom ${FAKE_TOKEN}`); } } as never);
    const line = buildStatusDigest(thrown)[5]!;
    expect(line).toBe('Node runs unknown: reader-failed');
    const dropped = await gatherStatusDigestInput(root, new Date(NOW), { ...stubs, nodeRuns: undefined } as never);
    expect(buildStatusDigest(dropped)).toHaveLength(5);
  });
});
