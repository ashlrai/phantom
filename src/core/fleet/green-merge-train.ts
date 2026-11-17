/** Advisory combined-CI candidates; no I/O or merge/check authority. */
import type { MergeBatchPr } from './merge-batch.js';
import type { MergeBatchRun } from './merge-batch-runner.js';

export interface GreenMergeTrain {
  authority: 'proposal-only';
  validation: 'required-checks-on-combined-commit';
  baseRef: string | null;
  members: { number: number; headSha: string }[];
  deferred: { number: number; reason: string }[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** No red/pending checks and at least one success; skipped daily lanes are normal. */
function green(value: unknown): boolean {
  let succeeded = false;
  return Array.isArray(value) && value.length > 0 && value.length < 100 && value.every(check => {
    const row = record(check);
    if (row?.['__typename'] === 'CheckRun' && typeof row['name'] === 'string' && row['name'].length > 0
      && row['status'] === 'COMPLETED') {
      succeeded ||= row['conclusion'] === 'SUCCESS';
      return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(row['conclusion'] as string);
    }
    if (row?.['__typename'] === 'StatusContext' && typeof row['context'] === 'string'
      && row['context'].length > 0 && row['state'] === 'SUCCESS') { succeeded = true; return true; }
    return false;
  }) && succeeded;
}

/** Same validated snapshot as runMergeBatch; caller must have healthy hold/coverage reads. */
export function planGreenMergeTrain(prs: readonly MergeBatchPr[], run: MergeBatchRun, rows: readonly unknown[]): GreenMergeTrain {
  const plan: GreenMergeTrain = { authority: 'proposal-only', validation: 'required-checks-on-combined-commit',
    baseRef: null, members: [], deferred: [] };
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const wire = new Map(rows.map(record).filter(row => row !== null).map(row => [row['number'], row]));
  const used = new Set<string>();
  for (const action of [...run.actions].sort((a, b) => a.number - b.number)) {
    const pr = byNumber.get(action.number);
    const row = wire.get(action.number);
    const base = row?.['baseRefName'];
    let reason: string | null = null;
    if (action.kind !== 'enqueue-merge' || !action.ready) reason = action.reason;
    else if (!pr || !row || row['headRefOid'] !== action.headSha || pr.headSha !== action.headSha
      || row['state'] !== 'OPEN' || row['isDraft'] !== false || typeof base !== 'string' || !base.length) reason = 'missing-identity';
    else if (row['changedFiles'] !== pr.files.length || new Set(pr.files).size !== pr.files.length
      || pr.filesComplete !== true) reason = 'incomplete-files';
    else if (!green(row['statusCheckRollup'])) reason = 'checks-not-green';
    else if (plan.baseRef !== null && base !== plan.baseRef) reason = 'different-base';
    else if (pr.files.some(file => used.has(file.toLowerCase()))) reason = 'file-overlap';
    else if (plan.members.length >= 16) reason = 'train-limit';
    if (reason !== null) { plan.deferred.push({ number: action.number, reason }); continue; }
    plan.baseRef = base as string;
    plan.members.push({ number: action.number, headSha: action.headSha! });
    for (const file of pr!.files) used.add(file.toLowerCase());
  }
  return plan;
}
