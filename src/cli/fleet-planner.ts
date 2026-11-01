import { executePlannerPass, defaultPlannerPassDeps, type PlannerPassDeps } from '../core/fleet/planner-pass.js';
const HELP = `Usage: ashlr fleet planner [--run --prompt-file PATH] [--runs-root PATH] [--json]
Select the first declared runner not usage-limited, without spawning by default.
Reads queue/planner-candidates.json under ~/.ashlr-runs (or --runs-root).
--run executes one pass through runPlannerPass; ORCH_OFF gates execution.`;
export async function cmdFleetPlanner(args: string[], deps: PlannerPassDeps = defaultPlannerPassDeps): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(HELP); return 0; }
  const json = args.includes('--json');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (['--run', '--json'].includes(arg) && !flags.has(arg)) flags.add(arg);
      else if (['--runs-root', '--prompt-file'].includes(arg) && !values.has(arg)
        && args[i + 1] && !args[i + 1]!.startsWith('-')) values.set(arg, args[++i]!);
      else throw new Error('invalid arguments');
    }
    if (flags.has('--run') && !values.has('--prompt-file')) throw new Error('missing prompt');
    const report = await executePlannerPass({ run: flags.has('--run'), runsRoot: values.get('--runs-root'), promptPath: values.get('--prompt-file') }, deps);
    console.log(json ? JSON.stringify(report) : `${report.provider ?? 'none'}: ${report.reason}${'result' in report ? `; ${report.result.outcome} (exit ${report.result.exitCode ?? 'none'})` : ''}`);
    return report.ok ? 0 : 1;
  } catch {
    const report = { ok: false, provider: null, reason: 'planner failed; check arguments and local inputs; see --help' };
    console.log(json ? JSON.stringify(report) : report.reason);
    return 1;
  }
}
