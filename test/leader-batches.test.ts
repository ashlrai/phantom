import { describe, expect, it } from 'vitest';
import { cmdBets } from '../src/cli/bets.js';
import { leaderBatchOf, leaderBets, leaderBetsLines, parseStaleAfter, type LeaderRunEvidence } from '../src/core/fleet/leader-batches.js';

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
    expect(report.batches.map(b => b.batch)).toEqual(['other', 'N21I']); // RQ-NOSUFFIXQ8 is src=leader, so it counts
    const batch = report.batches.find(b => b.batch === 'N21I')!;
    const stage = Object.fromEntries(batch.bets.map(b => [b.id, b.stage]));
    expect(stage).toEqual({ 'RQ-ALPHAN21IQ8': 'merged', 'RQ-BRAVON21IQ8': 'pr_open', 'RQ-CHARLIEN21IQ8': 'running', 'RQ-DELTAN21IQ8': 'empty', 'RQ-ECHON21IQ8': 'queued' });
    expect(batch.bets.find(b => b.stage === 'empty')!.reason).toBe('already on main');
    expect(batch.bets.find(b => b.stage === 'merged')!.url).toBe(PR);
    expect(batch.counts).toEqual({ queued: 1, running: 1, pr_open: 1, merged: 1, empty: 1, ended: 0 });
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
    const q = [job('RQ-ONEN21IQ8'), job('RQ-TWON21IQ8'), job('RQ-THREEN21IQ8')].join('\n');
    const l = [row({ job: 'RQ-ONEN21IQ8', event: 'outcome', state: 'CLOSED', url: PR, ts: ago(1) }), row({ job: 'RQ-TWON21IQ8', event: 'precheck_skip', code: 3, ts: ago(1) }),
      row({ job: 'RQ-THREEN21IQ8', event: 'skipped_empty', code: 10, ts: ago(1) })].join('\n');
    const bets = leaderBets(q, l, NOW).batches[0]!.bets;
    expect(bets.map(b => [b.stage, b.reason])).toEqual([['empty', 'PR closed without merging'], ['empty', 'precheck 10'], ['empty', 'precheck 3']]);
  });
  it('ignores empty-gate skipped_empty rows and dry-run precheck skips', () => {
    const q = [job('RQ-GATEN21IQ8'), job('RQ-DRYN21IQ8')].join('\n');
    const l = [row({ job: 'RQ-GATEN21IQ8', event: 'skipped_empty', reason: 'task_empty_repeat_24h', ts: ago(1) }),
      row({ job: 'RQ-DRYN21IQ8', event: 'skipped_empty', code: 10, applied: false, ts: ago(1) })].join('\n');
    const bets = leaderBets(q, l, NOW).batches[0]!.bets;
    expect(bets.map(b => [b.stage, b.reason])).toEqual([['queued', null], ['queued', null]]);
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
    expect(json.batches.map((b: { batch: string }) => b.batch)).toEqual(['other', 'N21I', 'N20K']);
    expect(await cmdBets(['--since', 'soon'], deps)).toBe(2);
    expect(await cmdBets(['--json', '--json'], deps)).toBe(2);
  });

  describe('who is a leader job, and which launched jobs ended with no result', () => {
    const q = [job('RQ-PLAINNAME'), 'x', '- READY RQ-NOTAGN21IQ8 (P1, pool=claude, tier=work, repo=phantom): do it', job('RQ-HUMANN21IQ8', 'human'),
      job('RQ-DIEDN21IQ8'), job('RQ-LONGN21IQ8'), job('RQ-FINEN21IQ8')].join('\n');
    const l = [
      row({ job: 'RQ-DIEDN21IQ8', event: 'launch', ts: ago(1) }),
      row({ job: 'RQ-LONGN21IQ8', event: 'launch', ts: ago(5) }),
      row({ job: 'RQ-FINEN21IQ8', event: 'launch', ts: ago(1) }),
      row({ job: 'RQ-HUMANN21IQ8', event: 'launch', ts: ago(1) }),
    ].join('\n');
    const ev = (over: Partial<LeaderRunEvidence> = {}): LeaderRunEvidence => ({ rc: new Map([['RQ-DIEDN21IQ8', 1]]), live: new Set(['RQ-FINEN21IQ8']), staleAfterHours: 3, ...over });
    const by = (e?: LeaderRunEvidence) => Object.fromEntries(leaderBets(q, l, NOW, 24, e).batches.flatMap(b => b.bets).map(b => [b.id, b]));

    it('matches a src=leader row without the suffix, and a suffix row without any tag, but not another producer', () => {
      const bets = by();
      expect(bets['RQ-PLAINNAME']?.stage).toBe('queued');
      expect(bets['RQ-NOTAGN21IQ8']?.stage).toBe('queued');
      expect(bets['RQ-HUMANN21IQ8']).toBeUndefined();
      expect(leaderBets(q, l, NOW, 24).batches.map(b => b.batch).sort()).toEqual(['N21I', 'other']);
    });

    it('an exit code in the run sidecar ends a job with no publish, and says so', () => {
      expect(by(ev())['RQ-DIEDN21IQ8']).toMatchObject({ stage: 'ended', ended_rule: 'exit_code', reason: 'exit code 1 recorded, no result' });
    });

    it('a job over the limit with no live process ended as stale; a live or recent one is still running', () => {
      const bets = by(ev());
      expect(bets['RQ-LONGN21IQ8']).toMatchObject({ stage: 'ended', ended_rule: 'stale', reason: 'running over 3 h with no live process' });
      expect(bets['RQ-FINEN21IQ8']).toMatchObject({ stage: 'running', ended_rule: null });
      expect(by(ev({ staleAfterHours: 6 }))['RQ-LONGN21IQ8']?.stage).toBe('running');
      expect(by(ev({ live: new Set(['RQ-LONGN21IQ8']) }))['RQ-LONGN21IQ8']?.stage).toBe('running');
    });

    it('unreadable evidence never guesses: jobs stay running', () => {
      expect(by(ev({ rc: null, live: null }))['RQ-LONGN21IQ8']?.stage).toBe('running');
      expect(by()['RQ-DIEDN21IQ8']?.stage).toBe('running');
    });

    it('prints the rule in plain words and counts ended apart from judged', () => {
      const report = leaderBets(q, l, NOW, 24, ev());
      expect(leaderBetsLines(report).join('\n')).toContain('RQ-DIEDN21IQ8  ended, no result (exit code 1 recorded, no result)');
      expect(report.batches.find(b => b.batch === 'N21I')).toMatchObject({ counts: { ended: 2, running: 1 }, judged: 0, hit_rate: null });
    });

    it('parses the stale limit', () => {
      expect([parseStaleAfter('3h'), parseStaleAfter('90m'), parseStaleAfter('1d'), parseStaleAfter('0h'), parseStaleAfter('soon')]).toEqual([3, 1.5, 24, null, null]);
    });
  });
});
