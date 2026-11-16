import { describe, expect, it } from 'vitest';
import { buildLeaderBrief, type BriefInputs } from '../src/core/fleet/leader-brief.js';

const empty: BriefInputs = { merges24h: null, openPrs: null, installed: null, latest: null, needsMason: null, goals: null, lanes: null };
const goal = (objective: string) => ({ objective, status: 'active', fractionDone: 0.5 });
describe('leader brief', () => {
  it('keeps unavailable inputs unknown', () => {
    const brief = buildLeaderBrief(empty, 0);
    expect(brief.text.match(/unknown/g)?.length).toBe(7);
    expect(brief.release.behind).toBeNull();
  });
  it('renders bounded measured data and selects three goals', () => {
    const brief = buildLeaderBrief({ merges24h: 4, openPrs: 8, installed: '1.2.3', latest: '1.3.0', needsMason: 2, goals: Array.from({ length: 5 }, (_, i) => goal(`${i}${'x'.repeat(1000)}`)), lanes: Array(20).fill('lane') }, 0);
    expect(brief.release.behind).toBe(true);
    expect(brief.goals).toHaveLength(3);
    expect(brief.text.length).toBeLessThanOrEqual(700);
    expect(brief.text.split('\n').length).toBeLessThanOrEqual(8);
    expect(brief.text).toContain('Merges (24h): 4');
  });
});
