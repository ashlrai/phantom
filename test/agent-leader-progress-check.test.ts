import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLeaderProgressCheck } from '../examples/agents/leader-progress-check.js';
import type { LeaderJournalV1 } from '../src/core/fleet/leader-journal.js';
import type { FleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const start = Date.parse('2026-10-31T12:00:00.000Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixtures() {
  const journal: LeaderJournalV1 = { v: 1, generatedAt: '', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' }, passes: [], ingest: [], ingested: [], rejectedLastHour: 0 };
  const runs: FleetRunsDirState = { v: 1, generatedAt: '', runsDirPresent: true, sourceState: 'healthy',
    sources: { status: 'healthy', claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
    lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, lanes: [], switches: [], claudeLane: null,
    publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 } };
  let clock = start, saved = '', output: Array<Record<string, unknown>> = [];
  const deps = { journal: async () => journal, runs: async () => runs, now: () => clock,
    output: (text: string) => { output.push(JSON.parse(text) as Record<string, unknown>); },
    save: async (_path: string, text: string) => { saved = text; }, readBaseline: async () => saved };
  return { journal, runs, deps, get saved() { return saved; }, set saved(s: string) { saved = s; },
    advance: (ms: number) => { clock += ms; }, take: () => output.splice(0), async baseline() {
      expect(await runLeaderProgressCheck(['--save', 'baseline.json'], deps)).toBe(0); output = [];
    } };
}

describe('leader progress workflow', () => {
  it('reports a new claim as progress and returns the original rejection reason', async () => {
    const f = fixtures(); f.journal.ingest = [{ verb: 'accept', file: 'old.md', reason: null }]; await f.baseline();
    f.advance(31 * 60_000);
    f.runs.claimed.push({ job: 'RQ-FAKE', lane: 'devin', tier: 'frontier', at: new Date(start + 60_000).toISOString() });
    f.journal.ingest.unshift({ verb: 'reject', file: 'RQ-FAKE.md', reason: 'denied-path: fix the destination' });
    expect(await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps)).toBe(0);
    expect(f.take()[0]).toMatchObject({ status: 'progress', claims: [{ job: 'RQ-FAKE' }], ingest: { continuity: 'matched', rejections: [{ reason: 'denied-path: fix the destination' }] } });
  });
  it('reports a new publication as progress', async () => {
    const f = fixtures(); await f.baseline(); f.advance(31 * 60_000);
    f.runs.publishesLastHour.push({ job: 'RQ-FAKE', lane: 'devin', url: null, at: new Date(start + 60_000).toISOString() });
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0]).toMatchObject({ status: 'progress', publishes: [{ job: 'RQ-FAKE' }] });
  });
  it('requires a healthy bounded window before signaling an incident', async () => {
    const f = fixtures(); await f.baseline(); f.advance(29 * 60_000);
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].status).toBe('insufficient-history');
    f.advance(60_000); await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].status).toBe('incident');
    f.runs.sources.metrics = 'degraded'; await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].status).toBe('insufficient-history');
    f.runs.sources.metrics = 'healthy'; f.advance(31 * 60_000);
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].status).toBe('insufficient-history');
  });
  it('does not silently reset a missing, malformed, oversized or future baseline', async () => {
    const f = fixtures(); await f.baseline();
    for (const bad of ['{', '{}', ' '.repeat(800_001), f.saved.replace('2026-10-31T12:00:00.000Z', '2027-10-31T12:00:00.000Z')]) {
      f.saved = bad; expect(await runLeaderProgressCheck(['--before', 'baseline.json', '--save', 'baseline.json'], f.deps)).toBe(1);
      expect(f.take()[0]).toHaveProperty('error'); expect(f.saved).toBe(bad);
    }
    expect(await runLeaderProgressCheck(['--before', 'missing'], { ...f.deps, readBaseline: async () => { throw new Error('missing'); } })).toBe(1);
  });
  it('marks unmatched or unhealthy ingest history unknown instead of inventing rejections', async () => {
    const f = fixtures(); f.journal.ingest = [{ verb: 'accept', file: 'old.md', reason: null }]; await f.baseline(); f.advance(31 * 60_000);
    f.journal.ingest = [{ verb: 'reject', file: 'new.md', reason: 'fake reason' }];
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].ingest).toEqual({ continuity: 'unknown', rejections: [] });
    f.journal.sources.ingestLog = 'degraded'; await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].ingest).toEqual({ continuity: 'unknown', rejections: [] });
  });
  it('treats an unexplained shorter tail or a redacted row as unknown', async () => {
    const f = fixtures(); f.journal.ingest = [{ verb: 'accept', file: 'new.md', reason: null }, { verb: 'accept', file: 'old.md', reason: null }];
    await f.baseline(); f.advance(30 * 60_000);
    f.journal.ingest.pop(); await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].ingest).toEqual({ continuity: 'unknown', rejections: [] });
    f.journal.ingest = [{ verb: '[redacted line]', file: '', reason: null }];
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].ingest).toEqual({ continuity: 'unknown', rejections: [] });
  });
  it('marks saturated publication evidence insufficient and ignores old or future claims', async () => {
    const f = fixtures(); await f.baseline(); f.advance(31 * 60_000);
    f.runs.claimed.push({ job: 'RQ-OLD', lane: 'devin', tier: 'frontier', at: new Date(start - 1).toISOString() },
      { job: 'RQ-FUTURE', lane: 'devin', tier: 'frontier', at: new Date(start + 40 * 60_000).toISOString() });
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0].status).toBe('insufficient-history');
    f.runs.claimed = [];
    f.runs.publishesLastHour = Array.from({ length: 50 }, (_, i) => ({ job: `RQ-${i}`, lane: null, url: null, at: new Date(start - 1000).toISOString() }));
    await runLeaderProgressCheck(['--before', 'baseline.json'], f.deps);
    expect(f.take()[0]).toMatchObject({ status: 'insufficient-history', claims: [], publishes: [] });
  });
  it('supports finite injected waiting and removes signal listeners', async () => {
    const f = fixtures(), before = process.listenerCount('SIGINT');
    const code = await runLeaderProgressCheck(['--wait-seconds', '1800'], { ...f.deps, wait: async ms => { expect(ms).toBe(1_800_000); f.advance(ms); } });
    expect(code).toBe(0); expect(f.take()[0].status).toBe('incident'); expect(process.listenerCount('SIGINT')).toBe(before);
    expect(await runLeaderProgressCheck(['--wait-seconds', '3601'], f.deps)).toBe(2);
    expect(await runLeaderProgressCheck(['--wait-seconds', '1', '--before', 'x'], f.deps)).toBe(2);
  });
  it('writes a sanitized snapshot atomically and reads it back without touching live state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leader-progress-')); dirs.push(dir); const path = join(dir, 'snapshot.json');
    const f = fixtures(); f.journal.ingest = [{ verb: 'reject', file: 'fake.md', reason: 'private fake words' }];
    const { save: _save, readBaseline: _read, ...deps } = f.deps;
    expect(await runLeaderProgressCheck(['--save', path], deps)).toBe(0);
    expect(await readFile(path, 'utf8')).not.toContain('private fake words');
    f.advance(30 * 60_000);
    expect(await runLeaderProgressCheck(['--before', path, '--save', path], deps)).toBe(0);
    expect(f.take().at(-1)?.status).toBe('incident');
    await writeFile(path, '{');
    expect(await runLeaderProgressCheck(['--before', path, '--save', path], deps)).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('{');
  });
  it('composes the real readers against an isolated runs fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leader-runs-')); dirs.push(dir);
    await Promise.all(['queue', 'metrics', 'leader/drop'].map(path => mkdir(join(dir, path), { recursive: true })));
    await writeFile(join(dir, 'queue/claimed.tsv'), '');
    await writeFile(join(dir, 'metrics/jobs.jsonl'), '');
    await writeFile(join(dir, 'leader/drop/ingest.log'), '2026-10-31T12:00:00Z accept old.md\n');
    const path = join(dir, 'saved.json'); const output: Array<Record<string, unknown>> = []; let now = start;
    const deps = { now: () => now, output: (text: string) => { output.push(JSON.parse(text) as Record<string, unknown>); } };
    expect(await runLeaderProgressCheck(['--runs-dir', dir, '--save', path], deps)).toBe(0);
    now += 31 * 60_000;
    await writeFile(join(dir, 'queue/claimed.tsv'), `RQ-FAKE\tdevin\tfrontier\t12:01\t${(start + 60_000) / 1000}\n`);
    await writeFile(join(dir, 'leader/drop/ingest.log'), '2026-10-31T12:00:00Z accept old.md\n2026-10-31T12:02:00Z reject fake.md denied-path\n');
    expect(await runLeaderProgressCheck(['--runs-dir', dir, '--before', path], deps)).toBe(0);
    expect(output.at(-1)).toMatchObject({ status: 'progress', ingest: { continuity: 'matched', rejections: [{ reason: 'denied-path' }] } });
  });
});
