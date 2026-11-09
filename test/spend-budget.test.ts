import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdBudget } from '../src/cli/budget.js';
import { AGENT_ENV_MARKERS } from '../src/core/teams/identity.js';
import { recordOperatorApproval } from '../src/core/vision/leader-operator.js';
import {
  DEFAULT_SPEND_BUDGET,
  budgetFor,
  parseSpendBudget,
  spendAllowsPayPerUse,
  spendBudgetChangeRefused,
  spendBudgetPolicyHash,
} from '../src/core/spend/budget-policy.js';
import { readSpendBudget, setSpendBudget, SpendBudgetOwnerError, spendBudgetAuditPath, spendBudgetPath } from '../src/core/spend/budget-store.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'spend-budget-')); roots.push(dir); return dir; };

async function withHome(dir: string, fn: () => Promise<void>): Promise<void> {
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    await fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
}

async function withTty(value: boolean, fn: () => Promise<void>): Promise<void> {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, get: () => value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, get: () => value });
  try {
    await fn();
  } finally {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

async function withoutMarkers(fn: () => Promise<void>): Promise<void> {
  const saved = AGENT_ENV_MARKERS.map((key) => [key, process.env[key]] as const);
  for (const key of AGENT_ENV_MARKERS) delete process.env[key];
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
    delete process.env['CURSOR_AGENT'];
    let next;
    await withHome(dir, async () => {
      await withTty(true, async () => {
        await withoutMarkers(async () => {
          next = await setSpendBudget(
            { provider: 'claude-api', period: 'month', usd: 20 },
            { env: {}, root: dir, now: () => new Date('2026-11-09T12:00:00.000Z') },
          );
        });
      });
    });
    expect(next!.entries).toEqual([{ provider: 'claude-api', period: 'month', usd: 20 }]);
    const audit = readFileSync(spendBudgetAuditPath(dir), 'utf8').trim();
    expect(JSON.parse(audit)).toEqual({
      at: '2026-11-09T12:00:00.000Z', provider: 'claude-api', period: 'month', fromUsd: 0, toUsd: 20, by: 'owner',
    });
    expect(readFileSync(spendBudgetPath(dir), 'utf8')).not.toContain('CURSOR_AGENT');
  });
});

describe('spend budget attestation', () => {
  it('refuses a set when env markers are unset and the terminal is not a TTY', async () => {
    const dir = root();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withHome(dir, async () => {
      await withTty(false, async () => {
        await withoutMarkers(async () => {
          await expect(setSpendBudget(
            { provider: 'claude-api', period: 'month', usd: 20 },
            { env: {}, root: dir },
          )).rejects.toThrow('interactive terminal');
          expect(await cmdBudget(['set', '--provider', 'claude-api', '--period', 'month', '--usd', '5', '--json'])).toBe(2);
        });
      });
    });
    expect(String(error.mock.calls[0]?.[0])).toContain('interactive terminal');
    expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(0);
  });

  it('gives a hand-written budget above 0 with no attestation an effective budget of 0', async () => {
    const dir = root();
    const file = spendBudgetPath(dir);
    writeFileSync(file, `${JSON.stringify({
      schema: 'spend.budget.v1',
      entries: [{ provider: 'claude-api', period: 'month', usd: 20 }],
    })}\n`);
    await withHome(dir, async () => {
      const read = await readSpendBudget(dir);
      expect(budgetFor(read.policy, 'claude-api')).toBe(0);
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).entries[0].usd).toBe(20);
  });

  it('gives a tampered attestation an effective budget of 0', async () => {
    const dir = root();
    await withHome(dir, async () => {
      await withTty(true, async () => {
        await withoutMarkers(async () => {
          await setSpendBudget(
            { provider: 'claude-api', period: 'month', usd: 20 },
            { env: {}, root: dir },
          );
        });
      });
      const file = spendBudgetPath(dir);
      const stored = JSON.parse(readFileSync(file, 'utf8')) as { entries: { usd: number }[] };
      stored.entries[0]!.usd = 99;
      writeFileSync(file, `${JSON.stringify(stored)}\n`);
      expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(0);

      const hash = spendBudgetPolicyHash({
        schema: 'spend.budget.v1',
        entries: [{ provider: 'claude-api', period: 'month', usd: 15 }],
      });
      recordOperatorApproval({
        actionId: hash,
        memoId: 'lm-20261109120000-abcdef',
        kind: 'spend-budget',
        summary: 'owner spend budget',
        detail: 'approved',
        channel: 'cli',
        outcome: 'applied',
      });
      writeFileSync(file, `${JSON.stringify({
        schema: 'spend.budget.v1',
        entries: [{ provider: 'claude-api', period: 'month', usd: 15 }],
        attestation: { kind: 'mason-approval', id: hash, digest: `${'a'.repeat(63)}b` },
      })}\n`);
      expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(0);
    });
  });

  it('honors a pin-chain attestation and a verified Mason approval', async () => {
    const dir = root();
    await withHome(dir, async () => {
      await withTty(true, async () => {
        await withoutMarkers(async () => {
          await setSpendBudget(
            { provider: 'claude-api', period: 'month', usd: 20 },
            { env: {}, root: dir },
          );
        });
      });
      expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(20);

      const policy = {
        schema: 'spend.budget.v1' as const,
        entries: [{ provider: 'claude-api', period: 'month' as const, usd: 15 }],
      };
      const hash = spendBudgetPolicyHash(policy);
      recordOperatorApproval({
        actionId: hash,
        memoId: 'lm-20261109120000-abcdef',
        kind: 'spend-budget',
        summary: 'owner spend budget',
        detail: 'approved',
        channel: 'cli',
        outcome: 'applied',
      });
      writeFileSync(spendBudgetPath(dir), `${JSON.stringify({
        ...policy,
        attestation: { kind: 'mason-approval', id: hash, digest: hash },
      })}\n`);
      expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(15);
    });
  });

  it('gives a missing or corrupt file an effective budget of 0', async () => {
    const dir = root();
    expect(await readSpendBudget(dir)).toMatchObject({ source: 'default', policy: DEFAULT_SPEND_BUDGET });
    writeFileSync(spendBudgetPath(dir), '{');
    expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(0);
    writeFileSync(spendBudgetPath(dir), '{"schema":"nope","entries":[]}\n');
    expect(await readSpendBudget(dir)).toMatchObject({ source: 'default' });
    expect(budgetFor((await readSpendBudget(dir)).policy, 'claude-api')).toBe(0);
  });
});

describe('phm budget get and set', () => {
  it('prints the 0 default and refuses an agent set', async () => {
    const dir = root();
    const previous = process.env['ASHLR_HOME'];
    const previousAgent = process.env['CURSOR_AGENT'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withHome(dir, async () => {
      process.env['ASHLR_HOME'] = dir;
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
});
