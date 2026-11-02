import { resolve } from 'node:path';
import { runGuardianVerifyLoop, type GuardianOptions } from '../core/fleet/guardian-verify-loop.js';
import {
  runDetachedPostMergeVerification,
  type DetachedPostMergeRunnerInput,
  type DetachedPostMergeRunnerResult,
} from '../core/fleet/detached-post-merge-runner.js';

type Verifier = typeof runDetachedPostMergeVerification;

// Mirror of the allowlists in src/core/fleet/guardian-verify-loop.ts: the event
// stream must expose exactly what the state record stores, and nothing else.
const terminals = new Set(['pass', 'fail', 'unknown']);
const reasons = new Set(['verified', 'code-failure', 'verification-infrastructure', 'verification-timeout', 'invalid-input', 'source-unavailable', 'binding-mismatch', 'worktree-create-failed', 'manifest-unavailable', 'isolation-lost', 'cleanup-failed', 'record-rejected']);
const categories = new Set(['code', 'infra', 'timeout', 'cancelled']);
const cleanups = new Set(['removed', 'failed', 'not-created']);

function writeLine(payload: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`, error => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function resultEvent(input: DetachedPostMergeRunnerInput, result: DetachedPostMergeRunnerResult | null, interrupted: boolean): Record<string, unknown> {
  return {
    type: 'result',
    repo: resolve(input.repo),
    sha: input.mergeCommit,
    terminal: !interrupted && result && terminals.has(result.terminal) ? result.terminal : 'unknown',
    reason: result && !interrupted && reasons.has(result.reason) ? result.reason : 'verification-infrastructure',
    failureCategory: interrupted ? 'cancelled' : result?.failureCategory && categories.has(result.failureCategory) ? result.failureCategory : null,
    cleanup: result && cleanups.has(result.cleanup) ? result.cleanup : 'failed',
  };
}

function withLiveResults(verify: Verifier): Verifier {
  return async (input, options) => {
    let result: DetachedPostMergeRunnerResult | null = null;
    try { result = await verify(input, options); } catch (error) {
      await writeLine(resultEvent(input, null, options?.signal?.aborted === true));
      throw error;
    }
    await writeLine(resultEvent(input, result, options?.signal?.aborted === true));
    return result;
  };
}

export async function cmdFleetGuardianVerify(args: string[], run = runGuardianVerifyLoop, verify: Verifier = runDetachedPostMergeVerification): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  let eventsJsonl = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--events-jsonl' && !eventsJsonl) { eventsJsonl = true; continue; }
    if (!['--manifest', '--state', '--max-passes', '--interval-ms'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-verify arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  if (json && eventsJsonl) { process.stderr.write('error: invalid guardian-verify arguments\n'); return 2; }
  const integer = (value: string | undefined, fallback: number): number => value === undefined ? fallback : /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  const options: GuardianOptions = { manifest: values['--manifest'] ?? '', state: values['--state'] ?? '', maxPasses: integer(values['--max-passes'], 1), intervalMs: integer(values['--interval-ms'], 1000), run: eventsJsonl ? withLiveResults(verify) : verify };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const summary = await run({ ...options, signal: controller.signal });
    if (eventsJsonl) await writeLine({ type: 'summary', passes: summary.passes, pass: summary.pass, fail: summary.fail, unknown: summary.unknown, cancelled: summary.cancelled });
    else console.log(json ? JSON.stringify(summary) : `guardian-verify: pass=${summary.pass} fail=${summary.fail} unknown=${summary.unknown} cancelled=${summary.cancelled}`);
    return summary.cancelled || summary.unknown ? 3 : summary.fail ? 1 : 0;
  } catch {
    process.stderr.write('error: guardian-verify could not validate or process manifest/state\n');
    return 3;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
