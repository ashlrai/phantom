import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importImpactJobs, parseImpactOverrides, readImpactSource } from '../src/core/metrics/impact-source.js';
import { scoreImpact } from '../src/core/metrics/impact.js';
import { runMetricsCli } from '../src/cli/metrics.js';

const at = '2026-10-26T10:00:00Z';
function job(id = 'A', number = 1, mergedAt = at) {
  return { schemaVersion: 1, id, repo: 'ashlrai/phantom', status: 'merged', template: 'build', tokens: 1000,
    pr: { number, mergedAt, additions: 600, deletions: 50, files: [{ path: 'src/a.ts' }], labels: [{ name: 'impact:capability' }, { name: 'risk:tier-1' }] } };
}
function jsonl(...rows: unknown[]) { return rows.map(row => JSON.stringify(row)).join('\n'); }
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'impact-source-')); dirs.push(dir); return dir; }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('impact evidence import', () => {
  it('imports PR metadata with a repository-scoped canonical identity', () => {
    const [input] = importImpactJobs(jsonl(job()));
    expect(input).toMatchObject({ id: 'ashlrai/phantom#1', status: 'merged', files: ['src/a.ts'], labels: ['impact:capability', 'risk:tier-1'], churnFiles: 0 });
    expect(scoreImpact(input).reward).toBeGreaterThan(100);
  });
  it('does not equate job done with a merge or published production reach', () => {
    const [input] = importImpactJobs(jsonl({ id: 'A', repo: 'r', status: 'done', tags: ['impact:capability'] }));
    expect(input.status).toBe('pending');
    expect(scoreImpact(input).impact).toBe(0);
    expect(scoreImpact(importImpactJobs(jsonl(job()))[0]).components.productionReach).toBe(0);
  });
  it('does not invent an empty file list from missing metadata', () => {
    const row = { ...job(), pr: { number: 1, mergedAt: at, additions: 0, deletions: 0 } };
    const [input] = importImpactJobs(jsonl(row));
    expect(input.files).toBeUndefined();
    expect(scoreImpact(input).penalties.empty).toBe(0);
  });
  it('requires merged PR metadata and rejects unknown schemas or statuses', () => {
    for (const row of [{ id: 'A', repo: 'r', status: 'merged' }, { ...job(), schemaVersion: 2 }, { ...job(), status: 'unknown' }, { ...job(), tokens: -1 }]) {
      expect(() => importImpactJobs(jsonl(row))).toThrow();
    }
  });
  it('deduplicates identical snapshots before churn and rejects conflicting observations', () => {
    expect(importImpactJobs(jsonl(job(), job()))).toHaveLength(1);
    expect(importImpactJobs(jsonl(job(), job()))[0].churnFiles).toBe(0);
    expect(() => importImpactJobs(jsonl(job(), { ...job(), tokens: 2000 }))).toThrow(/duplicate/);
  });
  it('counts unique graph dependents, longest path and cross-repo breadth', () => {
    const graph = { schemaVersion: 1, nodes: [
      { key: 'A', repo: 'ashlrai/phantom', tags: ['impact:fleet-loop'] },
      { key: 'B', repo: 'other', dependsOn: ['A'] },
      { key: 'C', repo: 'third', dependsOn: ['A'] },
      { key: 'D', repo: 'other', dependsOn: ['B', 'C'] },
    ] };
    const [input] = importImpactJobs(jsonl(job()), graph);
    expect(input).toMatchObject({ dependentJobs: 3, criticalPathDepth: 2, repoBreadth: 3, tags: ['impact:fleet-loop'] });
  });
  it('rejects dangling dependencies, cycles, duplicate keys and repository mismatch', () => {
    for (const nodes of [
      [{ key: 'A', dependsOn: ['B'] }],
      [{ key: 'A', dependsOn: ['B'] }, { key: 'B', dependsOn: ['A'] }],
      [{ key: 'A' }, { key: 'A' }],
      [{ key: 'A', repo: 'wrong' }],
    ]) expect(() => importImpactJobs(jsonl(job()), nodes)).toThrow();
  });
  it('counts churn only within 48 hours in the same repository, independent of input order', () => {
    const second = job('B', 2, '2026-10-28T10:00:00Z');
    const outside = job('C', 3, '2026-10-30T10:00:00.001Z');
    const elsewhere = { ...job('D', 4), repo: 'other' };
    const inputs = importImpactJobs(jsonl(outside, second, elsewhere, job()));
    expect(inputs.find(i => i.id.endsWith('#2'))?.churnFiles).toBe(1);
    expect(inputs.find(i => i.id.endsWith('#3'))?.churnFiles).toBe(0);
    expect(inputs.find(i => i.repo === 'other')?.churnFiles).toBe(0);
    expect(importImpactJobs(jsonl(job(), second, outside, elsewhere))).toEqual(inputs);
  });
  it('unfixed reverts cancel landed credit and merged fix-forward restores it', () => {
    const revert = job('B', 2, '2026-10-26T11:00:00Z');
    Object.assign(revert.pr, { reverts: 'ashlrai/phantom#1' });
    const fix = job('C', 3, '2026-10-26T12:00:00Z');
    Object.assign(fix.pr, { fixedForwardFor: 'ashlrai/phantom#1' });
    expect(scoreImpact(importImpactJobs(jsonl(job(), revert))[0]).reward).toBeLessThan(0);
    expect(scoreImpact(importImpactJobs(jsonl(job(), revert, fix))[0]).reward).toBeGreaterThan(0);
  });
  it('refuses unresolved revert references and malformed JSON without echoing contents', () => {
    const revert = job(); Object.assign(revert.pr, { reverts: 'missing' });
    expect(() => importImpactJobs(jsonl(revert))).toThrow(/reference/);
    expect(() => importImpactJobs('private-content')).toThrow('Invalid impact job line 1 JSON.');
  });
  it('cannot clear a later revert with an earlier fix or a self reference', () => {
    const fix = job('B', 2, '2026-10-26T11:00:00Z');
    Object.assign(fix.pr, { fixedForwardFor: 'ashlrai/phantom#1' });
    const revert = job('C', 3, '2026-10-26T12:00:00Z');
    Object.assign(revert.pr, { reverts: 'ashlrai/phantom#1' });
    expect(scoreImpact(importImpactJobs(jsonl(job(), fix, revert))[0]).reward).toBeLessThan(0);
    Object.assign(revert.pr, { fixedForwardFor: 'ashlrai/phantom#3' });
    expect(() => importImpactJobs(jsonl(job(), fix, revert))).toThrow(/chronology/);
  });
  it('rejects non-merged, cross-repo and later reversal targets', () => {
    for (const target of [
      { id: 'A', repo: 'ashlrai/phantom', status: 'failed', pr: { number: 1 } },
      { ...job(), repo: 'other' },
      job('A', 1, '2026-10-27T10:00:00Z'),
    ]) {
      const revert = job('B', 2, '2026-10-26T11:00:00Z');
      Object.assign(revert.pr, { reverts: `${target.repo}#1` });
      expect(() => importImpactJobs(jsonl(target, revert))).toThrow(/chronology/);
    }
  });
  it('rejects impossible timestamps and future graph schema versions', () => {
    expect(() => importImpactJobs(jsonl(job('A', 1, '2026-02-30T10:00:00Z')))).toThrow(/timestamp/);
    expect(() => importImpactJobs(jsonl(job()), { schemaVersion: 2, nodes: [] })).toThrow(/schema/);
  });
  it('validates bounded manual dimensions and cannot override lifecycle facts', () => {
    expect(parseImpactOverrides({ schemaVersion: 1, overrides: { 'r#1': { capability: 0.5, riskTier: 1 } } })['r#1']).toEqual({ capability: 0.5, riskTier: 1 });
    for (const value of [{ capability: 2 }, { riskTier: 0 }, { fixedForward: true }, { reward: 100 }, { trivial: 'yes' }]) {
      expect(() => parseImpactOverrides({ schemaVersion: 1, overrides: { 'r#1': value } })).toThrow();
    }
  });
});

describe('metrics CLI and source files', () => {
  it('reports shared reward and consumer rankings without network calls', async () => {
    const dir = directory(); const jobs = join(dir, 'jobs.jsonl');
    writeFileSync(jobs, jsonl(job()));
    const fetch = vi.fn(() => { throw new Error('network forbidden'); }); vi.stubGlobal('fetch', fetch);
    const out: string[] = []; const err: string[] = [];
    expect(await runMetricsCli(['impact', '--jobs', jobs, '--json'], { out: s => out.push(s), err: s => err.push(s) })).toBe(0);
    const report = JSON.parse(out[0]);
    expect(report.complete).toBe(true);
    expect(report.outcomes).toEqual(report.jev.outcomes);
    expect(report.templates).toEqual(report.bandit.ranking);
    expect(report.totalReward).toBe(scoreImpact(importImpactJobs(jsonl(job()))[0]).reward);
    expect(fetch).not.toHaveBeenCalled(); expect(err).toEqual([]);
  });
  it('reads graph and override files and rejects unknown override targets', async () => {
    const dir = directory(); const jobs = join(dir, 'jobs.jsonl'); const queue = join(dir, 'queue.json'); const overrides = join(dir, 'overrides.json');
    writeFileSync(jobs, jsonl(job())); writeFileSync(queue, JSON.stringify([{ key: 'A' }, { key: 'B', dependsOn: ['A'] }]));
    writeFileSync(overrides, JSON.stringify({ schemaVersion: 1, overrides: { 'ashlrai/phantom#1': { autonomy: 1 } } }));
    const source = await readImpactSource({ jobs, queue, overrides });
    expect(source.inputs[0].dependentJobs).toBe(1);
    expect(scoreImpact(source.inputs[0], source.overrides[source.inputs[0].id]).components.autonomy).toBe(1);
    writeFileSync(overrides, JSON.stringify({ schemaVersion: 1, overrides: { missing: { autonomy: 1 } } }));
    await expect(readImpactSource({ jobs, overrides })).rejects.toThrow(/target/);
  });
  it('marks an absent default ledger unknown rather than measured zero', async () => {
    vi.stubEnv('ASHLR_HOME', directory());
    const source = await readImpactSource();
    expect(source.complete).toBe(false); expect(source.warnings).toHaveLength(1);
    await expect(readImpactSource({ jobs: join(directory(), 'missing') })).rejects.toThrow();
  });
  it('rejects malformed evidence without leaking its contents and returns nonzero', async () => {
    const path = join(directory(), 'jobs.jsonl'); writeFileSync(path, 'do-not-echo-private-material');
    const out: string[] = []; const err: string[] = [];
    expect(await runMetricsCli(['impact', '--jobs', path, '--json'], { out: s => out.push(s), err: s => err.push(s) })).toBe(1);
    expect(out).toEqual([]); expect(err.join('')).not.toContain('do-not-echo');
  });
  it.each([['unknown'], ['impact', '--unknown'], ['impact', '--jobs'], ['impact', '--json', '--json']])('rejects invalid arguments %j', async (...args) => {
    expect(await runMetricsCli(args, { out: () => undefined, err: () => undefined })).toBe(2);
  });
});
