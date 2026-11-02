import { GUARDIAN_VERIFY_DEADLINE, GUARDIAN_VERIFY_MAX_TIMEOUT_MS, runGuardianVerifyLoop, type GuardianOptions } from '../core/fleet/guardian-verify-loop.js';
import { runGuardianHeadVerification } from '../core/fleet/guardian-head-manifest.js';

const USAGE = 'usage: fleet guardian-verify (--manifest <file> | --head-of <repo> [--branch <name>]) --state <file> [--max-passes n] [--interval-ms n] [--timeout-ms n] [--json]';

export async function cmdFleetGuardianVerify(args: string[], run = runGuardianVerifyLoop): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--help' || flag === '-h') { console.log(USAGE); return 0; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--state', '--max-passes', '--interval-ms', '--timeout-ms', '--head-of', '--branch'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-verify arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  const headOf = values['--head-of'];
  const branch = values['--branch'];
  if (headOf !== undefined && values['--manifest'] !== undefined) {
    process.stderr.write('error: --head-of and --manifest are mutually exclusive\n'); return 2;
  }
  if (branch !== undefined && headOf === undefined) {
    process.stderr.write('error: --branch requires --head-of\n'); return 2;
  }
  const integer = (value: string | undefined, fallback: number): number => value === undefined ? fallback : /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  const timeoutMs = values['--timeout-ms'] === undefined ? undefined : integer(values['--timeout-ms'], NaN);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GUARDIAN_VERIFY_MAX_TIMEOUT_MS)) {
    process.stderr.write(`error: --timeout-ms must be a positive safe integer of at most ${GUARDIAN_VERIFY_MAX_TIMEOUT_MS} (one day)\n`); return 2;
  }
  const options: GuardianOptions = { manifest: values['--manifest'] ?? '', state: values['--state'] ?? '', maxPasses: integer(values['--max-passes'], 1), intervalMs: integer(values['--interval-ms'], 1000), timeoutMs };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(GUARDIAN_VERIFY_DEADLINE), timeoutMs);
  try {
    const summary = headOf === undefined
      ? await run({ ...options, signal: controller.signal })
      : await runGuardianHeadVerification({
        repo: headOf, branch, state: options.state, maxPasses: options.maxPasses,
        intervalMs: options.intervalMs, timeoutMs, signal: controller.signal, loop: run,
      });
    console.log(json ? JSON.stringify(summary) : `guardian-verify: pass=${summary.pass} fail=${summary.fail} unknown=${summary.unknown} cancelled=${summary.cancelled}${summary.deadlineExceeded ? ' deadline-exceeded' : ''}`);
    return summary.deadlineExceeded ? 4 : summary.cancelled || summary.unknown ? 3 : summary.fail ? 1 : 0;
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : 'could not validate or process manifest/state';
    process.stderr.write(`error: ${headOf === undefined ? 'guardian-verify could not validate or process manifest/state' : `guardian-verify: ${detail}`}\n`);
    return 3;
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
