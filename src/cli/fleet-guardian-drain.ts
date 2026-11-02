import { isAbsolute } from 'node:path';
import {
  drainGuardianInfraRetries,
  GUARDIAN_DRAIN_MAX_RETRIES,
  type GuardianDrainDeps,
  type GuardianDrainSummary,
} from '../core/fleet/guardian-retry-drain.js';
import { GUARDIAN_VERIFY_DEADLINE, GUARDIAN_VERIFY_MAX_TIMEOUT_MS } from '../core/fleet/guardian-verify-loop.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

// `fleet guardian-drain` — retry a bounded set of distinct infrastructure
// failures from one guardian state in a single invocation. Default is
// read-only planning; --apply prepares each admission into its own
// exclusive-verified output under --output-dir. The summary is bounded to
// counts, termination, attempted identities and the latest output path, and
// sanitized before print. Exit codes mirror guardian-verify: 0 done, 2 args,
// 3 unsafe/collision/cancelled, 4 deadline, 5 refused.
export async function cmdFleetGuardianDrain(
  args: string[],
  deps: GuardianDrainDeps & { now?: () => number } = {},
): Promise<number> {
  const values: Record<string, string> = {};
  let json = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--apply' && !apply) { apply = true; continue; }
    if (!['--manifest', '--source-state', '--output-dir', '--max-retries', '--timeout-ms'].includes(flag)
      || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-drain arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  const positive = (value: string | undefined): number => value !== undefined && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  const maxRetries = positive(values['--max-retries']);
  const timeoutMs = positive(values['--timeout-ms']);
  const paths = [values['--manifest'], values['--source-state'], values['--output-dir']];
  if (!paths.every(p => p !== undefined && isAbsolute(p) && p.length <= 4096)
    || !Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > GUARDIAN_DRAIN_MAX_RETRIES
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS) {
    process.stderr.write(`error: guardian-drain requires absolute --manifest/--source-state/--output-dir, --max-retries 1..${GUARDIAN_DRAIN_MAX_RETRIES} and --timeout-ms 1..${GUARDIAN_VERIFY_MAX_TIMEOUT_MS}\n`);
    return 2;
  }
  const [manifest, sourceState, outputDir] = paths as string[];
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const deadline = apply ? setTimeout(() => controller.abort(GUARDIAN_VERIFY_DEADLINE), timeoutMs) : undefined;
  let summary: GuardianDrainSummary;
  try {
    summary = await drainGuardianInfraRetries(
      { manifest, sourceState, outputDir, maxRetries, timeoutMs, apply, signal: controller.signal, now: deps.now },
      deps,
    );
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  const safe = sanitizePublicJson(summary) as GuardianDrainSummary;
  console.log(json
    ? JSON.stringify(safe)
    : `guardian-drain: mode=${safe.mode} termination=${safe.termination} attempts=${safe.attempts} verified=${safe.verified} refused=${safe.refused}${safe.latestOutput ? ` latest=${safe.latestOutput}` : ''}`);
  return summary.termination === 'deadline' ? 4
    : summary.termination === 'refused' ? 5
    : ['unsafe', 'collision', 'cancelled'].includes(summary.termination) ? 3
    : 0;
}
