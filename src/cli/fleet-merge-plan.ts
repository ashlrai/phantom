/** Read-only proposals for open PRs superseded by other open PRs. */
import { readFile } from 'node:fs/promises';
import { supersededOpenPrs, type MergePlanPr } from '../core/fleet/merge-plan.js';

const usage = 'Usage: phm fleet merge-plan --input <snapshot.json> [--repo <owner/name>] [--json]';

export async function cmdFleetMergePlan(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead-only supersession proposals from a gh pr list JSON array. No PRs are changed.`);
    return 0;
  }
  let input: string | undefined;
  let repo: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--input' && input === undefined) || (arg === '--repo' && repo === null)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(usage); return 2; }
      if (arg === '--input') input = value; else repo = value;
    } else { console.error(usage); return 2; }
  }
  if (!input || (repo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) {
    console.error(usage); return 2;
  }
  try {
    const raw: unknown = JSON.parse(await readFile(input, 'utf8'));
    if (!Array.isArray(raw) || raw.length > 10000) throw new Error('expected an array of at most 10000 PRs');
    const rows: MergePlanPr[] = raw.filter((value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value))
      .filter(row => (row.state === undefined || row.state === 'OPEN') && row.mergedAt == null && row.closedAt == null)
      .map(row => ({ number: row.number, title: row.title, body: row.body ?? '', isDraft: row.isDraft ?? false }))
      .filter((row): row is MergePlanPr => Number.isSafeInteger(row.number) && (row.number as number) > 0 &&
        typeof row.title === 'string' && typeof row.body === 'string' && typeof row.isDraft === 'boolean')
      .map(row => ({ ...row, title: row.title.slice(0, 200), body: row.body.slice(0, 8000) }));
    if (rows.length !== raw.length) throw new Error('snapshot must contain valid open PR rows only');
    if (new Set(rows.map(row => row.number)).size !== rows.length) throw new Error('duplicate PR numbers');
    const report = supersededOpenPrs(rows, repo);
    console.log(json ? JSON.stringify(report) : report.proposals.map(p => `#${p.number}: ${p.reason}`).join('\n') || 'No supersession proposals.');
    return 0;
  } catch (error) {
    console.error(`merge-plan: ${error instanceof Error ? error.message : 'invalid input'}`);
    return 1;
  }
}
