import { describe, expect, it } from 'vitest';
import { slackItemLadder, type LadderReturn } from '../src/web-ui/routes/verse/slack/slack-item-ladder.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const th = (k: string, min = 90) => ({ threadKey: k, at: ago(min) });
const ret = (o: Partial<LadderReturn>): LadderReturn => ({
  claimId: 'c-1', result: 'VERIFIED', evidenceKind: 'tests', pr: null, head: null, evidence: 'x', at: ago(1), ...o });

describe('slackItemLadder', () => {
  it('owner without a claim receipt is RECEIVED, not ASSIGNED', () => {
    const [r] = slackItemLadder([th('t1')], [{ threadKey: 't1', owner: 'agent-a', claimId: null }], [], NOW);
    expect(r?.state).toBe('RECEIVED');
    expect(r?.owner).toBe('agent-a');
  });
  it('claim plus fresh run evidence is RUNNING', () => {
    const [r] = slackItemLadder([th('t1')], [{ threadKey: 't1', owner: 'a', claimId: 'c-1', liveAt: ago(2) }], [], NOW);
    expect(r?.state).toBe('RUNNING');
    expect(r?.evidence).toBe('c-1');
    expect(r?.stale).toBe(false);
  });
  it('a named blocker is BLOCKED and sorts first', () => {
    const rows = slackItemLadder([th('t1'), th('t2'), th('t3')], [
      { threadKey: 't1', owner: 'a', claimId: 'c-1', liveAt: ago(1) },
      { threadKey: 't3', owner: 'b', claimId: 'c-3' }],
    [ret({ claimId: 'c-3', result: 'BLOCKED', evidenceKind: 'dependency', evidence: 'waits on c-9' })], NOW);
    expect(rows.map(r => [r.threadLabel, r.state])).toEqual([['t3', 'BLOCKED'], ['t2', 'RECEIVED'], ['t1', 'RUNNING']]);
  });
  it('a PR head with passing tests is VERIFIED', () => {
    const [r] = slackItemLadder([th('t1')], [{ threadKey: 't1', owner: 'a', claimId: 'c-1' }],
      [ret({ evidenceKind: 'pr', pr: 9001, head: 'abcdef1' }), ret({ evidenceKind: 'tests' })], NOW);
    expect(r?.state).toBe('VERIFIED');
    expect(r?.evidence).toBe('PR #9001');
  });
  it('a PR head without passing tests is not VERIFIED', () => {
    const [r] = slackItemLadder([th('t1')], [{ threadKey: 't1', owner: 'a', claimId: 'c-1' }],
      [ret({ evidenceKind: 'pr', pr: 9001, head: 'abcdef1' })], NOW);
    expect(r?.state).toBe('ASSIGNED');
  });
  it('31-minute-old evidence is stale, 29 is not', () => {
    const claim = (m: number) => [{ threadKey: 't1', owner: 'a', claimId: 'c-1', liveAt: ago(m) }];
    expect(slackItemLadder([th('t1')], claim(31), [], NOW)[0]?.stale).toBe(true);
    expect(slackItemLadder([th('t1')], claim(29), [], NOW)[0]?.stale).toBe(false);
  });
  it('two deliveries of one thread give one row with the earliest first-seen', () => {
    const rows = slackItemLadder([th('t1', 50), th('t1', 80)], [], [], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.firstSeenIso).toBe(ago(80));
    expect(rows[0]?.owner).toBe('unknown');
  });
});
