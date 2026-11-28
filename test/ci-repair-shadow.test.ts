import { describe, expect, it } from 'vitest';
import { parseBaselineFailures } from '../src/core/fleet/ci-baseline.js';
import { projectCiRepairShadow } from '../src/core/fleet/ci-repair-shadow.js';

type Input = Parameters<typeof projectCiRepairShadow>[0];
type Group = Input['groups'][number];

const HEAD = 'a'.repeat(40);
const CLI = 'test/cli-reference-drift.test.ts > generated CLI reference > matches every current registry row byte-for-byte';
const DOCS = 'test/docs-sync.test.ts > committed generated docs stay in sync > reports no drift across every local surface of the real checkout';
const makeRun = (pr: number, head = pr.toString(16).padStart(40, '0'), runId = pr) => ({ pr, head, runId });
const makeGroup = (testId = CLI, prs = [12, 2]): Group => ({
  testId, classification: 'shared-baseline', master: 'fail',
  unaffectedPrs: prs, runs: prs.map(pr => makeRun(pr)),
});
const makeReport = (...groups: Group[]): Input => ({
  repo: 'ashlrai/phantom', master: { known: true, head: HEAD }, groups,
});

describe('CI repair shadow projection', () => {
  it('clusters known documentation failures over disjoint and overlapping PRs without re-counting', () => {
    const ids = parseBaselineFailures([
      `FAIL  |unit| ${CLI}`,
      'AssertionError: sanitized excerpt',
      `FAIL  |unit| ${DOCS}`,
      'AssertionError: sanitized excerpt',
    ].join('\n')).map(failure => failure.testId);
    expect(ids).toEqual([CLI, DOCS]);

    const first = makeGroup(ids[0]);
    const second = makeGroup(ids[1], [2, 5]);
    first.runs.push(makeRun(2, undefined, 99), makeRun(123), makeRun(12.5));
    const result = projectCiRepairShadow(makeReport(second, first));
    expect(result).toEqual({
      schema: 'ci.repair-shadow.v1', advisory: true, candidates: [{
        repairClass: 'refresh-generated-docs', masterHead: HEAD,
        surfaces: ['cli-reference', 'versioned-docs'], affectedPrs: 3,
        examples: [2, 5, 12].map(pr => ({ pr, head: makeRun(pr).head })),
      }],
    });
    expect(projectCiRepairShadow(makeReport(first, second))).toEqual(result);
  });

  it('never projects unrecognized, protected, PR-caused, or unconfirmed failures', () => {
    expect(projectCiRepairShadow(makeReport(
      makeGroup('.github/workflows/ci.yml > (secret-scan-gate)'),
      makeGroup('test/cli-reference-drift.test.ts > unrelated failure'),
      { ...makeGroup(), classification: 'pr-caused' },
      { ...makeGroup(DOCS), master: 'unknown' },
      { ...makeGroup(DOCS), master: 'pass' },
    )).candidates).toEqual([]);
    const report = makeReport(makeGroup());
    expect(projectCiRepairShadow({ ...report, master: { known: false, head: HEAD } }).candidates).toEqual([]);
    expect(projectCiRepairShadow({ ...report, master: { known: true, head: 'short' } }).candidates).toEqual([]);
    expect(projectCiRepairShadow({ ...report, repo: 'external/project' }).candidates).toEqual([]);
  });

  it('requires two distinct proven heads, rejects contradictory evidence and caps examples', () => {
    const same = { ...makeGroup(), runs: [makeRun(2), makeRun(12, makeRun(2).head)] };
    expect(projectCiRepairShadow(makeReport(same)).candidates).toEqual([]);
    const ambiguous = makeGroup(DOCS);
    ambiguous.runs[0] = makeRun(12, 'b'.repeat(40));
    expect(projectCiRepairShadow(makeReport(makeGroup(), ambiguous)).candidates).toEqual([]);
    const withinGroup = { ...makeGroup(), runs: [...makeGroup().runs, makeRun(2, 'b'.repeat(40))] };
    expect(projectCiRepairShadow(makeReport(withinGroup)).candidates).toEqual([]);
    const many = makeGroup(CLI, Array.from({ length: 20 }, (_, x) => 20 - x));
    const candidate = projectCiRepairShadow(makeReport(many)).candidates[0]!;
    expect(candidate.affectedPrs).toBe(20);
    expect(candidate.examples.map(({ pr }) => pr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
