import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { cmdLearn } from '../src/cli/genome.js';
import { cmdWorker } from '../src/cli/worker.js';
import { roleAllowed } from '../src/core/routing/backend-roles.js';
import { appendSpendDecision, readSpendDecisions, reweight, type SpendDecision } from '../src/core/providers/coding-cli/ledger.js';
import { mineBacklog } from '../src/core/providers/coding-cli/mine.js';

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

  it('mines the ledger, failed CI, and review comments into a local file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-mine-'));
    const ledger = join(dir, 'spend.jsonl');
    const ci = join(dir, 'ci.json');
    const reviews = join(dir, 'reviews.json');
    const out = join(dir, 'backlog.json');
    appendSpendDecision(ledger, row({
      poolId: 'codex:codex-primary', merged: false, ci: 'failed', verification: 'failed', cost: null,
    }));
    appendSpendDecision(ledger, row({
      poolId: 'codex:codex-primary', merged: true, ci: 'passed', verification: 'passed', cost: 0,
    }));
    writeFileSync(ci, JSON.stringify({ runs: [
      { name: 'lint', conclusion: 'failure', url: 'https://example.test/lint' },
      { name: 'unit', conclusion: 'success' },
    ] }));
    writeFileSync(reviews, JSON.stringify([
      { body: 'null check on the pool id', path: 'src/pool.ts', pr: 934 },
      { body: '', path: 'src/empty.ts', pr: 1 },
    ]));
    const before = roleAllowed('loopback', 'merge');
    expect(await cmdLearn(['mine', '--ledger', ledger, '--ci', ci, '--reviews', reviews, '--out', out, '--publish'])).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(await cmdLearn(['mine', '--ledger', ledger, '--ci', ci, '--reviews', reviews, '--out', out])).toBe(0);
    const file = JSON.parse(readFileSync(out, 'utf8')) as {
      version: number;
      published: boolean;
      candidates: { source: string; summary: string }[];
    };
    expect(file.version).toBe(1);
    expect(file.published).toBe(false);
    expect(file.candidates.map((item) => item.source).sort()).toEqual(['ci', 'ledger', 'ledger', 'review']);
    expect(file.candidates.some((item) => item.summary.includes('null check'))).toBe(true);
    expect(file.candidates.some((item) => item.summary.includes('unit'))).toBe(false);
    expect(JSON.stringify(file)).not.toMatch(/issues\/|api\.github\.com/);
    expect(roleAllowed('loopback', 'merge')).toBe(before);
    expect(roleAllowed('local', 'credential')).toBe(false);
    expect(mineBacklog({ ledgerPath: join(dir, 'missing.jsonl'), ciPath: join(dir, 'missing-ci.json') }).candidates).toEqual([]);
    writeFileSync(ci, '{');
    const broken = join(dir, 'broken.json');
    expect(await cmdLearn(['mine', '--ledger', ledger, '--ci', ci, '--reviews', reviews, '--out', broken])).toBe(2);
    expect(existsSync(broken)).toBe(false);
  });

  it('reweights from the ledger on each drain and still refuses to execute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-drain-'));
    const ledger = join(dir, 'spend.jsonl');
    const weightsPath = join(dir, 'weights.json');
    appendSpendDecision(ledger, row({ poolId: 'codex:codex-primary', merged: true, ci: 'passed', cost: 0 }));
    appendSpendDecision(ledger, row({ poolId: 'cloud-credits', billing: 'credit', merged: true, ci: 'passed', cost: 3 }));
    const before = roleAllowed('subscription', 'merge');
    const errors: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((chunk?: unknown) => {
      errors.push(String(chunk));
    });
    try {
      expect(await cmdWorker(['drain', '--ledger', ledger, '--weights', weightsPath, '--repo', dir])).toBe(2);
      expect(await cmdWorker(['drain', '--ledger', join(dir, 'missing.jsonl'), '--weights', join(dir, 'empty.json')])).toBe(2);
    } finally {
      err.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/not wired/);
    const saved = JSON.parse(readFileSync(weightsPath, 'utf8')) as { version: number; weights: Record<string, number> };
    expect(saved.version).toBe(1);
    expect(saved.weights).toEqual(reweight(readSpendDecisions(ledger)));
    expect(saved.weights['codex:codex-primary']).toBeGreaterThan(saved.weights['cloud-credits'] ?? 0);
    expect(JSON.parse(readFileSync(join(dir, 'empty.json'), 'utf8'))).toEqual({ version: 1, weights: {} });
    expect(roleAllowed('subscription', 'merge')).toBe(before);
    expect(roleAllowed('local', 'merge')).toBe(false);
  });
});
