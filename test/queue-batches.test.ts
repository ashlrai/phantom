import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readQueueBatches, formatQueueBatches } from '../src/core/queue/batches.js';
import { cmdQueue } from '../src/cli/queue.js';

const roots: string[] = [];
const created = 1_800_000_000;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'queue-batches-')); roots.push(root);
  await mkdir(join(root, 'queue', 'batches'), { recursive: true });
  await mkdir(join(root, 'queue', 'run'));
  return root;
}
function manifest(area: string, count = 4) {
  const members = Array.from({ length: count }, (_, i) => ({ job: `RQ-${area}-${i}` }));
  return { schema: 'dispatchd.batch.v1', id: `RQ-BATCH-${area}`, repo: 'phantom', area: `src/core/${area}`,
    created_at: created, mode: 'per-line', members, handled: Object.fromEntries(members.map(m => [m.job, 'done'])),
    results: Object.fromEntries(members.map(m => [m.job, { outcome: 'done', reason: 'Tests passed' }])) };
}
async function save(root: string, batch: ReturnType<typeof manifest>) {
  await writeFile(join(root, 'queue', 'batches', `${batch.id}.json`), JSON.stringify(batch));
}
async function publish(root: string, batch: ReturnType<typeof manifest>, job: string, text: string) {
  await writeFile(join(root, 'queue', 'run', `${job}.bundled-in`), batch.id);
  const path = join(root, `${job}.publish`);
  await writeFile(path, text); await utimes(path, created + 10, created + 10);
}

describe('per-line batch session evidence', () => {
  it('reports the top five 24h empty finish prefixes through queue JSON, independent of batch evidence', async () => {
    const home = await fixture(), root = join(home, '.ashlr-runs'); vi.stubEnv('HOME', home);
    await mkdir(join(root, 'metrics'), { recursive: true });
    const path = join(root, 'metrics', 'jobs.jsonl'), now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const row = (job: string, fields = {}) => JSON.stringify({ job, event: 'finish', empty: true, ts: new Date(now - 1000).toISOString(), ...fields });
    const rows = [row('INC-d-codex-personal-3a2517a4'), row('INC-d-codex-personal-eeeeeeee'),
      row('RQ-TESTA123456Q8'), row('RQ-TESTA654321Q8'), ...['C', 'D', 'E', 'F'].map(p => row(`RQ-${p}-1`)),
      row('RQ-NONEMPTY', { empty: false }), row('RQ-NOOP', { event: 'outcome', state: 'DONE-NOOP' }),
      row('RQ-OLD', { ts: new Date(now - 86400001).toISOString() }), row('RQ-FUTURE', { ts: new Date(now + 60000).toISOString() })];
    await writeFile(path, rows.join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['--json'])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0][0]));
    expect(report.evidence).toBe('unknown'); // No batch directory; metrics remain usable.
    expect(report.emptyPrefixes).toEqual({ windowHours: 24, evidence: 'available', total: 8, malformedLines: 0,
      top: [{ prefix: 'INC-d-codex-personal', count: 2 }, { prefix: 'RQ-TESTA', count: 2 },
        ...['C', 'D', 'E'].map(p => ({ prefix: `RQ-${p}`, count: 1 }))] });
    await writeFile(path, [...rows, rows[0], '{bad', row('../unsafe'), row('RQ-UNKNOWN', { empty: null }), row('RQ-NOZONE', { ts: '2026-11-16T12:00:00' })].join('\n'));
    expect((await readQueueBatches(root)).emptyPrefixes).toMatchObject({ evidence: 'partial', total: 9, malformedLines: 4 });
    await writeFile(path, ' '.repeat(16 * 1024 * 1024 + 1));
    expect((await readQueueBatches(root)).emptyPrefixes.evidence).toBe('unknown');
    await rm(path);
    expect((await readQueueBatches(root)).emptyPrefixes).toMatchObject({ evidence: 'unknown', total: null, top: [] });
    await writeFile(join(root, 'other.jsonl'), rows.join('\n'));
    await symlink(join(root, 'other.jsonl'), path);
    expect((await readQueueBatches(root)).emptyPrefixes.evidence).toBe('unknown');
  });

  it('counts empty finish rows across the jobs-ledger field dialect', async () => {
    const home = await fixture(), root = join(home, '.ashlr-runs');
    await mkdir(join(root, 'metrics'), { recursive: true });
    const now = Date.now(), iso = (ms: number) => new Date(now + ms).toISOString();
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), [
      JSON.stringify({ job_id: 'RQ-DIA-1', type: 'finish', empty: true, timestamp: iso(-1000) }),
      JSON.stringify({ id: 'RQ-DIA-2', kind: 'finish', empty: true, at: iso(-2000) }),
      JSON.stringify({ job: 'RQ-DIA-3', event: 'finish', empty: true, time: iso(-3000) }),
      JSON.stringify({ job: 'RQ-DIA-9', event: 'outcome', state: 'MERGED', mergedAt: iso(-4000) }),
    ].join('\n'));
    expect((await readQueueBatches(root)).emptyPrefixes).toMatchObject({ evidence: 'available', total: 3, malformedLines: 0,
      top: [{ prefix: 'RQ-DIA', count: 3 }] });
  });

  it('exposes admission reasons through queue JSON and keeps stale or invalid evidence unknown', async () => {
    const root = await fixture(), runs = join(root, '.ashlr-runs'), path = join(runs, 'queue', 'ranking.json');
    await mkdir(join(runs, 'queue'), { recursive: true }); vi.stubEnv('HOME', root);
    const ranking = { at: Date.now() / 1000, decisions: [{ job: 'RQ-A', mergeRate: null, sampledLaunches: 0,
      unknownLaunches: 1, score: 1, reason: 'target_pr_merged', outcome: 'DONE-NOOP' }] };
    await writeFile(path, JSON.stringify(ranking));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0])).ranking).toEqual(ranking);
    for (const invalid of [{ ...ranking, at: ranking.at - 301 }, { ...ranking, at: ranking.at + 301 },
      { ...ranking, decisions: [{ ...ranking.decisions[0], reason: 'untrusted arbitrary text' }] }]) {
      await writeFile(path, JSON.stringify(invalid));
      expect((await readQueueBatches(runs)).ranking).toBeNull();
    }
  });

  it('accepts the already-merged admission reason without degrading ranking to unknown', async () => {
    const root = await fixture(), runs = join(root, '.ashlr-runs'), path = join(runs, 'queue', 'ranking.json');
    await mkdir(join(runs, 'queue'), { recursive: true });
    const ranking = { at: Date.now() / 1000, decisions: [{ job: 'RQ-A', mergeRate: null, sampledLaunches: 0,
      unknownLaunches: 1, score: 1, reason: 'already-merged', outcome: 'DONE-NOOP' }] };
    await writeFile(path, JSON.stringify(ranking));
    expect((await readQueueBatches(runs)).ranking).toEqual(ranking);
  });

  it('reports 12 outcomes in 3 sessions, isolates failure and preserves empty reasons and auto-merge evidence', async () => {
    const root = await fixture();
    for (const area of ['queue', 'agents', 'fleet']) {
      const batch = manifest(area);
      for (const [i, member] of batch.members.entries()) {
        if (area === 'queue' && i === 0) {
          batch.handled[member.job] = 'failed';
          batch.results[member.job] = { outcome: 'failed', reason: 'Test failed' };
        } else if (area === 'queue' && i === 1) {
          batch.handled[member.job] = 'skipped';
          batch.results[member.job] = { outcome: 'skipped', reason: 'Already fixed' };
          await publish(root, batch, member.job, 'RESULT EMPTY\n');
        } else await publish(root, batch, member.job, `AUTO_MERGE on\nRESULT PR https://github.com/ashlrai/phantom/pull/${['queue', 'agents', 'fleet'].indexOf(area) * 4 + i + 1}\n`);
      }
      await save(root, batch);
    }
    const report = await readQueueBatches(root);
    expect(report.totals).toEqual({ sessions: 3, lines: 12, pr: 10, empty: 1, failed: 1, unknown: 0 });
    expect(new Set(report.sessions.flatMap(s => s.outcomes).filter(o => o.pr).map(o => o.pr)).size).toBe(10);
    expect(report.sessions.flatMap(s => s.outcomes).filter(o => o.outcome === 'pr').every(o => o.autoMerge === 'armed')).toBe(true);
    expect(report.sessions.find(s => s.id === 'RQ-BATCH-queue')?.outcomes.slice(0, 2).map(o => o.reason)).toEqual(['Test failed', 'Already fixed']);
    expect(formatQueueBatches(report)).toBe('3 sessions, 12 lines: 10 PRs, 1 empty, 1 failed, 0 unknown; auto-merge 10 armed, 0 off, 0 unknown.');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['--json', 'batches', '--runs', root])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(report);
    log.mockClear();
    expect(await cmdQueue(['batches', '--runs', root])).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(formatQueueBatches(report));
    log.mockClear();
    expect(await cmdQueue(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0])).schema).toBe('phantom.queue-batches.v1');
  });

  it('keeps missing, stale, wrong-owner and wrong-repo receipts unknown', async () => {
    const root = await fixture(), batch = manifest('queue'); await save(root, batch);
    await publish(root, batch, batch.members[1].job, 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n');
    await utimes(join(root, `${batch.members[1].job}.publish`), created - 1, created - 1);
    await publish(root, batch, batch.members[2].job, 'RESULT PR https://github.com/ashlrai/phantom/pull/2\n');
    await writeFile(join(root, 'queue', 'run', `${batch.members[2].job}.bundled-in`), 'RQ-BATCH-other');
    await publish(root, batch, batch.members[3].job, 'RESULT PR https://github.com/ashlrai/locus/pull/3\n');
    expect((await readQueueBatches(root)).totals?.unknown).toBe(4);
  });

  it('uses final receipt evidence without inferring auto-merge from a PR', async () => {
    const root = await fixture(), batch = manifest('queue'); await save(root, batch);
    await publish(root, batch, batch.members[0].job, 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n');
    await publish(root, batch, batch.members[1].job, 'RESULT PR https://github.com/ashlrai/phantom/pull/2\nAUTO_MERGE on\nAUTO_MERGE off\n');
    await publish(root, batch, batch.members[2].job, 'RESULT PR https://github.com/ashlrai/phantom/pull/3\nRESULT DENIED policy\n');
    await publish(root, batch, batch.members[3].job, 'AUTO_MERGE on\nRESULT PR https://github.com/ashlrai/phantom/pull/3\nRESULT PR https://github.com/ashlrai/phantom/pull/4\n');
    const lines = (await readQueueBatches(root)).sessions[0].outcomes;
    expect(lines.map(l => l.autoMerge)).toEqual(['unknown', 'off', 'unknown', 'unknown']);
    expect(lines[2].outcome).toBe('failed');
  });

  it('refuses symlinks and malformed manifests without hiding healthy siblings', async () => {
    const root = await fixture(), batch = manifest('queue', 1); await save(root, batch);
    await writeFile(join(root, 'queue', 'batches', 'broken.json'), '{}');
    await symlink(join(root, 'queue', 'batches', `${batch.id}.json`), join(root, 'queue', 'batches', 'linked.json'));
    await symlink(join(root, 'queue', 'batches', `${batch.id}.json`), join(root, `${batch.members[0].job}.publish`));
    await writeFile(join(root, 'queue', 'run', `${batch.members[0].job}.bundled-in`), batch.id);
    const report = await readQueueBatches(root);
    expect(report.evidence).toBe('partial'); expect(report.totals?.sessions).toBe(1); expect(report.totals?.unknown).toBe(1);
  });

  it('distinguishes unavailable evidence from an empty inventory and rejects bad CLI flags', async () => {
    const root = await fixture();
    expect((await readQueueBatches(root)).totals?.sessions).toBe(0);
    const missing = await readQueueBatches(join(root, 'missing'));
    expect(missing.evidence).toBe('unknown'); expect(missing.totals).toBeNull();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueue(['batches', '--apply', '--json'])).toBe(2);
    expect(await cmdQueue(['--runs', 'batches', '--json', 'batches'])).toBe(0);
  });

  it('scrubs reasons and withholds prompts, invalid member paths and oversized receipts', async () => {
    const root = await fixture(), batch = manifest('queue', 1), job = batch.members[0].job;
    const fakeSecret = 'ghp_' + 'x'.repeat(36);
    batch.handled[job] = 'failed'; batch.results[job] = { outcome: 'failed', reason: `\u001b[31mFailed using ${fakeSecret}\u001b[0m` };
    await save(root, { ...batch, prompt: 'private worker prompt' } as typeof batch);
    let report = await readQueueBatches(root);
    expect(JSON.stringify(report)).not.toContain(fakeSecret); expect(JSON.stringify(report)).not.toContain('private worker prompt');
    expect(report.sessions[0].outcomes[0].reason).not.toContain('\u001b');
    batch.handled[job] = 'done'; await save(root, batch);
    await publish(root, batch, job, 'x'.repeat(1024 * 1024 + 1));
    report = await readQueueBatches(root); expect(report.totals?.unknown).toBe(1);
    batch.members[0].job = '../escape'; await save(root, batch);
    report = await readQueueBatches(root); expect(report.evidence).toBe('partial'); expect(report.sessions).toHaveLength(0);
  });
});
