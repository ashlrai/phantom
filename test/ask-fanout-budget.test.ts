import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capAskFanoutByBudget, capAskFanoutFromLedger } from '../src/core/ask/fanout-budget.js';
import { projectPoolBudgets, type BudgetReading } from '../src/core/fleet/pool-budget.js';
import { addBudgetReadings } from '../src/core/fleet/pool-budget-store.js';

const at = (hour: number) => `2026-10-25T${String(hour).padStart(2, '0')}:00:00.000Z`;
const NOW = new Date(at(11));
const reading = (pool: BudgetReading['pool'], bucket: BudgetReading['bucket'], remaining: number, extra: Partial<BudgetReading> = {}): BudgetReading =>
  ({ pool, bucket, remaining, timestamp: at(9), resetAt: '2026-11-01T12:00:00.000Z', source: 'manual', ...extra });
const snapshot = (rows: BudgetReading[], sourceState: 'healthy' | 'unavailable' = 'healthy') => projectPoolBudgets(rows, NOW, sourceState);

describe('capAskFanoutByBudget', () => {
  it('caps the fan-out at 0 when the observed remaining budget is 0', () => {
    const cap = capAskFanoutByBudget(3, 'codex-cmp', snapshot([
      reading('codex-cmp', 'weeklyPct', 0), reading('codex-cmp', 'credits', 42)]));
    expect(cap).toMatchObject({ requested: 3, granted: 0, limiting: 'weeklyPct' });
    expect(capAskFanoutByBudget(2, 'devin', snapshot([reading('devin', 'acus', 0)])).granted).toBe(0);
  });
  it('caps the fan-out at 1 when exactly one unit remains', () => {
    const cap = capAskFanoutByBudget(3, 'devin', snapshot([reading('devin', 'acus', 1)]));
    expect(cap).toMatchObject({ requested: 3, granted: 1, limiting: 'acus' });
  });
  it('grants all N when at least N units remain', () => {
    const cap = capAskFanoutByBudget(3, 'devin', snapshot([reading('devin', 'acus', 3)]));
    expect(cap).toMatchObject({ requested: 3, granted: 3, limiting: null });
    expect(capAskFanoutByBudget(2, 'codex-personal', snapshot([
      reading('codex-personal', 'weeklyPct', 80), reading('codex-personal', 'credits', 10)])).granted).toBe(2);
  });
  it('grants the tightest bucket when several are observed', () => {
    const cap = capAskFanoutByBudget(3, 'codex-cmp', snapshot([
      reading('codex-cmp', 'weeklyPct', 50), reading('codex-cmp', 'credits', 2)]));
    expect(cap).toMatchObject({ granted: 2, limiting: 'credits' });
  });
  it('holds a held pool at 0 regardless of its readings', () => {
    expect(capAskFanoutByBudget(3, 'claude', snapshot([reading('claude', 'weeklyPct', 90)])))
      .toMatchObject({ granted: 0, limiting: 'held' });
  });
  it('treats capacity as a direct slot count for capacity-only pools', () => {
    expect(capAskFanoutByBudget(3, 'local-omlx', snapshot([reading('local-omlx', 'capacity', 2)])))
      .toMatchObject({ granted: 2, limiting: 'capacity' });
  });
  it('never fabricates a cap from an unobserved, stale or unreadable balance', () => {
    expect(capAskFanoutByBudget(3, 'devin', snapshot([]))).toMatchObject({ granted: 3, limiting: null });
    const stale = capAskFanoutByBudget(3, 'devin', snapshot([
      reading('devin', 'acus', 0, { resetAt: at(10) })]));
    expect(stale.granted).toBe(3);
    expect(stale.reason).toContain('reset');
    expect(capAskFanoutByBudget(3, 'devin', snapshot([], 'unavailable')).reason).toContain('unavailable');
    expect(capAskFanoutByBudget(3, 'not-a-pool', snapshot([]))).toMatchObject({ granted: 3, limiting: null });
  });
  it('scales the cap by the per-job estimate and floors partial affordability', () => {
    expect(capAskFanoutByBudget(3, 'devin', snapshot([reading('devin', 'acus', 5)]), 2).granted).toBe(2);
    expect(capAskFanoutByBudget(1, 'devin', snapshot([reading('devin', 'acus', 0.5)])).granted).toBe(0);
  });
  it('grants 0 for an empty request and rejects malformed arguments', () => {
    expect(capAskFanoutByBudget(0, 'devin', snapshot([reading('devin', 'acus', 9)])).granted).toBe(0);
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => capAskFanoutByBudget(bad, 'devin', snapshot([]))).toThrow('Invalid ask fan-out breadth');
    }
    for (const bad of [0, -2, NaN, Infinity]) {
      expect(() => capAskFanoutByBudget(1, 'devin', snapshot([]), bad)).toThrow('Invalid per-job budget estimate');
    }
  });
});

describe('capAskFanoutFromLedger', () => {
  const dirs: string[] = [];
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'fanout-budget-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('reads the persisted ledger and applies the cap', async () => {
    const directory = dir();
    await addBudgetReadings([reading('devin', 'acus', 1)], directory);
    const cap = await capAskFanoutFromLedger(3, 'devin', { directory, now: NOW });
    expect(cap).toMatchObject({ requested: 3, granted: 1, limiting: 'acus' });
  });
  it('passes the breadth through when the ledger directory does not exist', async () => {
    const cap = await capAskFanoutFromLedger(2, 'devin', { directory: join(dir(), 'missing'), now: NOW });
    expect(cap.granted).toBe(2);
  });
});
