import { advanceReleaseCandidatePaced, DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS, type ReleasePacedOptions, type ReleasePacedReport } from '../core/fleet/release-paced.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-paced --repo <owner/name> --tag <vX.Y.Z> [--apply] [--json] [--retry-after-ms N]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXIT: Record<ReleasePacedReport['outcome'], number> = {
  planned: 0, submitted: 0, 'no-op': 0, 'already-submitted': 0, deferred: 0,
  blocked: 1, refused: 1, unavailable: 3, busy: 4,
};

/**
 * Opt-in paced release advance (RQ-PHX-RELEASEPACEDRETRY05SSN2): wraps
 * `fleet release-advance-once`, deferring repeat --apply calls until
 * --retry-after-ms has elapsed since the last accepted dispatch. Local cadence
 * only; once due, the wrapped command's own evidence and dedupe decide.
 */
export async function cmdFleetReleasePaced(
  args: string[],
  deps: { gh?: GitRunner; stateDir?: string; now?: () => number; once?: ReleasePacedOptions['once'] } = {},
): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\n\nPaces retries of release-advance-once. --apply defers (exit 0, outcome deferred,\nnextEligibleAt set) until --retry-after-ms (default ${DEFAULT_RETRY_AFTER_MS}, range ${MIN_RETRY_AFTER_MS}..${MAX_RETRY_AFTER_MS})\nhas passed since the last accepted dispatch; otherwise it delegates and the\noriginal dedupe and terminal-failure rules decide. Dry run writes nothing.\nCooldown is local cadence per repo/tag and may briefly defer a repointed tag;\nit never carries eligibility across SHAs.\n\nexit: 0 planned|submitted|no-op|already-submitted|deferred, 1 blocked|refused,\n      2 invalid arguments, 3 evidence unavailable, 4 lock busy`);
      return 0;
    }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (!['--repo', '--tag', '--retry-after-ms'].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`);
      return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const tag = values.get('--tag') ?? '';
  const rawMs = values.get('--retry-after-ms');
  const retryAfterMs = rawMs === undefined ? DEFAULT_RETRY_AFTER_MS : /^\d{1,9}$/.test(rawMs) ? Number(rawMs) : NaN;
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || !TAG.test(tag)
    || !(retryAfterMs >= MIN_RETRY_AFTER_MS && retryAfterMs <= MAX_RETRY_AFTER_MS)) {
    process.stderr.write(`Invalid repository, tag or retry interval. ${USAGE}\n`);
    return 2;
  }
  const report = await advanceReleaseCandidatePaced(repo, tag, {
    apply, retryAfterMs, runner: deps.gh, stateDir: deps.stateDir, now: deps.now, once: deps.once,
  });
  if (json) console.log(JSON.stringify(report));
  else {
    const lines = [`Release paced ${report.repo} ${report.tag}: ${report.outcome} (${report.reason})  pace ${report.pace}`];
    if (report.outcome === 'deferred') {
      lines.push(`  Next eligible: ${report.nextEligibleAt}  prior accepted candidate ${report.priorCandidateSha}`);
      lines.push('  Local cooldown; no dispatch attempted.');
    } else if (report.once) lines.push(`  Underlying: ${report.once.outcome} (${report.once.reason})  receipt ${report.once.receipt.state}`);
    console.log(lines.join('\n'));
  }
  return EXIT[report.outcome];
}
