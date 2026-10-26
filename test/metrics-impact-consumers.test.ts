import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adviseImpactBandit } from '../src/core/fabric/optimizer.js';
import { rankJevImpact } from '../src/core/decide/impact.js';
import { IMPACT_VERSION, rankImpactTemplates, scoreImpact, type ImpactInput } from '../src/core/metrics/impact.js';
import { triageTrigger, triageTriggerHeuristic, type TriageContext } from '../src/core/decide/triage.js';
import { decide } from '../src/core/decide/decide.js';

vi.mock('../src/core/decide/decide.js', () => ({ decide: vi.fn(async () => ({ path: 'fallback' })) }));

const history: ImpactInput[] = [
  { id: 'empty', repo: 'ashlrai/phantom', template: 'routine', status: 'empty' },
  { id: 'bold', repo: 'ashlrai/phantom', template: 'ambitious', status: 'merged', additions: 900,
    files: ['src/capability.ts'], labels: ['impact:capability', 'impact:autonomy', 'risk:tier-1', 'impact:novel'] },
];
const context: TriageContext = {
  playbooks: [
    { id: 'routine', when: 'Routine repairs.', keywords: ['repair'] },
    { id: 'ambitious', when: 'Substantial capability repairs.', keywords: ['repair'] },
  ],
  impactHistory: history,
};
const trigger = { source: 'issue', title: 'Repair the agent capability' };

beforeEach(() => vi.clearAllMocks());

describe('shared impact consumers', () => {
  it('bandit recommendation and template ranking use exactly the same policy', () => {
    const advice = adviseImpactBandit(history);
    expect(advice).toEqual({ version: IMPACT_VERSION, advisory: true,
      recommendation: rankImpactTemplates(history)[0], ranking: rankImpactTemplates(history) });
    expect(advice.recommendation?.template).toBe('ambitious');
    expect(adviseImpactBandit([]).recommendation).toBeNull();
  });

  it('Jev consumes the identical reward with overrides and deduplicates observations', () => {
    const overrides = { bold: { capability: 0.4, autonomy: 0.2 } };
    const ranked = rankJevImpact([...history, history[1]!], overrides);
    expect(ranked.version).toBe(IMPACT_VERSION);
    expect(ranked.advisory).toBe(true);
    expect(ranked.outcomes).toEqual([
      scoreImpact(history[1]!, overrides.bold), scoreImpact(history[0]!),
    ]);
    expect(adviseImpactBandit(history, overrides).ranking[0]?.totalReward).toBe(ranked.outcomes[0]?.reward);
  });

  it('uses observed impact for matching playbooks while preserving legacy ordering without history', () => {
    expect(triageTriggerHeuristic(trigger, context).playbook).toBe('ambitious');
    expect(triageTriggerHeuristic(trigger, { playbooks: context.playbooks }).playbook).toBe('routine');
    expect(triageTriggerHeuristic({ source: 'issue', title: 'Unrelated task' }, context).playbook).toBeNull();
  });

  it('changes advice without changing work admission or the lane', () => {
    const declined = { source: 'issue', title: 'Repair question', labels: ['question'] };
    const withHistory = triageTriggerHeuristic(declined, context);
    const withoutHistory = triageTriggerHeuristic(declined, { playbooks: context.playbooks });
    expect(withHistory.work).toBe(false);
    expect(withHistory.lane).toBe(withoutHistory.lane);
  });

  it('falls back to the original playbooks when advisory evidence is invalid', () => {
    expect(triageTriggerHeuristic(trigger, {
      ...context, impactHistory: [{ ...history[1]!, tokens: -1 }],
    }).playbook).toBe('routine');
  });

  it('adds versioned reward to the existing Jev call and invalidates its cache when evidence changes', async () => {
    await triageTrigger(trigger, context);
    expect(decide).toHaveBeenCalledTimes(1);
    const [, , questions, options] = vi.mocked(decide).mock.calls[0]!;
    const playbook = questions['playbook'];
    expect(playbook?.type).toBe('choice');
    if (playbook?.type !== 'choice') throw new Error('Expected playbook choice');
    expect(playbook.criteria['ambitious']).toContain(IMPACT_VERSION);
    expect(playbook.criteria['ambitious']).toContain('mean reward');
    expect(Object.keys(playbook.criteria)).toEqual(['none', 'ambitious', 'routine']);
    await triageTrigger(trigger, { ...context, impactOverrides: { bold: { capability: 0, autonomy: 0 } } });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(vi.mocked(decide).mock.calls[1]![3]?.cacheSalt).not.toBe(options?.cacheSalt);
  });
});
