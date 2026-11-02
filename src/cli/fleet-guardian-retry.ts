import { selectNextGuardianInfraRetry } from '../core/fleet/guardian-retry-next.js';
import { prepareGuardianRetryState, type GuardianRetrySummary } from '../core/fleet/guardian-retry-state.js';
import { GUARDIAN_VERIFY_MAX_TIMEOUT_MS } from '../core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianVerify } from './fleet-guardian-verify.js';

// Opt-in immediate recheck: with --verify, a successful prepare is followed in
// the same process by one bounded guardian-verify pass over the prepared output
// state (no nextAction parsing, no second spawn). guardian-verify has no default
// deadline of its own, so retry always passes an explicit timeout; the default
// here is one minute and the guardian maximum (one day) still applies.
const VERIFY_TIMEOUT_DEFAULT_MS = 60_000;

export async function cmdFleetGuardianRetry(
  args: string[],
  prepare = prepareGuardianRetryState,
  verify = cmdFleetGuardianVerify,
): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  let verifyNow = false;
  let nextInfra = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--next-infra' && !nextInfra) { nextInfra = true; continue; }
    if (flag === '--verify' && !verifyNow) { verifyNow = true; continue; }
    if (!['--manifest', '--source-state', '--output-state', '--repo', '--sha', '--timeout-ms'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-retry arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  if (nextInfra && (values['--repo'] !== undefined || values['--sha'] !== undefined)) {
    process.stderr.write('error: --next-infra cannot be combined with --repo or --sha\n'); return 2;
  }
  if (values['--timeout-ms'] !== undefined && !verifyNow) {
    process.stderr.write('error: --timeout-ms requires --verify\n'); return 2;
  }
  const timeoutMs = values['--timeout-ms'] === undefined ? VERIFY_TIMEOUT_DEFAULT_MS : /^[1-9]\d*$/.test(values['--timeout-ms']) ? Number(values['--timeout-ms']) : NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS) {
    process.stderr.write(`error: --timeout-ms must be a positive safe integer of at most ${GUARDIAN_VERIFY_MAX_TIMEOUT_MS} (one day)\n`); return 2;
  }
  let summary: GuardianRetrySummary;
  try {
    const selected = nextInfra ? await selectNextGuardianInfraRetry({
      manifest: values['--manifest'] ?? '', sourceState: values['--source-state'] ?? '', outputState: values['--output-state'] ?? '',
    }) : { repo: values['--repo'] ?? '', sha: values['--sha'] ?? '' };
    if (!selected) {
      console.log(JSON.stringify({ status: 'no-work' }));
      return 0;
    }
    summary = await prepare({
      manifest: values['--manifest'] ?? '', sourceState: values['--source-state'] ?? '', outputState: values['--output-state'] ?? '',
      repo: selected.repo, sha: selected.sha,
    });
  } catch {
    process.stderr.write('error: guardian-retry could not validate or prepare retry state\n');
    return 3;
  }
  if (!verifyNow) {
    console.log(json ? JSON.stringify(summary) : `guardian-retry: removed=${summary.removed} retained=${summary.retained} next=${summary.nextAction}`);
    return 0;
  }
  // Execution mode: exit codes propagate from guardian-verify (0 pass, 1 fail,
  // 3 unknown/cancelled, 4 deadline, 5 refused). With --json the verifier's
  // summary is the single parseable object on stdout, so the prepare summary
  // is only printed in human mode.
  if (!json) console.log(`guardian-retry: removed=${summary.removed} retained=${summary.retained} verifying=${values['--output-state'] ?? ''}`);
  return verify([
    '--manifest', values['--manifest'] ?? '',
    '--state', values['--output-state'] ?? '',
    '--max-passes', '1',
    '--timeout-ms', String(timeoutMs),
    ...(json ? ['--json'] : []),
  ]);
}
