import { describe, expect, it } from 'vitest';
import { appBudgetLabel, projectAppBudgets } from '../src/core/resources/app-budgets.js';
const now = Date.parse('2026-11-02T12:00:00Z');
describe('public app budgets', () => {
  it('projects only measured numeric fields and dates', () => {
    const rows = projectAppBudgets({ 'claude-org': { as_of: new Date(now).toISOString(), monthly_credits_usd: 200, token: 'private-sentinel' }, grok: { as_of: new Date(now).toISOString(), pacing_percent_per_day: 13 } }, now);
    expect(rows[0]?.monthlyCreditsUsd).toBe(200);
    expect(rows[3]?.pacingPercentPerDay).toBe(13);
    expect(JSON.stringify(rows)).not.toContain('private-sentinel');
    expect(rows.every(row => row.usedPercent === null)).toBe(true);
  });
  it('renders absent, stale and invalid readings as unknown', () => {
    for (const source of [null, { grok: { as_of: '2020-01-01T00:00:00Z', used_percent: 13 } }, { grok: { as_of: new Date(now).toISOString(), used_percent: 101, monthly_credits_usd: 'secret' } }]) {
      const row = projectAppBudgets(source, now)[3]!;
      expect(row.usedPercent).toBeNull();
      expect(appBudgetLabel(row)).toContain('unknown');
      expect(appBudgetLabel(row)).not.toContain('13%');
    }
  });
});
