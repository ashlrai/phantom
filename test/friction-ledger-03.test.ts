/** RQ-FRICTION-3-PLANNER — friction ledger, its planner/ranker wiring, and the 7d close rule. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  absorbNoopChurn, collectFrictionTop, closeFrictionItems, frictionLedgerPath,
  readFrictionLedger, upsertFrictionItems, type FrictionItem,
} from '../src/core/fleet/friction-ledger.js';
import { buildPlannerBrief } from '../src/core/fleet/planner-brief.js';
import { runPickGrader, type PickRecord, type PickSignals } from '../src/core/fleet/pick-grader.js';
import { parseCandidates, pickRecords, rankCandidates, readyLine } from '../src/core/routing/selector.js';
import { frictionCandidate } from '../src/cli/select.js';

const item = (id: string, score: number, extra: Partial<FrictionItem> = {}): FrictionItem => ({
  id, title: `Fix ${id}`, detail: `evidence for ${id}`, score, repo: 'phantom',
  source: 'test', status: 'open', openedAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const win: PickSignals = { merged: true, used: true, stars: 0, installs: 0 };
const lose: PickSignals = { merged: false, used: false, stars: 0, installs: 0 };

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'friction-')); mkdirSync(join(home, '.ashlr'), { recursive: true }); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

it('reads last-wins, counts torn rows, and upserts never reopen a closed item', () => {
  const path = frictionLedgerPath(home);
  expect(readFrictionLedger(path)).toEqual({ items: [], rejected: 0 });
  writeFileSync(path, `${JSON.stringify(item('a:1', 3))}\ntorn\n${JSON.stringify(item('a:1', 9))}\n{"id":"bad"}\n`);
  expect(readFrictionLedger(path)).toMatchObject({ items: [{ score: 9 }], rejected: 2 });
  upsertFrictionItems(path, [item('noop-streak:RQ-A', 4), item('needs-you:x', 7)], '2026-11-01T01:00:00.000Z');
  closeFrictionItems(path, ['noop-streak:RQ-A'], '2026-11-01T02:00:00.000Z', 'grader-7d');
  upsertFrictionItems(path, [item('noop-streak:RQ-A', 9), item('needs-you:x', 8, { detail: 'newer' })], '2026-11-01T03:00:00.000Z');
  const items = readFrictionLedger(path).items;
  expect(items.find((i) => i.id === 'noop-streak:RQ-A')!.status).toBe('closed');
  expect(items.find((i) => i.id === 'needs-you:x')!.detail).toBe('newer');
  expect(collectFrictionTop(path).map((i) => i.id)).toEqual(['a:1', 'needs-you:x']);
});

it('absorbs only streaking PSEL-4 noop lines, then serves them as top items', () => {
  expect(absorbNoopChurn('not json')).toEqual([]);
  const rows = absorbNoopChurn(JSON.stringify({ 'RQ-CHURN': { n: 3, at: 1 }, 'RQ-ONCE': { n: 1 }, bad: { n: 'x' } }));
  expect(rows).toEqual([expect.objectContaining({ id: 'noop-streak:RQ-CHURN', score: 5, source: 'noop-streak' })]);
  const noopPath = join(home, 'noop-streak.json');
  writeFileSync(noopPath, JSON.stringify({ 'RQ-CHURN': { n: 2 } }));
  const top = collectFrictionTop(frictionLedgerPath(home), noopPath, 5);
  expect(top.map((i) => i.id)).toEqual(['noop-streak:RQ-CHURN']);
  expect(readFrictionLedger(frictionLedgerPath(home)).items).toHaveLength(1);
});

it('carries friction_id through the candidate, the READY line and the pick record', () => {
  const c = frictionCandidate(item('noop-streak:RQ-CHURN', 50));
  expect(c.id).toMatch(/^RQ-FRICTION-[0-9A-F]{24}$/);
  const result = rankCandidates([c], { cells: [] }, { count: 1 });
  expect(readyLine(result.picks[0]!)).toContain('friction_id=noop-streak:RQ-CHURN');
  expect(pickRecords(result, new Date(0))[0]!.frictionId).toBe('noop-streak:RQ-CHURN');
  const parsed = parseCandidates(`${JSON.stringify({ id: 'RQ-X', scope: 's', repo: 'phantom', value: 1, friction_id: 'needs-you:x' })}\n`);
  expect(parsed.candidates[0]!.frictionId).toBe('needs-you:x');
});

it('the grader closes an item only on its pick’s 7d hit — never the 24h grade or a miss', () => {
  const path = frictionLedgerPath(home);
  writeFileSync(path, ['noop-streak:RQ-A', 'noop-streak:RQ-B'].map((id) => `${JSON.stringify(item(id, 4))}\n`).join(''));
  const picks: PickRecord[] = [
    { id: 'a', pickedAt: 0, features: {}, frictionId: 'noop-streak:RQ-A' },
    { id: 'b', pickedAt: 0, features: {}, frictionId: 'noop-streak:RQ-B' },
    { id: 'c', pickedAt: 0, features: {} },
  ];
  const run = runPickGrader({ home, picks, frictionPath: path, now: 10 * 24 * 3_600_000,
    readSignals: (p, w) => (w === '24h' ? win : p.id === 'a' ? win : lose) });
  expect(run.frictionClosed).toEqual(['noop-streak:RQ-A']);
  const items = readFrictionLedger(path).items;
  expect(items.find((i) => i.id === 'noop-streak:RQ-A')).toMatchObject({ status: 'closed', closeReason: 'grader-7d' });
  expect(items.find((i) => i.id === 'noop-streak:RQ-B')!.status).toBe('open');
});

it('the planner brief renders FRICTION TOP instructing friction_id attribution', async () => {
  const brief = await buildPlannerBrief({ runsRoot: home, git: (_p, _a, _o, cb) => cb(null, ''),
    frictionTop: async () => [item('noop-streak:RQ-A', 9)] });
  expect(brief.text).toContain('## FRICTION TOP');
  expect(brief.text).toContain('friction_id=<item id>');
  expect(brief.text).toContain('noop-streak:RQ-A score=9');
  expect(brief.sections.friction).toBe(1);
});
