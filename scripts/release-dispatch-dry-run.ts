/** Local, read-only preview; deliberately exposes no execution mode. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEcosystemReleasePlan } from './ecosystem-release-plan.js';
import { planReleaseDispatchFromPlan } from '../src/core/release/orchestrator.js';

export function runReleaseDispatchDryRun(args: string[], nowMs: number) {
  if (args.length !== 5 || args[0] !== '--dry-run' || args[1] !== '--input' || !args[2] || args[3] !== '--repo' || !args[4]) {
    throw new Error('Usage: --dry-run --input snapshot.json --repo owner/name');
  }
  return planReleaseDispatchFromPlan(runEcosystemReleasePlan(['--input', args[2]], nowMs), args[4]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(runReleaseDispatchDryRun(process.argv.slice(2), Date.now()), null, 2) + '\n'); }
  catch { process.stderr.write('release-dispatch: invalid input or repository\n'); process.exitCode = 1; }
}
