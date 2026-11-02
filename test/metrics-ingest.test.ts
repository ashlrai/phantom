import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestMetrics, parseMetricsFeed } from '../src/core/fleet/metrics-ingest.js';
import { cmdMetrics } from '../src/cli/metrics.js';

const jobsText = readFileSync(new URL('./fixtures/router-metrics/jobs.jsonl', import.meta.url), 'utf8');
const statusText = readFileSync(new URL('./fixtures/router-metrics/status.json', import.meta.url), 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const base = { schemaVersion: 1, id: 'job', lane: 'lane', tier: 'frontier' };
const merged = { ...base, outcome: 'merged', tokens: 100, pr: 'owner/repo#1', impact: 2, reverted: false };
const status = (text: string, updates: unknown[] = []) => JSON.stringify({ schemaVersion: 1, jobsSha256: hash(text), jobs: updates });
const feed = (jobs: unknown[], updates: unknown[] = []) => {
  const text = jobs.map(j => JSON.stringify(j)).join('\n');
  return parseMetricsFeed(text, status(text, updates));
};
const directories: string[] = [];
function files(text = jobsText, snapshot = statusText) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-feed-')); directories.push(dir);
  const jobs = join(dir, 'jobs.jsonl'), state = join(dir, 'status.json');
  writeFileSync(jobs, text); writeFileSync(state, snapshot);
  return { dir, jobs, state };
}
afterEach(() => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('deterministic local metrics feed', () => {
  it('rolls up fixture terminal outcomes, waste, elapsed time and retained impact', () => {
    const result = parseMetricsFeed(jobsText, statusText);
    expect(result.lanes.map(g => g.key)).toEqual(['codex-cmp', 'grok', 'local']);
    expect(result.tiers.map(g => g.key)).toEqual(['frontier', 'local', 'mid']);
    expect(result.lanes[0]).toEqual({
      key: 'codex-cmp', jobs: 5, completedJobs: 3, incompleteJobs: 2, mergedPRs: 1,
      emptyJobs: 1, revertedPRs: 0, tokenSamples: 3, timeToMergeSamples: 1, revertSamples: 1,
      impactSamples: 1, knownTokens: 1000, mergeRate: 1 / 3, emptyJobRate: 1 / 3,
      tokensPerMergedPR: 1000, timeToMergeMs: 7_200_000, revertRate: 0, mergedImpactPerToken: 0.004,
    });
    expect(result.lanes[1]).toMatchObject({ mergedPRs: 2, revertedPRs: 1, knownTokens: 300,
      tokensPerMergedPR: 150, timeToMergeMs: 2_700_000, revertRate: 0.5, mergedImpactPerToken: 0.02 });
    expect(result.overall).toMatchObject({ jobs: 8, completedJobs: 6, incompleteJobs: 2,
      mergedPRs: 4, tokenSamples: 5, tokensPerMergedPR: null, mergedImpactPerToken: null,
      revertRate: null, timeToMergeMs: null });
    expect(result.priors).toMatchObject({ objective: 'mergedImpactPerToken', operationalSteering: false,
      lanes: [{ key: 'codex-cmp', mergedImpactPerToken: 0.004 }, { key: 'grok', mergedImpactPerToken: 0.02 },
        { key: 'local', mergedImpactPerToken: null }] });
    expect(result.laneTiers[0]).toMatchObject({ lane: 'codex-cmp', tier: 'frontier', mergedImpactPerToken: 0.004 });
  });

  it('is byte deterministic and independent of job order apart from source digests', () => {
    const result = parseMetricsFeed(jobsText, statusText);
    expect(JSON.stringify(parseMetricsFeed(jobsText, statusText))).toBe(JSON.stringify(result));
    const reversed = jobsText.trim().split('\n').reverse().join('\n');
    const other = parseMetricsFeed(reversed, status(reversed, JSON.parse(statusText).jobs));
    expect({ ...other, sources: result.sources }).toEqual(result);
  });

  it('keeps empty inputs and incomplete-only groups unknown', () => {
    expect(feed([]).overall).toMatchObject({ jobs: 0, mergeRate: null, emptyJobRate: null,
      tokensPerMergedPR: null, timeToMergeMs: null, revertRate: null, mergedImpactPerToken: null });
    expect(feed([base]).overall).toMatchObject({ jobs: 1, incompleteJobs: 1, completedJobs: 0, mergeRate: null });
  });

  it('counts cancelled/failed/empty costs, and never treats a zero denominator as efficiency', () => {
    const result = feed([{ ...base, outcome: 'empty', tokens: 25 },
      { ...base, id: 'b', outcome: 'cancelled', tokens: 25 }]);
    expect(result.overall).toMatchObject({ completedJobs: 2, mergeRate: 0, emptyJobRate: 0.5,
      tokensPerMergedPR: null, mergedImpactPerToken: 0 });
    expect(feed([{ ...merged, tokens: 0 }]).overall.mergedImpactPerToken).toBeNull();
  });

  it('does not guess missing cost, impact, revert status or merge duration', () => {
    for (const field of ['tokens', 'impact', 'reverted']) {
      const job: Record<string, unknown> = { ...merged }; delete job[field];
      expect(feed([job]).overall.mergedImpactPerToken).toBeNull();
    }
    expect(feed([merged]).overall.timeToMergeMs).toBeNull();
    expect(feed([{ ...merged, reverted: true, impact: undefined }]).overall.mergedImpactPerToken).toBe(0);
    expect(feed([merged, { ...base, id: 'b', outcome: 'failed' }]).overall.tokensPerMergedPR).toBeNull();
  });

  it('groups a lane across tiers without losing lane/tier combinations', () => {
    const result = feed([merged, { ...merged, id: 'b', tier: 'mid', pr: 'owner/repo#2', impact: 8 }]);
    expect(result.lanes).toHaveLength(1); expect(result.tiers).toHaveLength(2);
    expect(result.lanes[0].mergedImpactPerToken).toBe(0.05);
    expect(result.laneTiers.map(g => g.mergedImpactPerToken)).toEqual([0.02, 0.08]);
  });

  it('uses maps safely for prototype-like identifiers', () => {
    expect(feed([{ ...base, lane: 'constructor', tier: 'prototype' }]).lanes[0].key).toBe('constructor');
    expect(() => feed([{ ...base, tier: '__proto__' }])).toThrow('identifier');
  });

  it.each([
    { tokens: -1 }, { tokens: 1.5 }, { tokens: '100' }, { tokens: null }, { impact: -1 },
    { impact: 1e100 }, { outcome: 'done' }, { reverted: 'false' }, { pr: 'https://example.test/pr/1' },
    { startedAt: '2026-02-30T00:00:00.000Z' }, { startedAt: '2026-10-25' },
    { startedAt: '2026-10-25T10:00:00.000Z', mergedAt: '2026-10-25T09:00:00.000Z' },
    { schemaVersion: 2 }, { lane: '../lane' }, { tier: '' },
  ])('rejects invalid measurements: %j', patch => {
    expect(() => feed([{ ...merged, ...patch }])).toThrow();
  });

  it('rejects duplicate jobs/PRs, unknown updates and contradictory snapshots', () => {
    const bad = [
      () => feed([base, base]),
      () => feed([merged, { ...merged, id: 'b', pr: 'OWNER/REPO#1' }]),
      () => feed([base], [{ id: 'missing' }]),
      () => feed([base], [{ id: 'job' }, { id: 'job' }]),
      () => feed([base], [{ id: 'job', lane: 'other' }]),
      () => feed([base], [{ id: 'job', tier: 'other' }]),
      () => feed([merged], [{ id: 'job', outcome: 'running' }]),
      () => feed([merged], [{ id: 'job', pr: 'owner/repo#2' }]),
      () => feed([{ ...merged, reverted: true }], [{ id: 'job', reverted: false }]),
      () => feed([{ ...base, outcome: 'empty', impact: 1 }]),
      () => feed([{ ...base, outcome: 'merged' }]),
    ];
    for (const run of bad) expect(run).toThrow();
  });

  it('refuses malformed/truncated records instead of silently improving the denominator', () => {
    for (const text of ['{', jobsText + '{"id":', 'null', '[]']) {
      expect(() => parseMetricsFeed(text, status(text))).toThrow();
    }
    expect(() => parseMetricsFeed(jobsText, '{')).toThrow();
    expect(() => parseMetricsFeed(jobsText, JSON.stringify({ schemaVersion: 2, jobs: [] }))).toThrow();
    expect(() => parseMetricsFeed(jobsText + '\n', statusText)).toThrow('does not match');
    expect(() => feed([{ ...merged, tokens: Number.MAX_SAFE_INTEGER },
      { ...base, id: 'b', outcome: 'empty', tokens: 1 }])).toThrow('safe numeric range');
    expect(() => parseMetricsFeed(' '.repeat(16 * 1024 * 1024 + 1), '{}')).toThrow('16 MiB');
  });
});

describe('local reader and CLI', () => {
  it('reads without network or writes, preserving input bytes, mtimes and directory inventory', () => {
    const { dir, jobs, state } = files();
    const before = [statSync(jobs).mtimeMs, statSync(state).mtimeMs];
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); }); vi.stubGlobal('fetch', fetch);
    const io = { out: vi.fn(), err: vi.fn() };
    expect(cmdMetrics(['ingest', '--jobs', jobs, '--status', state, '--json'], io)).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0][0])).toEqual(parseMetricsFeed(jobsText, statusText));
    expect(io.err).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(jobs, 'utf8')).toBe(jobsText); expect(readFileSync(state, 'utf8')).toBe(statusText);
    expect([statSync(jobs).mtimeMs, statSync(state).mtimeMs]).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(['jobs.jsonl', 'status.json']);
  });

  it.each(['https://example.test/jobs', 'file:///tmp/jobs', '//host/share/jobs', '\\\\host\\share\\jobs', '', 'a\0b'])('rejects nonlocal paths: %j', path => {
    expect(() => ingestMetrics(path, 'status.json')).toThrow('local filesystem');
  });

  it('refuses missing, directory and symlink inputs', () => {
    const { dir, jobs, state } = files();
    expect(() => ingestMetrics(join(dir, 'missing'), state)).toThrow();
    expect(() => ingestMetrics(dir, state)).toThrow();
    const link = join(dir, 'link'); symlinkSync(jobs, link);
    expect(() => ingestMetrics(link, state)).toThrow();
  });

  it('refuses invalid UTF-8 rather than hashing replacement text as original bytes', () => {
    const { jobs, state } = files();
    const bytes = Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    writeFileSync(jobs, bytes);
    writeFileSync(state, status(bytes.toString('utf8')));
    expect(() => ingestMetrics(jobs, state)).toThrow('UTF-8');
  });

  it.each([['ingest'], ['unknown'], ['ingest', '--jobs'], ['ingest', '--json', '--json'],
    ['ingest', '--jobs', 'a', '--jobs', 'b', '--status', 'c'],
    ['ingest', '--jobs', 'a', '--status', 'b', '--output', 'c']])('rejects invalid CLI arguments: %j', (...args) => {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(cmdMetrics(args, io)).toBe(2); expect(io.out).not.toHaveBeenCalled();
  });

  it('prints help without reading files, and never leaks malformed input in errors', () => {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(cmdMetrics(['--help'], io)).toBe(0); expect(io.out).toHaveBeenCalledWith(expect.stringContaining('phm metrics ingest'));
    io.out.mockClear();
    const { jobs, state } = files('private-payload-that-must-not-be-echoed', statusText);
    expect(cmdMetrics(['ingest', '--jobs', jobs, '--status', state], io)).toBe(2);
    expect(io.out).not.toHaveBeenCalled(); expect(io.err).toHaveBeenCalledWith('Invalid JSON input.');
  });
});
