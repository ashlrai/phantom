/**
 * `phm fleet outside-outcomes` — merged-PR outcome metrics for non-fleet work.
 *
 * Lists recently-merged PRs on the repos fleet jobs touch (plus the
 * workspace checkout), keeps the ones outside-prs.ts's rules call outside
 * work, and joins each against the standing revert set so a merged-then-
 * reverted community change is visible evidence. Read-only: it runs `gh pr
 * list` and reads the local revert ledger; it never merges, records or
 * dispatches. Agent is convention attribution (recorded branch/login
 * convention, null when unmatched); model is always null — gh never
 * records which model produced a change.
 */
import { listOutsidePrOutcomes, type OutsidePrOutcomesV1 } from '../core/fleet/outside-pr-outcomes.js';

const usage = `Usage: phm fleet outside-outcomes [--days <n>] [--json]

Merged outside-PR outcomes on fleet repos (default window: 30 days).
Per repo: merged PRs outside work touched, each marked reverted yes/no/
unknown against the standing revert ledger (unreadable ledger → unknown,
never "not reverted"). Per author: merged and reverted counts; per agent:
the same tallies attributed by recorded branch/login convention (unmatched
→ unattributed, never guessed); model is always null — gh records none.
gh absent → sourceState "missing". Read-only.`;

interface Parsed { json: boolean; days?: number; help: boolean }

function parseArgs(args: string[]): Parsed | null {
  const parsed: Parsed = { json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--days' && parsed.days === undefined) {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 365) return null;
      parsed.days = value;
    } else return null;
  }
  return parsed;
}

function renderText(r: OutsidePrOutcomesV1): string {
  const lines = [
    `Outside PR outcomes — last ${r.windowDays}d (since ${r.since.slice(0, 10)}), revert ledger ${r.revertLedger}, gh ${r.sourceState}.`,
  ];
  for (const repo of r.repos) {
    const reverted = repo.prs.filter((p) => p.reverted === 'yes').length;
    lines.push(`${repo.repo}: ${repo.prs.length} merged outside PR(s)${repo.state === 'degraded' ? ' (degraded)' : ''}${repo.hitLimit ? ' (hit gh limit)' : ''}, ${reverted} reverted.`);
    for (const pr of repo.prs) {
      lines.push(`  #${pr.number} ${pr.title} — ${pr.author ?? 'unknown author'}${pr.agent !== null ? ` [${pr.agent}]` : ''} — merged ${pr.mergedAt.slice(0, 10)} — reverted ${pr.reverted}`);
    }
  }
  if (r.authors.length > 0) {
    lines.push('Authors (one login pushes work for many agents — attribution lives on the agents rollup):');
    for (const a of r.authors) lines.push(`  ${a.author ?? 'unknown'}: ${a.prs} merged, ${a.reverted} reverted.`);
  }
  if (r.agents.length > 0) {
    lines.push('Agents (branch/login convention attribution; model never recorded):');
    for (const a of r.agents) lines.push(`  ${a.agent ?? 'unattributed'}: ${a.prs} merged, ${a.reverted} reverted.`);
  }
  return lines.join('\n');
}

export async function cmdFleetOutsideOutcomes(
  args: string[],
  deps: { list?: typeof listOutsidePrOutcomes } = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) { console.error(usage); return 2; }
  if (parsed.help) { console.log(usage); return 0; }
  try {
    const report = await (deps.list ?? listOutsidePrOutcomes)({ days: parsed.days });
    if (parsed.json) console.log(JSON.stringify(report));
    else console.log(renderText(report));
    return report.sourceState === 'missing' ? 1 : 0;
  } catch {
    console.error('outside-outcomes: read failed.');
    return 1;
  }
}
