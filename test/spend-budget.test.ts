import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdBudget } from '../src/cli/budget.js';
import { AGENT_ENV_MARKERS } from '../src/core/teams/identity.js';
import {
  DEFAULT_SPEND_BUDGET,
  budgetFor,
  parseSpendBudget,
  spendAllowsPayPerUse,
  spendBudgetChangeRefused,
} from '../src/core/spend/budget-policy.js';
import { readSpendBudget, setSpendBudget, SpendBudgetOwnerError, spendBudgetAuditPath, spendBudgetPath } from '../src/core/spend/budget-store.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'spend-budget-')); roots.push(dir); return dir; };

describe('spend budget policy', () => {
  it('defaults every unnamed provider to 0 and refuses spend at that budget', () => {
    expect(budgetFor(DEFAULT_SPEND_BUDGET, 'claude-api')).toBe(0);
    expect(budgetFor(DEFAULT_SPEND_BUDGET, 'other-api')).toBe(0);
    expect(spendAllowsPayPerUse({ killed: false, budgetUsd: 0, spentUsd: 0, balanceFresh: true })).toEqual({ allow: false, reason: 'budget' });
    expect(spendAllowsPayPerUse({ killed: false, budgetUsd: 0, spentUsd: null, balanceFresh: true }).allow).toBe(false);
    expect(spendAllowsPayPerUse({ killed: true, budgetUsd: 100, spentUsd: 1, balanceFresh: true })).toEqual({ allow: false, reason: 'kill' });
    expect(spendAllowsPayPerUse({ killed: false, budgetUsd: 25, spentUsd: 10, balanceFresh: true })).toEqual({ allow: true, reason: 'within-budget' });
    const committed = parseSpendBudget(JSON.parse(readFileSync(new URL('../config/spend-budget.json', import.meta.url), 'utf8')));
    expect(committed).toEqual(DEFAULT_SPEND_BUDGET);
  });

  it('lets only the owner change the budget and writes an audit line', async () => {
    const dir = root();
    expect(spendBudgetChangeRefused({ CURSOR_AGENT: '1' })).toBe('CURSOR_AGENT');
    process.env['CURSOR_AGENT'] = '1';
    await expect(setSpendBudget(
      { provider: 'claude-api', period: 'month', usd: 20 },
      { env: {}, root: dir },
    )).rejects.toBeInstanceOf(SpendBudgetOwnerError);
    expect(await readSpendBudget(dir)).toMatchObject({ source: 'default' });
    const saved = AGENT_ENV_MARKERS.map((key) => [key, process.env[key]] as const);
    for (const key of AGENT_ENV_MARKERS) delete process.env[key];
    let next;
    try {
      next = await setSpendBudget(
        { provider: 'claude-api', period: 'month', usd: 20 },
        { env: {}, root: dir, now: () => new Date('2026-11-09T12:00:00.000Z') },
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(next.entries).toEqual([{ provider: 'claude-api', period: 'month', usd: 20 }]);
    const audit = readFileSync(spendBudgetAuditPath(dir), 'utf8').trim();
    expect(JSON.parse(audit)).toEqual({
      at: '2026-11-09T12:00:00.000Z', provider: 'claude-api', period: 'month', fromUsd: 0, toUsd: 20, by: 'owner',
    });
    expect(readFileSync(spendBudgetPath(dir), 'utf8')).not.toContain('CURSOR_AGENT');
  });
});

describe('phm budget get and set', () => {
  it('prints the 0 default and refuses an agent set', async () => {
    const dir = root();
    const previous = process.env['ASHLR_HOME'];
    const previousAgent = process.env['CURSOR_AGENT'];
    process.env['ASHLR_HOME'] = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdBudget(['get', '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ source: 'default', entries: [{ provider: 'claude-api', usd: 0 }] });
      process.env['CURSOR_AGENT'] = '1';
      expect(await cmdBudget(['set', '--provider', 'claude-api', '--period', 'month', '--usd', '5', '--json'])).toBe(2);
      expect(String(error.mock.calls[0]?.[0])).toContain('Agents cannot set a budget');
      expect(await readSpendBudget(dir)).toMatchObject({ source: 'default' });
    } finally {
      if (previousAgent === undefined) delete process.env['CURSOR_AGENT'];
      else process.env['CURSOR_AGENT'] = previousAgent;
      if (previous === undefined) delete process.env['ASHLR_HOME'];
      else process.env['ASHLR_HOME'] = previous;
    }
  });
});
