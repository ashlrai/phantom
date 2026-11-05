import { advanceReleaseCandidate, type ReleaseAdvanceReport } from '../core/fleet/release-advance.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-advance --repo <owner/name> --tag <vX.Y.Z> [--apply] [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXIT: Record<ReleaseAdvanceReport['outcome'], number> = {
  planned: 0, submitted: 0, 'no-op': 0, blocked: 1, refused: 1, unavailable: 3,
};

/**
 * Idempotent advance of an eligible release candidate into the existing
 * attest-ci-build.yml lane. The default is a structured dry run carrying the
 * proposed dispatch; --apply refreshes the plan immediately before mutating
 * and submits only the existing workflow's typed inputs. `submitted` means gh
 * accepted the dispatch — never that a release was published. A pending or
 * successful attest on the same candidate makes the command a no-op.
 */
export async function cmdFleetReleaseAdvance(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\n\nAdvance an eligible immutable release candidate into the existing\nattest-ci-build.yml dispatch. Dry run by default; --apply re-reads the plan\nimmediately before the one bounded dispatch. Already attested, published or\nin-flight candidates are a no-op; blocked or missing evidence dispatches\nnothing.\n\nexit: 0 planned|submitted|no-op, 1 blocked|refused, 2 invalid arguments, 3 evidence unavailable`);
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
  const report = await advanceReleaseCandidate(repo, tag, { apply, runner: deps.gh });
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    const fmt = (v: string | null) => v ?? 'unknown';
    const attest = report.attestedRun ? `attested by run ${report.attestedRun.id}`
      : report.inFlightRun ? `in flight run ${report.inFlightRun.id} (${report.inFlightRun.status})`
      : 'none on candidate';
    const lines = [
      `Release advance ${report.repo} ${report.tag}: ${report.outcome} (${report.reason})`,
      `  Candidate: ${fmt(report.candidate.sha)} tree ${fmt(report.candidate.tree)}`,
      `  Master (${fmt(report.master.branch)}): ${fmt(report.master.sha)} tree ${fmt(report.master.tree)}${report.treeMatch === null ? '' : report.treeMatch ? '  [trees match]' : '  [tree mismatch]'}`,
      `  Gate run: ${report.gateRun ? `${report.gateRun.id} attempt ${report.gateRun.attempt} ${report.gateRun.conclusion ?? 'unknown'}` : 'none on candidate'}`,
      `  Artifact: ${report.producerArtifact ? `${report.producerArtifact.name} id ${report.producerArtifact.id}${report.producerArtifact.expired ? ' (expired)' : ''}` : 'none usable'}`,
      `  Attest: ${attest}  Release: ${report.release.state}`,
      ...report.blockers.map(b => `  Blocker ${b.id}: ${b.detail}`),
    ];
    if (report.dispatch.inputs) {
      const inputs = Object.entries(report.dispatch.inputs).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push(`  Dispatch ${report.dispatch.accepted ? 'accepted' : 'proposed'}: attest-ci-build.yml --ref ${report.dispatch.ref} ${inputs}`);
    }
    if (report.dispatch.invoked && !report.dispatch.accepted) {
      lines.push(`  Dispatch rejected${report.dispatch.detail ? `: ${report.dispatch.detail}` : '.'}`);
    }
    if (report.outcome === 'submitted') {
      lines.push('  gh accepted the dispatch; the release is NOT published. Re-run observes the pending attest as a no-op.');
    }
    if (report.outcome === 'planned') lines.push('  Dry run; pass --apply to submit this dispatch.');
    if (report.truncated) lines.push('  Some evidence was truncated.');
    console.log(lines.join('\n'));
  }
  return EXIT[report.outcome];
}
