import { describe, expect, it } from 'vitest';
import { cmdBets } from '../src/cli/bets.js';
import { leaderBatchOf, leaderBets, leaderBetsLines } from '../src/core/fleet/leader-batches.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const job = (id: string, src = 'leader') => `- READY ${id} (P1, pool=claude, tier=work, repo=phantom, src=${src}): do it`;
const row = (r: Record<string, unknown>) => JSON.stringify(r);
const PR = 'https://github.com/ashlrai/phantom/pull/12';

const queue = [
  job('RQ-ALPHAN21IQ8'), job('RQ-BRAVON21IQ8'), job('RQ-CHARLIEN21IQ8'), job('RQ-DELTAN21IQ8'), job('RQ-ECHON21IQ8'),
  job('RQ-HUMANN21IQ8', 'human'), job('RQ-OLDN20KQ8'), job('RQ-NOSUFFIXQ8'),
].join('\n');
const ledger = [
  row({ job: 'RQ-ALPHAN21IQ8', event: 'launch', ts: ago(3) }),
  row({ job: 'RQ-ALPHAN21IQ8', event: 'outcome', state: 'MERGED', url: PR, ts: ago(1) }),
  row({ job: 'RQ-BRAVON21IQ8', event: 'launch', ts: ago(3) }),
  row({ job: 'RQ-BRAVON21IQ8', event: 'publish', url: PR, ts: ago(2) }),
  row({ job: 'RQ-CHARLIEN21IQ8', event: 'launch', ts: ago(2) }),
  row({ job: 'RQ-DELTAN21IQ8', event: 'launch', ts: ago(3) }),
  row({ job: 'RQ-DELTAN21IQ8', event: 'finish', empty: true, empty_reason: 'already on main', ts: ago(2) }),
  row({ job: 'RQ-HUMANN21IQ8', event: 'launch', ts: ago(1) }),
  row({ job: 'RQ-OLDN20KQ8', event: 'launch', ts: ago(60) }),
  'not json',
].join('\n');

describe('leader batches', () => {
  it('reads the batch from the N<day><letter>Q8 suffix only', () => {
    expect(leaderBatchOf('RQ-FEEDBETSN21IQ8')).toBe('N21I');
    expect(leaderBatchOf('RQ-MERGEWAIT20Q8')).toBeNull();
    expect(leaderBatchOf('RQ-NOSUFFIXQ8')).toBeNull();
  });

  it('groups src=leader jobs by batch and shows each stage', () => {
    const report = leaderBets(queue, ledger, NOW, 24);
    expect(report.schema).toBe('fleet.leader-bets.v1');
    // N20K had its only activity 60h ago: outside the window. The human job and the suffix-less job are not bets.
    expect(report.batches.map(b => b.batch)).toEqual(['N21I']);
    const batch = report.batches[0]!;
    const stage = Object.fromEntries(batch.bets.map(b => [b.id, b.stage]));
    expect(stage).toEqual({ 'RQ-ALPHAN21IQ8': 'merged', 'RQ-BRAVON21IQ8': 'pr_open', 'RQ-CHARLIEN21IQ8': 'running', 'RQ-DELTAN21IQ8': 'empty', 'RQ-ECHON21IQ8': 'queued' });
    expect(batch.bets.find(b => b.stage === 'empty')!.reason).toBe('already on main');
    expect(batch.bets.find(b => b.stage === 'merged')!.url).toBe(PR);
    expect(batch.counts).toEqual({ queued: 1, running: 1, pr_open: 1, merged: 1, empty: 1 });
    // merged 1 of judged 2 (merged + empty); PR open, running and queued are not judged yet.
    expect(batch.judged).toBe(2);
    expect(batch.hit_rate).toBe(0.5);
  });

  it('keeps separate batches apart, newest first', () => {
    const q = [job('RQ-ONEN21IQ8'), job('RQ-TWON21JQ8')].join('\n');
    const l = [row({ job: 'RQ-ONEN21IQ8', event: 'outcome', state: 'MERGED', ts: ago(5) }), row({ job: 'RQ-TWON21JQ8', event: 'outcome', state: 'MERGED', ts: ago(1) })].join('\n');
    expect(leaderBets(q, l, NOW).batches.map(b => b.batch)).toEqual(['N21J', 'N21I']);
  });

  it('says unknown, not 0%, for a batch with no outcomes yet', () => {
    const q = [job('RQ-ONEN21IQ8'), job('RQ-TWON21IQ8')].join('\n');
    const l = row({ job: 'RQ-ONEN21IQ8', event: 'launch', ts: ago(1) });
    const batch = leaderBets(q, l, NOW).batches[0]!;
    expect(batch.judged).toBe(0);
    expect(batch.hit_rate).toBeNull();
    expect(leaderBetsLines(leaderBets(q, l, NOW)).join('\n')).toContain('hit rate unknown (nothing judged yet)');
  });

  it('treats a closed PR and a precheck skip as empty with a reason', () => {
    const q = [job('RQ-ONEN21IQ8'), job('RQ-TWON21IQ8')].join('\n');
    const l = [row({ job: 'RQ-ONEN21IQ8', event: 'outcome', state: 'CLOSED', url: PR, ts: ago(1) }), row({ job: 'RQ-TWON21IQ8', event: 'precheck_skip', code: 3, ts: ago(1) })].join('\n');
    const bets = leaderBets(q, l, NOW).batches[0]!.bets;
    expect(bets.map(b => [b.stage, b.reason])).toEqual([['empty', 'PR closed without merging'], ['empty', 'precheck 3']]);
  });

  it('takes the producer from a launch row when the queue line is gone', () => {
    const l = row({ job: 'RQ-ONEN21IQ8', event: 'launch', src: 'leader', ts: ago(1) });
    expect(leaderBets('', l, NOW).batches[0]!.bets[0]!.stage).toBe('running');
    expect(leaderBets(null, null, NOW)).toMatchObject({ known: false, queue_known: false, batches: [] });
  });

  it('phm bets prints batches and JSON with a schema id, and rejects bad flags', async () => {
    const out: string[] = [], err: string[] = [];
    const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => new Date(NOW), leaderBets: async (o: { hours: number; now: number }) => leaderBets(queue, ledger, o.now, o.hours) };
    expect(await cmdBets([], deps)).toBe(0);
    expect(out[0]).toContain('Batch N21I (5 bets): hit rate 50% (1 of 2 judged merged)');
    out.length = 0;
    expect(await cmdBets(['--since', '3d', '--json'], deps)).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json.schema).toBe('fleet.leader-bets.v1');
    expect(json.window_hours).toBe(72);
    expect(json.batches.map((b: { batch: string }) => b.batch)).toEqual(['N21I', 'N20K']);
    expect(await cmdBets(['--since', 'soon'], deps)).toBe(2);
    expect(await cmdBets(['--json', '--json'], deps)).toBe(2);
  });
});
