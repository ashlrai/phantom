import { runGatedWorker, type GatedWorkerDeps } from '../core/fleet/gated-worker-run.js';

const usage = 'Usage: ashlr fleet gate-run [--budget-seconds N] -- <program> [args...]';

export async function cmdFleetGateRun(args: string[], deps: GatedWorkerDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stderr.write(usage + '\n');
    return 0;
  }
  const separator = args.indexOf('--');
  const options = args.slice(0, separator);
  let budget = 180;
  if (separator < 0 || !args[separator + 1] || (options.length !== 0 &&
      (options.length !== 2 || options[0] !== '--budget-seconds' || !options[1].trim()))) {
    process.stderr.write(usage + '\n');
    return 2;
  }
  if (options.length) budget = Number(options[1]);
  if (!Number.isFinite(budget) || budget <= 0) { process.stderr.write(usage + '\n'); return 2; }
  const result = await runGatedWorker(args.slice(separator + 1), budget, deps);
  process.stderr.write(`fleet gate-run: ${result.verdict}\n`);
  return result.code;
}
