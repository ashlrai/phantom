import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger, outcomesLedgerPath, type MetricSpec } from '../src/core/improve/outcomes.js';
import { leverageByKind, outcomes, proposalIdFor, rankWork, recordProposal } from '../src/core/improve/api.js';

const metric: MetricSpec = { name: 'ci-minutes', direction: 'decrease', runner: { kind: 'npm', script: 'bench:ci' } };
const source = { kind: 'model' as const, engine: 'claude', model: 'claude-opus-5-5' };
let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-api-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const measure = (id: string, base: number, head: number) => {
  appendLedger({ type: 'measured', proposalId: id, phase: 'base', sha: 'a'.repeat(40), value: base, reason: null });
  appendLedger({ type: 'measured', proposalId: id, phase: 'head', sha: 'b'.repeat(40), value: head, reason: null });
};

describe('improve api', () => {
  it('records a proposal and its PR idempotently under a stable id', () => {
    const input = { key: 'autopilot:ashlrai/phantom#9', title: 'Fix flaky CI', kind: 'CI Fix', source, metric, pr: { repository: 'ashlrai/phantom', number: 9 } };
    expect(recordProposal(input)).toEqual({ proposalId: proposalIdFor(input.key), appended: ['registered', 'pr'] });
    expect(recordProposal(input).appended).toEqual([]);
    expect(recordProposal({ ...input, pr: { repository: 'ashlrai/phantom', number: 10 } }).appended).toEqual(['pr']);
    const [o] = outcomes().outcomes;
    expect(o).toMatchObject({ proposalKind: 'ci-fix', status: 'unknown', pr: { number: 10 } });
  });

  it('ranks any work list by measured leverage of its kind', () => {
    const fast = recordProposal({ key: 'a', title: 'a', kind: 'ci-fix', source, metric }).proposalId;
    const slow = recordProposal({ key: 'b', title: 'b', kind: 'docs', source, metric }).proposalId;
    measure(fast, 10, 5);
    measure(slow, 10, 12);
    expect(leverageByKind().get('ci-fix')).toBe(0.5);
    const items = [{ id: 1, k: 'Docs' }, { id: 2, k: 'new-thing' }, { id: 3, k: 'CI Fix' }, { id: 4 }];
    expect(rankWork(items, (i) => i.k).map((i) => i.id)).toEqual([3, 2, 4, 1]);
  });

  it('refuses to record into a broken ledger and stops ranking from it', () => {
    recordProposal({ key: 'a', title: 'a', kind: 'ci-fix', source, metric });
    fs.appendFileSync(outcomesLedgerPath(), 'junk\n');
    expect(() => recordProposal({ key: 'b', title: 'b', kind: 'docs', source, metric })).toThrow(/not intact/);
    expect(outcomes().intact).toBe(false);
    expect(rankWork([{ k: 'docs' }, { k: 'ci-fix' }], (i) => i.k)).toEqual([{ k: 'docs' }, { k: 'ci-fix' }]);
  });
});
