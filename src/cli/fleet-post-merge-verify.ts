/**
 * `ashlr fleet post-merge-verify` — run the detached post-merge verification
 * runner against one explicitly supplied merge.
 *
 * Checks out the exact merge commit into a fresh temporary worktree, executes
 * the repository-owned merge verification profile, records bounded metadata
 * and removes the worktree. Observation only: the result grants no merge,
 * rollback, deployment, routing or daemon authority.
 */
import {
  runDetachedPostMergeVerification,
  type DetachedPostMergeRunnerInput,
  type DetachedPostMergeRunnerOptions,
  type DetachedPostMergeRunnerResult,
} from '../core/fleet/detached-post-merge-runner.js';
import { parsePositiveInt } from './args.js';

export type DetachedPostMergeVerifyRun = typeof runDetachedPostMergeVerification;

const usage = `Usage: ashlr fleet post-merge-verify --repo <abs> --cohort-id <id> --proposal-id <id> --base-branch <name> --base-head <sha> --candidate-head <sha> --merge-commit <sha> [--run-id <id>] [--trajectory-id <id>] [--work-item-id <id>] [--max-command-timeout-ms <n>] [--max-total-timeout-ms <n>] [--json]
Verifies the exact merge commit in a fresh detached worktree and prints the bounded result.
Observation only: grants no merge, rollback, deployment, routing or daemon authority.
Exit 0 pass, 1 fail, 3 unknown — unknown never reads as pass.`;

const REQUIRED: ReadonlyArray<{ flag: string; key: keyof DetachedPostMergeRunnerInput }> = [
  { flag: '--repo', key: 'repo' },
  { flag: '--cohort-id', key: 'cohortId' },
  { flag: '--proposal-id', key: 'proposalId' },
  { flag: '--base-branch', key: 'baseBranch' },
  { flag: '--base-head', key: 'baseHead' },
  { flag: '--candidate-head', key: 'candidateHead' },
  { flag: '--merge-commit', key: 'mergeCommit' },
];
const OPTIONAL: ReadonlyArray<{ flag: string; key: keyof DetachedPostMergeRunnerInput }> = [
  { flag: '--run-id', key: 'runId' },
  { flag: '--trajectory-id', key: 'trajectoryId' },
  { flag: '--work-item-id', key: 'workItemId' },
];
type TimeoutKey = 'maxCommandTimeoutMs' | 'maxTotalTimeoutMs';
const TIMEOUTS: ReadonlyArray<{ flag: string; key: TimeoutKey }> = [
  { flag: '--max-command-timeout-ms', key: 'maxCommandTimeoutMs' },
  { flag: '--max-total-timeout-ms', key: 'maxTotalTimeoutMs' },
];

/** Only 'pass' earns 0; anything else never reads as pass. */
export function postMergeVerifyExitCode(
  terminal: DetachedPostMergeRunnerResult['terminal'],
): number {
  if (terminal === 'pass') return 0;
  if (terminal === 'fail') return 1;
  return 3;
}

function unavailableResult(): DetachedPostMergeRunnerResult {
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    policyEligible: false,
    mergePermitted: false,
    rollbackPermitted: false,
    deployPermitted: false,
    terminal: 'unknown',
    reason: 'verification-infrastructure',
    verifierManifestDigest: null,
    requiredCommandCount: 0,
    commandsRun: 0,
    failureCategory: 'infra',
    cleanup: 'failed',
    recordDisposition: 'not-recorded',
  };
}

export async function cmdFleetPostMergeVerify(
  args: string[],
  run: DetachedPostMergeVerifyRun = runDetachedPostMergeVerification,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  let json = false;
  const input: Partial<DetachedPostMergeRunnerInput> = {};
  const options: DetachedPostMergeRunnerOptions = {};
  const valueFlags = new Map<string, keyof DetachedPostMergeRunnerInput>(
    [...REQUIRED, ...OPTIONAL].map(({ flag, key }) => [flag, key]),
  );
  const timeoutFlags = new Map<string, TimeoutKey>(
    TIMEOUTS.map(({ flag, key }) => [flag, key]),
  );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    const inputKey = valueFlags.get(arg);
    if (inputKey !== undefined && i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
      input[inputKey] = args[++i]!;
      continue;
    }
    const timeoutKey = timeoutFlags.get(arg);
    if (timeoutKey !== undefined) {
      const parsed = parsePositiveInt(arg.replace(/^--/, ''), args[i + 1]);
      if ('error' in parsed) {
        process.stderr.write(`error: ${parsed.error}\n${usage}\n`);
        return 2;
      }
      options[timeoutKey] = parsed.n;
      i++;
      continue;
    }
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const missing = REQUIRED.filter(({ key }) => input[key] === undefined);
  if (missing.length > 0) {
    process.stderr.write(
      `error: missing required option ${missing[0]!.flag}\n${usage}\n`,
    );
    return 2;
  }

  let outcome: DetachedPostMergeRunnerResult;
  try {
    outcome = await run(input as DetachedPostMergeRunnerInput, options);
  } catch {
    outcome = unavailableResult();
    process.stderr.write('error: fleet post-merge-verify runner unavailable\n');
  }
  console.log(
    json
      ? JSON.stringify(outcome)
      : `post-merge-verify: ${outcome.terminal} (${outcome.reason}); ` +
        `cleanup=${outcome.cleanup}; commands=${outcome.commandsRun}/${outcome.requiredCommandCount}; ` +
        `record=${outcome.recordDisposition}`,
  );
  return postMergeVerifyExitCode(outcome.terminal);
}
