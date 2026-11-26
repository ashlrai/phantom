/**
 * `phm fleet outside-outcomes` — merged-PR outcome metrics for non-fleet work.
 *
 * Lists recently-merged PRs on the repos fleet jobs touch (plus the
 * workspace checkout), keeps the ones outside-prs.ts's rules call outside
 * work, and joins each against the standing revert set so a merged-then-
 * reverted community change is visible evidence. Each PR also carries the
 * outcome evidence gh records: the head's check-rollup summary, the review
 * decision, the diff size and the merging account. Read-only: it runs `gh
 * pr list` and reads the local revert ledger; it never merges, records or
 * dispatches. Agent/model stay null — gh never records which agent produced
 * a change.
 */
import { listOutsidePrOutcomes, type OutsidePrOutcomesV1 } from '../core/fleet/outside-pr-outcomes.js';

const usage = `Usage: phm fleet outside-outcomes [--days <n>] [--json]

Merged outside-PR outcomes on fleet repos (default window: 30 days).
Per repo: merged PRs outside work touched, each marked reverted yes/no/
unknown against the standing revert ledger (unreadable ledger → unknown,
never "not reverted") plus the check-rollup state, review decision, diff
size and merging account gh recorded. Per author: merged, reverted,
failing-check, approved and fleet-merged counts; agent and model are
always null — gh records only the PR author login. gh absent →
sourceState "missing". Read-only.`;

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
    lines.push(`${repo.repo}: ${repo.prs.length} merged outside PR(s)${repo.state === 'degraded' ? ' (degraded)' : ''}${repo.projection === 'basic' ? ' (basic projection — check/review evidence unavailable)' : ''}${repo.hitLimit ? ' (hit gh limit)' : ''}, ${reverted} reverted.`);
    for (const pr of repo.prs) {
      const checks = pr.checks.state === 'unknown'
        ? 'checks unknown'
        : `checks ${pr.checks.state} (${pr.checks.passed} passed, ${pr.checks.failed} failed, ${pr.checks.pending} pending)`;
      const size = pr.additions === null && pr.deletions === null && pr.changedFiles === null
        ? 'size unknown'
        : `size +${pr.additions ?? '?'}/-${pr.deletions ?? '?'} (${pr.changedFiles ?? '?'} files)`;
      // Under the basic projection gh was never asked for review/merger
      // fields, so a null there is "unavailable", not "none recorded".
      const noEvidence = repo.projection === 'basic';
      lines.push(
        `  #${pr.number} ${pr.title} — ${pr.author ?? 'unknown author'} — merged ${pr.mergedAt.slice(0, 10)}` +
        ` — reverted ${pr.reverted} — ${checks} — review ${pr.review ?? (noEvidence ? 'unavailable' : 'none')}` +
        ` — ${size} — merged by ${noEvidence ? 'unavailable' : (pr.mergedBy ?? 'unknown')}`);
    }
  }
  if (r.authors.length > 0) {
    lines.push('Authors (agent/model never recorded by gh — null):');
    for (const a of r.authors) {
      lines.push(
        `  ${a.author ?? 'unknown'}: ${a.prs} merged, ${a.reverted} reverted, ${a.checksFailing} failing checks,` +
        ` ${a.approved} approved, ${a.fleetMerged} fleet-merged.`);
    }
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
