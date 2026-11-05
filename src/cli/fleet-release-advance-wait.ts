import { MAX_POLL_MS, MAX_TIMEOUT_MS, validWaitDuration, waitForReleaseAdvance, type WaitOptions } from '../core/fleet/release-advance-wait.js';

const USAGE = 'usage: ashlr fleet release-advance-wait --repo <owner/name> --tag <vX.Y.Z> [--timeout-ms <ms>] [--poll-ms <ms>] [--apply] [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export async function cmdFleetReleaseAdvanceWait(args: string[], deps: WaitOptions & { gh?: WaitOptions['runner'] } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (!['--repo', '--tag', '--timeout-ms', '--poll-ms'].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '';
  const tag = values.get('--tag') ?? '';
  const parse = (key: string, fallback: number): number => {
    const value = values.get(key);
    return value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;
  };
  const timeoutMs = parse('--timeout-ms', 60_000);
  const pollMs = parse('--poll-ms', 5_000);
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || !TAG.test(tag)
    || !validWaitDuration(timeoutMs, MAX_TIMEOUT_MS) || !validWaitDuration(pollMs, MAX_POLL_MS)) {
    process.stderr.write(`Invalid repository, tag, timeout or poll interval. ${USAGE}\n`); return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  try {
    const report = await waitForReleaseAdvance(repo, tag, { ...deps, runner: deps.gh ?? deps.runner, apply, timeoutMs, pollMs, signal: controller.signal });
    console.log(json ? JSON.stringify(report) : `Release advance wait ${repo} ${tag}: ${report.stopReason} (${report.observations} observations)\n${JSON.stringify(report.latest, null, 2)}`);
    return report.stopReason === 'unavailable' ? 3 : report.stopReason === 'aborted' ? 130
      : ['blocked', 'refused', 'timeout'].includes(report.stopReason) ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
