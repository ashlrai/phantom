/** `phm improve propose [--team t] [--open-pr --repo <dir>] [--json]` — draft PRs; merges use the existing protected approval process. */
import { gatherProposals, openProposalPr, renderProposal } from '../core/improve/loop.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';

export async function cmdImprove(argv: string[]): Promise<number> {
  const args = [...argv];
  if (args[0] !== 'propose') { console.error('Usage: phm improve propose [--team <id>] [--open-pr --repo <dir>] [--json]'); return 2; }
  if (args.includes('--auto-merge')) { console.error('Self-improvement auto-merge lacks protected-policy admission. Open a draft and use the existing protected merge process.'); return 2; }
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const proposals = gatherProposals(val('--team') ?? 'default', runSteward(defaultStewardPolicy()));
  if (!args.includes('--open-pr')) {
    if (args.includes('--json')) console.log(JSON.stringify(proposals, null, 2));
    else console.log(proposals.length ? proposals.map((p) => renderProposal(p, { includeLocal: true })).join('\n---\n') : 'No proposals: no qualifying evidence yet.');
    return 0;
  }
  // --json with --open-pr: stdout carries one JSON object, never bare PR lines or human errors.
  const json = args.includes('--json');
  const repo = val('--repo');
  if (!repo) {
    if (json) console.log(JSON.stringify({ opened: [], error: '--open-pr needs --repo <checkout>' }, null, 2));
    else console.error('--open-pr needs --repo <checkout>');
    return 2;
  }
  const opened: Array<{ id: string; pr: string }> = [];
  for (const p of proposals) {
    try {
      const pr = openProposalPr(p, repo);
      if (json) opened.push({ id: p.id, pr });
      else console.log(pr);
    } catch (err) {
      const error = `${p.id}: ${err instanceof Error ? err.message : String(err)}`;
      if (json) console.log(JSON.stringify({ opened, error }, null, 2));
      else console.error(error);
      return 1;
    }
  }
  if (json) console.log(JSON.stringify({ opened }, null, 2));
  return 0;
}
