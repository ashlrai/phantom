import { isAbsolute } from 'node:path';
import { runBusClaimedWork } from '../core/fleet/bus-claimed-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { CLAIM_MAX_LEASE_MS } from '../core/fleet/bus-work-claims.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = `Usage: ashlr fleet bus-claimed-run --snapshot <absolute-json> --prompt <absolute-text> --request-file <absolute-envelope-json> --reply-id <id> --owner <label> --lease-ms <1..${CLAIM_MAX_LEASE_MS}> [--root <absolute>] -- <program> [args...]`;

/**
 * Execute one explicitly selected bus request under the exclusive work lease.
 * Explicit argv alone authorizes launch; routing labels authenticate nobody and
 * grant no completion or merge authority. Claim tokens stay inside the core and
 * are never printed.
 */
export async function cmdFleetBusClaimedRun(args: string[], io: ContextWorkerIO = {}, bus: BusInboxOptions = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nClaims the named request's id, renews the lease while the literal argv runs, completes only on worker exit zero with a delivered reply, releases on failure, and reports ownership loss distinctly. No queue scanning or selection.\n`);
    return 0;
  }
  const invalid = (): number => { stderr.write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--snapshot', '--prompt', '--request-file', '--reply-id', '--owner', '--lease-ms', '--root'].includes(key) ||
        flags.has(key) || i + 1 >= split || !value || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const snapshot = flags.get('--snapshot'), prompt = flags.get('--prompt'),
    requestFile = flags.get('--request-file'), replyId = flags.get('--reply-id'),
    owner = flags.get('--owner'), lease = flags.get('--lease-ms'), flagRoot = flags.get('--root');
  const leaseMs = lease !== undefined && /^\d+(?![\s\S])/.test(lease) ? Number(lease) : NaN;
  if (!snapshot || !prompt || !requestFile || !replyId || !owner ||
      ![snapshot, prompt, requestFile].every(isAbsolute) ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > CLAIM_MAX_LEASE_MS ||
      (flagRoot !== undefined && !isAbsolute(flagRoot))) return invalid();
  const options = flagRoot === undefined ? bus : { ...bus, root: flagRoot };
  const result = await runBusClaimedWork({ snapshot, prompt, requestFile, replyId, owner, leaseMs, argv: args.slice(split + 1) }, io, options);
  // Static statuses and numbers only: no tokens, routing ids, or context data.
  stderr.write(`${JSON.stringify({ claim: result.claim, workerExit: result.workerExit, replyReceipt: { status: result.replyReceipt.status } })}\n`);
  return result.exitCode;
}
