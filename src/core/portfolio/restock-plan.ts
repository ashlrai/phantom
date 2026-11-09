import { createHash } from 'node:crypto';
import { lintRestockDocument, type RestockCandidate, type RestockLintOptions, type RestockDrop } from './restock-lint.js';

export interface RestockPlan {
  schema: 'fleet.restock-plan.v1';
  jobs: { jobId: string; repo: string; items: RestockCandidate[]; prompt: string }[];
  excluded: { jobId: string; code: number | null; reason: string }[];
  held: string[];
  invalid: RestockDrop[];
}
export type RestockPrecheck = (item: RestockCandidate) => Promise<{ code: number; reason: string }>;

/** Generation only: no claims, queue writes, provider calls or task execution. */
export async function planRestock(text: string, check: RestockPrecheck, options: RestockLintOptions = {}): Promise<RestockPlan> {
  const lint = lintRestockDocument(text, options);
  const report: RestockPlan = { schema: 'fleet.restock-plan.v1', jobs: [], excluded: [], held: [], invalid: lint.drops };
  const repos = new Map<string, RestockCandidate[]>();
  for (const item of lint.accepted) {
    try {
      const result = await check(item);
      if (result.code !== 0) {
        report.excluded.push({ jobId: item.jobId, ...result });
        continue;
      }
    } catch {
      report.excluded.push({ jobId: item.jobId, code: null, reason: 'precheck unavailable; retry planning' });
      continue;
    }
    const items = repos.get(item.repo) ?? [];
    items.push(item); repos.set(item.repo, items);
  }
  for (const [repo, items] of repos) {
    // Balance groups to avoid a tiny tail whenever 6–10 item groups are possible.
    const count = Math.ceil(items.length / 10);
    const usable = items.length >= count * 6 ? items.length : Math.floor(items.length / 10) * 10;
    const groups = Math.ceil(usable / 10);
    let offset = 0;
    for (let i = 0; i < groups; i++) {
      const size = Math.ceil((usable - offset) / (groups - i));
      const batch = items.slice(offset, offset + size); offset += size;
      const digest = createHash('sha256').update(JSON.stringify(batch.map(item => item.raw))).digest('hex').slice(0, 12);
      const jobId = `RQ-RESTOCK-${repo.toUpperCase()}-${digest.toUpperCase()}`;
      report.jobs.push({ jobId, repo, items: batch,
        prompt: `${jobId} (repo=${repo}): Complete these ${batch.length} items as one change. Verify each item.\n${batch.map((item, index) => `${index + 1}. ${item.jobId}: ${item.task}`).join('\n')}` });
    }
    report.held.push(...items.slice(offset).map(item => item.jobId));
  }
  return report;
}
