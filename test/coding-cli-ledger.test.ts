import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { roleAllowed } from '../src/core/routing/backend-roles.js';
import { appendSpendDecision, readSpendDecisions, reweight, type SpendDecision } from '../src/core/providers/coding-cli/ledger.js';

function row(partial: Partial<SpendDecision> & Pick<SpendDecision, 'poolId' | 'merged' | 'ci' | 'cost'>): SpendDecision {
  return {
    ts: '2026-10-26T02:00:00.000Z',
    billing: 'subscription',
    balanceKnown: false,
    expiryKnown: false,
    complexity: 'medium',
    risk: 'low',
    backend: 'codex',
    accountId: 'codex-primary',
    model: null,
    escalations: 0,
    verification: 'passed',
    timeMs: 1000,
    quota: null,
    ...partial,
  };
}

describe('spend ledger', () => {
  it('appends decisions and reweights from merge rate, CI, and cost without changing roles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ledger-'));
    const file = join(dir, 'spend.jsonl');
    const before = roleAllowed('subscription', 'merge');
    appendSpendDecision(file, row({ poolId: 'codex:codex-primary', merged: true, ci: 'passed', cost: 0 }));
    const first = readFileSync(file, 'utf8');
    appendSpendDecision(file, row({
      poolId: 'codex:codex-primary', merged: true, ci: 'passed', cost: 0, balanceKnown: false, expiryKnown: false,
    }));
    appendSpendDecision(file, row({
      poolId: 'cloud-credits', billing: 'credit', merged: true, ci: 'passed', cost: 3, balanceKnown: false, expiryKnown: false,
    }));
    expect(readFileSync(file, 'utf8').startsWith(first)).toBe(true);
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`, 'utf8');
    const rows = readSpendDecisions(file);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.balanceKnown).toBe(false);
    const weights = reweight(rows);
    expect(weights['codex:codex-primary']).toBeGreaterThan(0);
    expect(weights['cloud-credits']).toBeLessThan(weights['codex:codex-primary']!);
    expect(reweight([row({ poolId: 'devin-acu', billing: 'metered', merged: false, ci: 'unknown', cost: null })])['devin-acu']).toBe(0);
    expect(roleAllowed('subscription', 'merge')).toBe(before);
    expect(roleAllowed('metered', 'credential')).toBe(false);
    expect(roleAllowed('local', 'merge')).toBe(false);
  });
});
