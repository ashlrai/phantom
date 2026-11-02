import { isAbsolute } from 'node:path';
import { GUARDIAN_VERIFY_DEADLINE, GUARDIAN_VERIFY_MAX_TIMEOUT_MS, runGuardianVerifyLoop, type GuardianOptions, type GuardianSummary } from '../core/fleet/guardian-verify-loop.js';
import { runGuardianVerifyExclusive } from '../core/fleet/guardian-verify-exclusive.js';
import { GUARDIAN_DRAIN_MAX_RETRIES, type GuardianDrainSummary } from '../core/fleet/guardian-retry-drain.js';
import { runGuardianVerifyRecover, type GuardianVerifyRecoverDeps, type GuardianVerifyRecoverReport } from '../core/fleet/guardian-verify-recover.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

// Exit codes: 0 pass, 1 fail, 2 invalid arguments, 3 unknown/cancelled/unprocessable,
// 4 deadline exceeded, 5 refused because another guardian holds this state file
// (no checks ran, state untouched; retry after it exits). 5 never means verified.
// Output with --json: a refusal is {"state":"refused","reason":"already-running"|"lock-unavailable","ran":false}.
// Opt-in recovery: --retry-infra <1..20> and --retry-output-dir <absolute existing
// directory> must appear together with an explicit valid --timeout-ms. Phase 1
// verifies as usual; phase 2 drains eligible infra failures into per-attempt
// states under the output directory without touching the source. --json reports
// {verify, retry, retrySkipped, latestState, recovered, final}; recovered counts
// verified attempts, never merely a drain that ran.
export async function cmdFleetGuardianVerify(
  args: string[],
  run = runGuardianVerifyLoop,
  deps: GuardianVerifyRecoverDeps = {},
): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--state', '--max-passes', '--interval-ms', '--timeout-ms', '--retry-infra', '--retry-output-dir'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-verify arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  const integer = (value: string | undefined, fallback: number): number => value === undefined ? fallback : /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  const timeoutMs = values['--timeout-ms'] === undefined ? undefined : integer(values['--timeout-ms'], NaN);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS)) {
    process.stderr.write(`error: --timeout-ms must be a positive safe integer of at most ${GUARDIAN_VERIFY_MAX_TIMEOUT_MS} (one day)\n`); return 2;
  }
  const retryInfra = integer(values['--retry-infra'], NaN);
  const retryOutputDir = values['--retry-output-dir'];
  const retry = values['--retry-infra'] !== undefined || retryOutputDir !== undefined;
  if (retry && (values['--retry-infra'] === undefined || retryOutputDir === undefined || timeoutMs === undefined
    || !Number.isSafeInteger(retryInfra) || retryInfra < 1 || retryInfra > GUARDIAN_DRAIN_MAX_RETRIES
    || !isAbsolute(retryOutputDir) || retryOutputDir.length > 4096)) {
    process.stderr.write(`error: recovery requires --retry-infra 1..${GUARDIAN_DRAIN_MAX_RETRIES} and an absolute --retry-output-dir together with an explicit --timeout-ms\n`); return 2;
  }
  const options: GuardianOptions = { manifest: values['--manifest'] ?? '', state: values['--state'] ?? '', maxPasses: integer(values['--max-passes'], 1), intervalMs: integer(values['--interval-ms'], 1000), timeoutMs };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(GUARDIAN_VERIFY_DEADLINE), timeoutMs);
  try {
    if (retry) {
      const report = await runGuardianVerifyRecover(
        {
          manifest: options.manifest, state: options.state, outputDir: retryOutputDir!,
          maxRetries: retryInfra, timeoutMs: timeoutMs!,
          maxPasses: options.maxPasses, intervalMs: options.intervalMs,
          signal: controller.signal, now: deps.now,
        },
        { ...deps, run },
      );
      return printRecover(report, json);
    }
    const outcome = await runGuardianVerifyExclusive({ ...options, signal: controller.signal }, { run });
    if (outcome.state === 'refused') {
      console.log(json ? JSON.stringify({ state: 'refused', reason: outcome.reason, ran: false }) : `guardian-verify: refused reason=${outcome.reason} ran=false`);
      return 5;
    }
    const summary = outcome.summary;
    console.log(json ? JSON.stringify(summary) : `guardian-verify: pass=${summary.pass} fail=${summary.fail} unknown=${summary.unknown} cancelled=${summary.cancelled}${summary.deadlineExceeded ? ' deadline-exceeded' : ''}`);
    return summary.deadlineExceeded ? 4 : summary.cancelled || summary.unknown ? 3 : summary.fail ? 1 : 0;
  } catch {
    process.stderr.write('error: guardian-verify could not validate or process manifest/state\n');
    return 3;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

function printRecover(report: GuardianVerifyRecoverReport, json: boolean): number {
  const retry = report.retry === null ? null : sanitizePublicJson(report.retry) as GuardianDrainSummary;
  const latestState = report.latestState === null ? null : sanitizePublicJson(report.latestState) as string;
  const summary = report.verify.state === 'ran' ? report.verify.summary : null;
  if (json) {
    console.log(JSON.stringify({
      verify: report.verify.state === 'refused'
        ? { state: 'refused', reason: report.verify.reason, ran: false }
        : { state: 'ran', summary },
      retry, retrySkipped: report.retrySkipped,
      latestState, recovered: report.recovered, final: report.final,
    }));
  } else if (report.verify.state === 'refused') {
    console.log(`guardian-verify: refused reason=${report.verify.reason} ran=false`);
  } else {
    const s = summary as GuardianSummary;
    console.log(`guardian-verify: pass=${s.pass} fail=${s.fail} unknown=${s.unknown} cancelled=${s.cancelled}${s.deadlineExceeded ? ' deadline-exceeded' : ''}`);
    console.log(retry === null
      ? `guardian-verify-retry: skipped reason=${report.retrySkipped ?? 'unknown'}`
      : `guardian-verify-retry: termination=${retry.termination} attempts=${retry.attempts} verified=${retry.verified} refused=${retry.refused}${retry.latestOutput ? ` latest=${retry.latestOutput}` : ''}`);
    const f = report.final;
    console.log(`guardian-verify-final: ${f === null ? 'unverified' : `pass=${f.pass} fail=${f.fail} unknown=${f.unknown}`} recovered=${report.recovered}${latestState ? ` state=${latestState}` : ''}`);
  }
  if (report.verify.state === 'refused' || report.retrySkipped === 'refused') return 5;
  if (report.retrySkipped === 'deadline') return 4;
  if (report.retrySkipped === 'cancelled') return 3;
  const termination = retry?.termination;
  if (termination === 'refused') return 5;
  if (termination === 'deadline') return 4;
  if (termination !== undefined && ['unsafe', 'collision', 'cancelled', 'observer-error'].includes(termination)) return 3;
  const f = report.final;
  if (f === null || f.unknown > 0) return 3;
  return f.fail > 0 ? 1 : 0;
}
