import { planReleaseCandidate, type ReleaseCandidatePlan } from '../core/fleet/release-candidate-plan.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-candidate --repo <owner/name> --tag <vX.Y.Z> [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXIT: Record<ReleaseCandidatePlan['outcome'], number> = { released: 0, ready: 0, blocked: 1, unknown: 3, unavailable: 3 };

/**
 * Read-only recovery plan for a release candidate: correlates the tag's commit
 * and tree with current master, the ci.yml gate run, the attest-ci-build run
 * facts and the release row, then prints evidence-backed next actions. It never
 * dispatches or mutates; a confirmed blocked candidate exits 1, unavailable or
 * ambiguous evidence exits 3, and a ready or already-published candidate exits 0.
 */
export async function cmdFleetReleaseCandidate(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\n\nRead-only release-candidate recovery plan. Evidence on another SHA never\ncounts; missing or ambiguous evidence stays unknown. Nothing is dispatched\nor mutated.\n\nexit: 0 ready|released, 1 confirmed blocked, 2 invalid arguments, 3 evidence unavailable`);
      return 0;
    }
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--tag'].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`);
      return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const tag = values.get('--tag') ?? '';
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || !TAG.test(tag)) {
    process.stderr.write(`Invalid repository or tag. ${USAGE}\n`);
    return 2;
  }
  const plan = await planReleaseCandidate(repo, tag, { runner: deps.gh });
  if (json) {
    console.log(JSON.stringify(plan));
  } else {
    const fmt = (v: string | null) => v ?? 'unknown';
    const moved = plan.masterMoved === null ? '' : plan.masterMoved ? '  [master moved]' : '  [master head is the candidate]';
    const lines = [
      `Release candidate ${plan.repo} ${plan.tag}: ${plan.outcome}`,
      `  Candidate: ${fmt(plan.candidate.sha)} tree ${fmt(plan.candidate.tree)}`,
      `  Master (${fmt(plan.master.branch)}): ${fmt(plan.master.sha)} tree ${fmt(plan.master.tree)}${moved}`,
      `  Gate run: ${plan.gateRun ? `${plan.gateRun.id} attempt ${plan.gateRun.attempt} ${plan.gateRun.conclusion ?? plan.gateRun.status}` : 'none on candidate'}`,
      `  Attest on candidate: ${plan.attestOnCandidate.map(r => `${r.id}=${r.conclusion ?? r.status}`).join(', ') || 'none'}`,
      `  Release: ${plan.release.state}${plan.release.assets !== null ? ` (${plan.release.assets} assets)` : ''}`,
      ...plan.blockers.map(b => `  Blocker ${b.id}: ${b.detail}`),
      ...plan.nextActions.map(a => `  Next [${a.kind}] ${a.command ?? a.summary}${a.command ? ` — ${a.summary}` : ''}`),
    ];
    if (plan.truncated) lines.push('  Some evidence was truncated.');
    console.log(lines.join('\n'));
  }
  return EXIT[plan.outcome];
}
