import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMerges } from '../src/cli/merges.js';
import { buildMergeLatency, mergeLatencyText, mergesLatencyOptions } from '../src/core/fleet/merge-latency.js';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
const pr = (n: number, repo = 'phantom') => `https://github.com/ashlrai/${repo}/pull/${n}`;

// Plain fake fleet. Outcomes land in batches, so every observation is later than the real merge.
const LEDGER = [
  row('launch', 60, { job: 'RQ-A', lane: 'claude', repo: 'phantom' }),
  row('launch', 60, { job: 'RQ-B', lane: 'claude', repo: 'phantom' }),
  row('launch', 60, { job: 'RQ-C', lane: 'grok', repo: 'locus' }),
  row('launch', 120, { job: 'RQ-D', lane: 'claude', repo: 'phantom' }),
  row('launch', 120, { job: 'RQ-F', lane: 'claude', repo: 'phantom' }),
  row('publish', 50, { job: 'RQ-A', url: pr(1) }), row('publish', 48, { job: 'RQ-B', url: pr(2) }),
  row('publish', 30, { job: 'RQ-C', url: pr(3, 'locus') }), row('publish', 100, { job: 'RQ-D', url: pr(4) }),
  row('publish', 90, { job: 'RQ-F', url: pr(6) }),
  // True 5m (created 51m ago, merged 46m ago); seen 10m after it was published.
  row('outcome', 40, { job: 'RQ-A', url: pr(1), state: 'MERGED', createdAt: at(51), mergedAt: at(46) }),
  // A re-emitted row for the same PR counts once.
  row('outcome', 20, { job: 'RQ-A', url: pr(1), state: 'MERGED', createdAt: at(51), mergedAt: at(46) }),
  // True 4m.
  row('outcome', 40, { job: 'RQ-B', url: pr(2), state: 'MERGED', createdAt: at(49), mergedAt: at(45) }),
  // No PR times at all: the true time is unknown.
  row('outcome', 20, { job: 'RQ-C', url: pr(3, 'locus'), state: 'MERGED' }),
  // Created is known but the merged time is missing: unknown, not borrowed from the observation.
  row('outcome', 90, { job: 'RQ-D', url: pr(4), state: 'MERGED', createdAt: at(101) }),
  // Merged before it was created cannot be right: unknown.
  row('outcome', 85, { job: 'RQ-F', url: pr(6), state: 'MERGED', createdAt: at(80), mergedAt: at(88) }),
  // Merged long before the window.
  row('outcome', 30 * 60, { job: 'RQ-E', url: pr(5), state: 'MERGED', createdAt: at(31 * 60), mergedAt: at(30 * 60 + 1) }),
  'not json',
].join('\n');

const report = (by: 'lane' | 'repo' = 'lane', ledger: string | null = LEDGER, hours = 24) =>
  buildMergeLatency({ ledger, now: NOW, hours, by, metricsPath: '/m/jobs.jsonl' });

describe('merge latency', () => {
  it('reports the true open-to-merge time next to publish-to-observed, with coverage', () => {
    const r = report();
    expect(r.schema).toBe('merges.latency.v1');
    expect(r.basis).toEqual({ open_to_merge: 'pr_created_to_pr_merged', publish_to_observed: 'pr_publication_to_merge_observation' });
    expect(r.merged).toBe(5);
    expect(r.malformed_lines).toBe(1);
    // PR 1 is 300s and PR 2 is 240s; PRs 3, 4 and 6 have no usable pair.
    expect(r.open_to_merge).toEqual({ known: 2, unknown: 3, coverage_pct: 40, p50_s: 270, p90_s: 294 });
    // Observation minus publication: 600, 480, 600, 600 and 300 (PR 6).
    expect(r.publish_to_observed).toEqual({ known: 5, unknown: 0, coverage_pct: 100, p50_s: 600, p90_s: 600 });
    expect(r.headline).toContain('median 4m 30s (40% known)');
  });

  it('leaves a missing merged time unknown instead of guessing it', () => {
    const r = report('lane', [row('launch', 30, { job: 'RQ-X', lane: 'claude' }), row('publish', 30, { job: 'RQ-X', url: pr(9) }), row('outcome', 10, { job: 'RQ-X', url: pr(9), state: 'MERGED', createdAt: at(30) })].join('\n'));
    expect(r.open_to_merge).toEqual({ known: 0, unknown: 1, coverage_pct: 0, p50_s: null, p90_s: null });
    expect(r.publish_to_observed?.p50_s).toBe(1200);
    expect(r.headline).toContain('unknown (no merged PR carries its own created and merged times yet)');
    expect(mergeLatencyText(r).join('\n')).toContain('Open to merge (true): median unknown, p90 unknown, 0% known (0 of 1)');
  });

  it('uses terminal receipts only as outcomes when measuring publication to observation', () => {
    const ledger = [
      row('publish', 20, { url: pr(10), outcome: 'MERGED', source: 'metrics-outcomes-reconciler', createdAt: at(30), mergedAt: at(21) }),
      row('publish', 40, { url: pr(11), outcome: 'CLOSED', source: 'metrics-outcomes-reconciler' }),
      JSON.stringify({ timestamp: at(30), prUrl: pr(11), status: 'PUBLISHED' }),
      JSON.stringify({ timestamp: at(20), prUrl: pr(11), status: 'MERGED', createdAt: at(31), mergedAt: at(21) }),
    ].join('\n');
    const r = report('lane', ledger);
    expect(r.merged).toBe(2);
    expect(r.open_to_merge).toMatchObject({ known: 2, unknown: 0 });
    expect(r.publish_to_observed).toEqual({ known: 1, unknown: 1, coverage_pct: 50, p50_s: 600, p90_s: 600 });
  });

  it('rolls up per lane and per repo', () => {
    const lanes = report('lane').groups;
    expect(lanes.map(g => [g.name, g.merged])).toEqual([['claude', 4], ['grok', 1]]);
    expect(lanes[0]!.open_to_merge).toEqual({ known: 2, unknown: 2, coverage_pct: 50, p50_s: 270, p90_s: 294 });
    expect(lanes[1]!.open_to_merge).toMatchObject({ known: 0, coverage_pct: 0, p50_s: null });
    expect(lanes[1]!.publish_to_observed.p50_s).toBe(600);
    expect(report('repo').groups.map(g => [g.name, g.merged])).toEqual([['locus', 1], ['phantom', 4]]);
  });

  it('counts only merges inside the window, and a longer window brings the old one in', () => {
    expect(report('lane', LEDGER, 24).merged).toBe(5);
    expect(report('lane', LEDGER, 24 * 3).merged).toBe(6);
  });

  it('says unknown, never zero, when the metrics file cannot be read', () => {
    const r = report('lane', null);
    expect(r).toMatchObject({ metrics: 'unreadable', merged: null, open_to_merge: null, publish_to_observed: null, groups: [] });
    expect(mergeLatencyText(r)[1]).toContain('/m/jobs.jsonl');
  });

  it('validates the window and grouping', () => {
    expect(mergesLatencyOptions(undefined, undefined)).toEqual({ hours: 24, by: 'lane' });
    expect(mergesLatencyOptions(48, 'repo')).toEqual({ hours: 48, by: 'repo' });
    expect(mergesLatencyOptions(0, 'lane')).toBeNull();
    expect(mergesLatencyOptions(24, 'tier')).toBeNull();
  });
});

describe('phm merges latency', () => {
  let dir: string, metrics: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'merges-')); metrics = join(dir, 'jobs.jsonl'); await writeFile(metrics, LEDGER); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdMerges(args, { now: () => NOW, out: l => out.push(l), err: l => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints typed JSON with a schema id', async () => {
    const { code, out } = await run(['latency', '--json', '--by', 'repo', '--metrics', metrics]);
    const parsed = JSON.parse(out);
    expect(code).toBe(0);
    expect(parsed.schema).toBe('merges.latency.v1');
    expect(parsed.by).toBe('repo');
    expect(parsed.open_to_merge.p50_s).toBe(270);
  });

  it('prints plain words by default, and bare "merges" is the same path', async () => {
    const a = await run(['latency', '--since', '24h', '--metrics', metrics]);
    const b = await run(['--metrics', metrics]);
    expect(a.out).toContain('Open to merge (true): median 4m 30s, p90 4m 54s, 40% known (2 of 5)');
    expect(a.out).toContain('claude (4 merged)');
    expect(b.out).toBe(a.out);
  });

  it('accepts days, rejects bad usage with exit 2 and reports an unreadable file with exit 1', async () => {
    expect((await run(['latency', '--since', '3d', '--json', '--metrics', metrics])).code).toBe(0);
    expect((await run(['latency', '--since', 'soon'])).code).toBe(2);
    expect((await run(['latency', '--by', 'tier'])).code).toBe(2);
    expect((await run(['latency', '--nope'])).code).toBe(2);
    expect((await run(['latency', '--metrics', join(dir, 'missing.jsonl')])).code).toBe(1);
    expect((await run(['latency', '--help'])).out).toContain('phm merges latency');
  });
});

describe('status digest', () => {
  const base: StatusDigestInput = {
    installedVersion: { ok: true, value: '1.0.0' }, publishedVersion: { ok: true, value: '1.0.0' }, updatePending: false,
    mergesLastHour: { ok: true, value: 2 }, mergesLast24h: { ok: true, value: 40 }, lanes: { ok: true, value: [] },
    needsMason: { ok: true, value: 0 }, topP0: { ok: true, value: null },
  };
  it('puts the true median in the digest', () => {
    const lines = buildStatusDigest({ ...base, mergeTime: { ok: true, value: { medianSeconds: 270, known: 2, merged: 5 } } });
    expect(lines).toContain('Time to merge: median 4m 30s open to merge (2 of 5 PRs known)');
  });
  it('says unknown when no merged PR carries its own times, and when the file is unreadable', () => {
    expect(buildStatusDigest({ ...base, mergeTime: { ok: true, value: { medianSeconds: null, known: 0, merged: 5 } } }).join('\n')).toContain('Time to merge: unknown (5 merged');
    expect(buildStatusDigest({ ...base, mergeTime: { ok: false, reason: 'job metrics file not readable' } }).join('\n')).toContain('Time to merge: unknown (job metrics file not readable)');
  });
  it('keeps the existing lines when no merge time is supplied', () => {
    expect(buildStatusDigest(base).join('\n')).not.toContain('Time to merge');
  });
});
