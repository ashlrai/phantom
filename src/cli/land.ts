/**
 * `phm land auto` — the in-product merge autopilot over the fleet's open PRs
 * (src/core/fleet/merge-autopilot.ts). One sweep: classify each fleet PR as
 * green-ready, behind, conflicting or red-required and, under --apply, act:
 * behind → update-branch (merge method only), conflicting → a DRAIN task,
 * red-required → a FIXUP task naming the first failing required check.
 *
 * Dry-run by default. --apply needs PHANTOM_MERGE_AUTOPILOT=1. Never --admin,
 * --rebase, force-push or check skipping; repo holds and the owner lane are
 * honored; each PR gets at most 3 actions inside 24 h.
 */
import { runMergeAutopilot, type MergeAutopilotPr, type MergeAutopilotResult } from '../core/fleet/merge-autopilot.js';

const USAGE = `Usage: phm land auto [options]
  --repo <owner/name>    restrict the sweep to one repository
  --apply                act on classified PRs (requires PHANTOM_MERGE_AUTOPILOT=1)
  --json                 print the full result as JSON

Classifies every open fleet PR: green-ready, behind, conflicting,
red-required, pending, blocked, closed, held, moved or unknown.
Without --apply nothing is touched.`;

function render(prs: MergeAutopilotPr[], apply: boolean): string {
  if (prs.length === 0) return 'No open fleet pull requests.';
  const rows = prs.map((pr) => {
    const ref = `${pr.repo}#${pr.number}`;
    const action = pr.action ? ` → ${pr.action.kind}:${pr.action.status} (${pr.action.detail})` : '';
    const check = pr.firstFailingCheck ? ` [first failing required: ${pr.firstFailingCheck}]` : '';
    return `${ref.padEnd(28)} ${pr.class.padEnd(13)} ${pr.detail}${check}${action}`;
  });
  const mode = apply ? 'applied' : 'dry-run (pass --apply to act)';
  return [`merge autopilot — ${mode}`, ...rows].join('\n');
}

export async function cmdLand(argv: string[]): Promise<number> {
  const args = [...argv];
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const verb = args.shift();
  if (verb !== 'auto') { console.error(USAGE); return 2; }
  let repo: string | undefined;
  let apply = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--repo' && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) repo = args[++i];
    else if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else { console.error(USAGE); return 2; }
  }
  if (repo !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    console.error('--repo must be a GitHub owner/name');
    return 2;
  }
  const result: MergeAutopilotResult = await runMergeAutopilot({ repo, apply });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(result.reason);
  else console.log(render(result.prs, apply));
  return result.ok ? 0 : 1;
}
