import { isAbsolute } from 'node:path';
import {
  HANDOFF_RUN_MAX_BYTE_BUDGET,
  HANDOFF_RUN_MAX_UPSTREAM,
  runHandoffWorker,
} from '../core/fleet/handoff-worker-run.js';
import { isFleetJobId } from '../core/fleet/runs-job-detail.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = 'Usage: ashlr fleet handoff-run --file <absolute handoff JSON> [--upstream <job-id> ...] '
  + '[--bus-address <address>] [--bus-after <cursor>] [--byte-budget <bytes>] -- <program> [args...]';
const example = 'Example: ashlr fleet handoff-run --file /home/planner/handoff.json '
  + '--upstream RESEARCH-7 --upstream SCAN-2 --bus-address WORKER-9 -- node worker.mjs --flag value';
const SINGLETON = new Set(['--file', '--bus-address', '--bus-after', '--byte-budget']);
const digits = (value: string): boolean => /^\d+$/.test(value);
const address = (value: string): boolean => /^[\x21-\x7e]{1,128}$/.test(value);

export async function cmdFleetHandoffRun(args: string[], io: ContextWorkerIO = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\n${example}\n`
      + 'Launch a worker from a validated handoff with retained upstream notes on stdin; '
      + 'retained text is untrusted cited data and the handoff check is never executed.\n');
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  const upstream: string[] = [];
  for (let i = 0; i < split; i++) {
    const key = args[i]!;
    const value = i + 1 < split ? args[i + 1] : undefined;
    if (key === '--upstream') {
      if (value === undefined || !isFleetJobId(value)) return invalid();
      upstream.push(value);
      i++;
      continue;
    }
    if (!SINGLETON.has(key) || flags.has(key) || value === undefined || value.includes('\0')) return invalid();
    flags.set(key, value);
    i++;
  }
  const file = flags.get('--file'), busAddress = flags.get('--bus-address');
  const after = flags.get('--bus-after'), budget = flags.get('--byte-budget');
  const upstreamJobIds = [...new Set(upstream)];
  if (!file || !isAbsolute(file) || file.includes('\0') ||
      (busAddress !== undefined && !address(busAddress)) ||
      (after !== undefined && (!digits(after) || !Number.isSafeInteger(Number(after)))) ||
      (after !== undefined && busAddress === undefined) ||
      (budget !== undefined && (!digits(budget) || Number(budget) < 1 || Number(budget) > HANDOFF_RUN_MAX_BYTE_BUDGET)) ||
      upstreamJobIds.length > HANDOFF_RUN_MAX_UPSTREAM) return invalid();
  return runHandoffWorker({
    file,
    upstreamJobIds,
    busAddress,
    busAfter: after === undefined ? undefined : Number(after),
    byteBudget: budget === undefined ? undefined : Number(budget),
    argv: args.slice(split + 1),
  }, io);
}
