import { executePlannerPass } from '../core/fleet/planner-pass.js';
const HELP = `Usage: ashlr fleet planner run --config <absolute-json-path> --prompt-file <absolute-path> [--json]
Local operator JSON: {"timeoutMs":120000,"candidates":[{"provider":"fake","executable":"/absolute/program","argv":["arg"],"cwd":"/absolute/work","runsRoot":"/absolute/runs","CODEX_HOME":"/absolute/explicit-login"}]}
Candidates run in configured order, skipping current usage-limit failures using each runsRoot.
Provider names must be unique. All paths must be absolute. timeoutMs is required (1..3600000).
CODEX_HOME is optional; without it the explicitly configured runsRoot is used.
Never uses ~/.codex (also forbidden explicitly). No login provisioning or environment diagnostics.
Prompt bytes go to stdin. One foreground pass, shell:false; child output is omitted.
Holds stop execution. All exhausted: no spawn, nonzero, selection reason and next reset.
No retry after launch. Nonzero exit, spawn error, timeout or SIGINT/SIGTERM cancellation fails.
--json emits provider, status and child exitCode (null when unavailable).`;
export async function cmdFleetPlanner(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const json = args.includes('--json');
  const values = new Map<string, string>();
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  try {
    if (args[0] !== 'run') throw new Error('invalid arguments');
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === '--json') continue;
      if (!['--config', '--prompt-file'].includes(flag) || values.has(flag) || !args[i + 1]) throw new Error('invalid arguments');
      values.set(flag, args[++i]!);
    }
    if (!values.has('--config') || !values.has('--prompt-file')) throw new Error('missing paths');
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const result = await executePlannerPass(values.get('--config')!, values.get('--prompt-file')!, controller.signal);
    console.log(json ? JSON.stringify(result) : `${result.provider ?? 'none'}: ${result.status}${result.reason ? ` (${result.reason})` : ''}${result.nextResetAt ? `; next reset: ${result.nextResetAt}` : ''}`);
    return result.status === 'completed' && result.exitCode === 0 ? 0 : 1;
  } catch {
    // Do not expose config, prompt, argv, paths or provider diagnostics.
    const error = 'planner run failed: check arguments, local config and prompt file; see --help';
    if (json) console.log(JSON.stringify({ provider: null, status: 'failed', exitCode: null, reason: error }));
    else console.error(error);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
