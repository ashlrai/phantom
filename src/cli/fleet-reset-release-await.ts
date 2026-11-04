import { isAbsolute } from 'node:path';
import { isAwaitMs } from '../core/fleet/needs-mason-answer-await.js';
import { parseResetAwaitWatermarkMs } from '../core/fleet/reset-evidence-await.js';
import { awaitResetRelease, RESET_RELEASE_AWAIT_MAX_POLL_MS, RESET_RELEASE_AWAIT_MAX_TIMEOUT_MS,
  type ResetReleaseAwaitDeps } from '../core/fleet/reset-release-await.js';

const usage = 'Usage: ashlr fleet reset-release-await --lane NAME --timeout-ms N [--poll-ms N] [--runs-dir ABS] [--after ISO_TIMESTAMP] [--json]\n'
  + '--after accepts only audit lines strictly newer than a caller-persisted RFC 3339 watermark (offset\n'
  + 'required, e.g. 2026-11-01T18:06:00.000Z); the caller stores it between runs. Default boundary is\n'
  + 'invocation time.\n'
  + 'Waits for a recorded release audit line only; it never releases a hold or launches work.\n'
  + 'Exit: 0 recorded, 1 deadline or failure, 2 invalid arguments, 130 cancelled.';

export async function cmdFleetResetReleaseAwait(args: string[], deps: ResetReleaseAwaitDeps & {
  signal?: AbortSignal; emit?: (line: string) => void | Promise<void> } = {}): Promise<number> {
  const invalid = (): number => { process.stderr.write(`${usage}\n`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    await (deps.emit ?? console.log)(usage); return 0;
  }
  let lane: string | undefined, runsDir: string | undefined, timeoutMs: number | undefined,
    pollMs: number | undefined, after: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--lane' && lane === undefined && next && !next.startsWith('-') && !next.includes('\0')) { lane = next; i++; continue; }
    if (arg === '--runs-dir' && runsDir === undefined && next && isAbsolute(next) && !next.includes('\0')) { runsDir = next; i++; continue; }
    if (arg === '--after' && after === undefined && next !== undefined && parseResetAwaitWatermarkMs(next) !== null) { after = next; i++; continue; }
    if ((arg === '--timeout-ms' || arg === '--poll-ms') && next && /^[1-9][0-9]*$/.test(next)) {
      const n = Number(next);
      if (arg === '--timeout-ms' && timeoutMs === undefined && isAwaitMs(n, RESET_RELEASE_AWAIT_MAX_TIMEOUT_MS)) timeoutMs = n;
      else if (arg === '--poll-ms' && pollMs === undefined && isAwaitMs(n, RESET_RELEASE_AWAIT_MAX_POLL_MS)) pollMs = n;
      else return invalid();
      i++; continue;
    }
    return invalid();
  }
  if (!lane || timeoutMs === undefined) return invalid();
  const result = await awaitResetRelease({ lane, timeoutMs, pollMs, runsDir, after, signal: deps.signal }, deps);
  await (deps.emit ?? console.log)(json ? JSON.stringify(result)
    : `fleet reset-release-await (audit evidence, not present lane health or successful dispatch): ${JSON.stringify(result)}`);
  return result.outcome === 'recorded' ? 0 : result.outcome === 'cancelled' ? 130 : 1;
}
