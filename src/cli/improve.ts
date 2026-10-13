/** `phm improve propose [--team t] [--open-pr --repo <dir>] [--json]` — draft PRs, or --auto-merge to merge on green. */
import { gatherProposals, openProposalPr, renderProposal } from '../core/improve/loop.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

export async function cmdImprove(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args[0] !== 'propose') { console.error('Usage: phm improve propose [--team <id>] [--open-pr --repo <dir> [--auto-merge]] [--json]'); return 2; }
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const proposals = gatherProposals(val('--team') ?? 'default', runSteward(defaultStewardPolicy()));
  if (!args.includes('--open-pr')) {
    if (args.includes('--json')) console.log(JSON.stringify(proposals, null, 2));
    else console.log(proposals.length ? proposals.map((p) => renderProposal(p, { includeLocal: true })).join('\n---\n') : 'No proposals: no qualifying evidence yet.');
    return 0;
  }
  const repo = val('--repo');
  if (!repo) { console.error('--open-pr needs --repo <checkout>'); return 2; }
  for (const p of proposals) {
    try { console.log(openProposalPr(p, repo, undefined, { autoMerge: args.includes('--auto-merge') })); } catch (err) { console.error(`${p.id}: ${err instanceof Error ? err.message : String(err)}`); return 1; }
  }
  return 0;
}
