import {
  advanceReleaseCandidateOnce,
  type ReleaseAdvanceOnceReport,
} from '../core/fleet/release-advance-once.js';
import type { ReleaseAdvanceReport } from '../core/fleet/release-advance.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-advance-once --repo <owner/name> --tag <vX.Y.Z> [--apply] [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXIT: Record<ReleaseAdvanceOnceReport['outcome'], number> = {
  planned: 0, submitted: 0, 'no-op': 0, 'already-submitted': 0,
  blocked: 1, refused: 1, unavailable: 3, busy: 4,
};

/**
 * Opt-in serialized release advance (RQ-PHX-RELEASEADVANCEONCE05SRP2). Same
 * evidence and dispatch as `fleet release-advance`, but --apply holds an
 * atomic per-repo/tag lock under the fleet state dir and records the accepted
 * dispatch + candidate sha before releasing it, so concurrent local
 * supervisors cannot double-submit during GitHub's visibility lag. Local
 * host coordination only; never a global exactly-once claim.
 */
export async function cmdFleetReleaseAdvanceOnce(
  args: string[],
  deps: {
    gh?: GitRunner;
    stateDir?: string;
    advance?: (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;
  } = {},
): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\n\nSerialized single-host advance of an eligible release candidate into the\nexisting attest-ci-build.yml dispatch. Dry run delegates read-only and writes\nnothing. --apply serializes on a local per-candidate lock: a contended lock\nreports busy and dispatches nothing; an accepted dispatch is recorded with\nthe exact candidate sha so a later call reports already-submitted during\nGitHub's visibility lag. A repointed tag never inherits the old receipt.\n\nexit: 0 planned|submitted|no-op|already-submitted, 1 blocked|refused,\n      2 invalid arguments, 3 evidence unavailable, 4 lock busy`);
      return 0;
    }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
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
  const report = await advanceReleaseCandidateOnce(repo, tag, {
    apply, runner: deps.gh, stateDir: deps.stateDir, advance: deps.advance,
  });
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    const inner = report.advance;
    const lines = [
      `Release advance-once ${report.repo} ${report.tag}: ${report.outcome} (${report.reason})`,
      `  Lock: ${report.lock}  Receipt: ${report.receipt.state}`,
    ];
    if (report.receipt.record) {
      lines.push(`  Recorded dispatch: ${report.receipt.record.submittedAt} candidate ${report.receipt.record.candidateSha} ref ${report.receipt.record.ref ?? 'unknown'}`);
    }
    if (inner) {
      lines.push(`  Candidate: ${inner.candidate.sha ?? 'unknown'}  plan ${inner.planOutcome}  advance ${inner.outcome} (${inner.reason})`);
      if (inner.dispatch.inputs) {
        const inputs = Object.entries(inner.dispatch.inputs).map(([k, v]) => `${k}=${v}`).join(' ');
        lines.push(`  Dispatch ${inner.dispatch.accepted ? 'accepted' : 'proposed'}: attest-ci-build.yml --ref ${inner.dispatch.ref} ${inputs}`);
      }
      if (inner.outcome === 'submitted') {
        lines.push('  gh accepted the dispatch; the release is NOT published.');
      }
      if (inner.outcome === 'planned') lines.push('  Dry run; pass --apply to submit this dispatch.');
    }
    if (report.outcome === 'busy') {
      lines.push('  Another supervisor holds the candidate lock; no dispatch attempted.');
    }
    console.log(lines.join('\n'));
  }
  return EXIT[report.outcome];
}
