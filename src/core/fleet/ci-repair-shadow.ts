/**
 * Project narrow, typed examples from the existing CI baseline evidence.
 * Output is for offline routing evaluation only. It is not an action, job,
 * authorization, or prompt and never carries excerpts or free-form input.
 */
import type { analyzeCiBaseline } from './ci-baseline.js';

type BaselineReport = Awaited<ReturnType<typeof analyzeCiBaseline>>;
type Evidence = Pick<BaselineReport['groups'][number],
  'testId' | 'classification' | 'master' | 'unaffectedPrs' | 'runs'>;
type Input = Pick<BaselineReport, 'repo' | 'master'> & { groups: readonly Evidence[] };
type Surface = 'cli-reference' | 'versioned-docs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_EXAMPLES = 8;
const surfaces = new Map<string, Surface>([
  ['test/cli-reference-drift.test.ts > generated CLI reference > matches every current registry row byte-for-byte', 'cli-reference'],
  ['test/docs-sync.test.ts > committed generated docs stay in sync > reports no drift across every local surface of the real checkout', 'versioned-docs'],
]);

export interface CiRepairShadow {
  schema: 'ci.repair-shadow.v1';
  advisory: true;
  candidates: Array<{
    repairClass: 'refresh-generated-docs';
    masterHead: string;
    surfaces: Surface[];
    affectedPrs: number;
    examples: Array<{ pr: number; head: string }>;
  }>;
}

export function projectCiRepairShadow(report: Input): CiRepairShadow {
  const result: CiRepairShadow = { schema: 'ci.repair-shadow.v1', advisory: true, candidates: [] };
  const { head } = report.master;
  if (report.repo !== 'ashlrai/phantom' || !report.master.known || !head || !SHA.test(head)) return result;

  const matched = new Set<Surface>();
  const affected = new Map<number, string>();
  for (const group of report.groups) {
    const surface = surfaces.get(group.testId);
    if (!surface || group.classification !== 'shared-baseline' || group.master !== 'fail') continue;
    const unaffected = new Set(group.unaffectedPrs);
    const heads = new Map<number, Set<string>>();
    for (const run of group.runs) {
      if (!unaffected.has(run.pr) || !Number.isSafeInteger(run.pr) || run.pr < 1 || !SHA.test(run.head)) continue;
      let values = heads.get(run.pr);
      if (!values) {
        values = new Set<string>();
        heads.set(run.pr, values);
      }
      values.add(run.head);
    }
    const proven = [...heads].flatMap(([pr, values]) =>
      values.size === 1 ? [{ pr, head: [...values][0]! }] : []);
    // Re-runs, forks pointing to the same commit, and mutable PR identities
    // cannot manufacture a repeated blocker on two independent revisions.
    if (new Set(proven.map(run => run.head)).size < 2) continue;
    for (const run of proven) {
      const others = affected.get(run.pr);
      if (others !== undefined && others !== run.head) return result;
      affected.set(run.pr, run.head);
    }
    matched.add(surface);
  }
  if (!matched.size) return result;
  result.candidates.push({
    repairClass: 'refresh-generated-docs',
    masterHead: head,
    surfaces: [...matched].sort(),
    affectedPrs: affected.size,
    examples: [...affected].sort(([a], [b]) => a - b).slice(0, MAX_EXAMPLES)
      .map(([pr, exact]) => ({ pr, head: exact })),
  });
  return result;
}
