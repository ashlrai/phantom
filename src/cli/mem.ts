/**
 * `phm mem` -- machine memory inventory and reclaim.
 *
 *   phm mem reclaim [--apply] [--json] [--queue-status <path>]
 *                   [--ollama-url <u>] [--omlx-url <u>] [--no-models]
 *                   [--vmmap] [--grace-ms <n>]
 *
 * DRY-RUN BY DEFAULT. Prints a JSON report of what would be reclaimed:
 * resident models in local runtimes (unloaded only through their own
 * loopback APIs), orphaned dev processes with no live job pid in their
 * ancestor chain, and pids left behind by finished queue jobs. `--apply`
 * performs the listed actions.
 *
 * Safety lives in src/core/memory/reclaim.ts: nothing in a live job's
 * process tree is ever killed, codex processes are only reclaimable as
 * directly recorded leftovers of finished jobs, model unloads go to
 * numeric loopback endpoints only, an unreadable queue status file fails
 * closed, and no auth file is ever read or touched.
 */

import {
  applyReclaim,
  planReclaim,
  type ReclaimDeps,
  type ReclaimPlanOptions,
} from '../core/memory/reclaim.js';
import { realPlanOptions, realReclaimDeps } from '../core/memory/system-deps.js';

export interface MemCliDeps {
  out(line: string): void;
  err(line: string): void;
  /** Test seam: overrides the real machine effects. */
  reclaimDeps?: ReclaimDeps;
}

class UsageError extends Error {}

const HELP = [
  'Usage: phm mem <reclaim|help>',
  '  reclaim [--apply] [--json]         Inventory memory; report (default) or apply reclaim actions.',
  '           --queue-status <path>     Read this router queue snapshot instead of ~/.ashlr-runs/queue/status.json.',
  '           --ollama-url <url>        Ollama base url (default http://127.0.0.1:11434); loopback only.',
  '           --omlx-url <url>          oMLX base url (default http://127.0.0.1:8000); loopback only.',
  '           --no-models               Skip the idle-model probe entirely.',
  '           --vmmap                   Enrich candidates with per-process swapped-out memory (macOS).',
  '           --grace-ms <n>            Milliseconds to wait for SIGTERM before SIGKILL (default 3000).',
  'Kills only orphaned node/tsserver/rust-analyzer/esbuild/cargo processes and finished-job leftovers.',
  'Never kills a live job tree or a codex process attached to a live job.',
].join('\n');

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value.`);
  args.splice(i, 2);
  return value;
}

export async function runMemCli(argv: readonly string[], injected?: Partial<MemCliDeps>): Promise<number> {
  const deps: MemCliDeps = {
    out: injected?.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: injected?.err ?? ((line) => process.stderr.write(`${line}\n`)),
    ...(injected?.reclaimDeps ? { reclaimDeps: injected.reclaimDeps } : {}),
  };
  const args = [...argv];
  const sub = args.shift() ?? 'help';
  if (sub === 'help' || sub === '--help' || sub === '-h' || args.includes('--help') || args.includes('-h')) {
    deps.out(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case 'reclaim': {
        const apply = takeFlag(args, '--apply');
        takeFlag(args, '--dry-run'); // explicit default; accepted and ignored
        takeFlag(args, '--json');    // the report is always JSON
        const noModels = takeFlag(args, '--no-models');
        const withVmmap = takeFlag(args, '--vmmap');
        const queueStatus = takeOption(args, '--queue-status');
        const ollamaUrl = takeOption(args, '--ollama-url');
        const omlxUrl = takeOption(args, '--omlx-url');
        const graceMsRaw = takeOption(args, '--grace-ms');
        if (args.length > 0) throw new UsageError(`unexpected: ${args.join(' ')}`);
        const graceMs = graceMsRaw === undefined ? undefined : Number.parseInt(graceMsRaw, 10);
        if (graceMs !== undefined && (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 60_000)) {
          throw new UsageError('--grace-ms must be an integer between 0 and 60000.');
        }
        const options: ReclaimPlanOptions = realPlanOptions({
          apply,
          probeModels: !noModels,
          withVmmap,
          ...(ollamaUrl !== undefined ? { ollamaBaseUrl: ollamaUrl } : {}),
          ...(omlxUrl !== undefined ? { omlxBaseUrl: omlxUrl } : {}),
          ...(graceMs !== undefined ? { killGraceMs: graceMs } : {}),
        });
        const reclaimDeps = deps.reclaimDeps ?? realReclaimDeps(
          queueStatus !== undefined ? { queueStatusPaths: [queueStatus] } : {},
        );
        let report = await planReclaim(options, reclaimDeps);
        if (apply) report = await applyReclaim(report, options, reclaimDeps);
        deps.out(JSON.stringify(report, null, 2));
        if (apply && (report.blocked !== undefined || report.totals.errors > 0)) return 1;
        return 0;
      }
      default:
        throw new UsageError(`unknown verb "${sub}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`phm mem: ${error.message}`);
      deps.err(HELP);
      return 2;
    }
    deps.err(`phm mem: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Dispatch entry used by src/cli/index.ts (`phm mem ...`). */
export async function cmdMem(args: string[]): Promise<number> {
  return runMemCli(args);
}
