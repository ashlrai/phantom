import { readQueueOrder } from '../core/queue/order.js';
import { readNodesPlan } from '../core/fleet/nodes-plan.js';
import { defaultNodesViewDeps } from '../core/fleet/nodes-view.js';
import { defaultRunsDir, dispatchNodeJob, planOnlyAdapter, type NodeDispatchDeps } from '../core/fleet/nodes-dispatch.js';

const usage = 'Usage: phm fleet node-dispatch <job-id> --node <name> [--dry-run] [--json]';

export async function cmdFleetNodeDispatch(args: string[], injected?: NodeDispatchDeps): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nShows a dispatch plan; the default adapter cannot launch a remote worker.`);
    return 0;
  }
  let job: string | undefined, node: string | undefined, dryRun = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--node' && node === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) node = args[++i];
    else if (arg === '--dry-run' && !dryRun) dryRun = true;
    else if (arg === '--json' && !json) json = true;
    else if (!arg.startsWith('-') && job === undefined && arg.trim()) job = arg;
    else { console.error(usage); return 2; }
  }
  if (!job || !node || !node.trim()) { console.error(usage); return 2; }
  const view = injected ? undefined : defaultNodesViewDeps();
  const deps: NodeDispatchDeps = injected ?? {
    readPlan: () => readNodesPlan({ view: view!, readQueue: readQueueOrder }),
    adapter: planOnlyAdapter,
    runsDir: defaultRunsDir(),
    self: (() => { try { return view!.hostName().split('.')[0]!; } catch { return ''; } })(),
  };
  const result = await dispatchNodeJob(deps, { job, node, dryRun });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log([`${result.outcome === 'started' ? 'Started' : result.outcome === 'dry-run' ? 'Plan only' : 'Refused'}: ${result.why}`,
    ...(result.steps.length ? ['Planned steps:', ...result.steps.map((step, i) => `${i + 1}. ${step}`)] : [])].join('\n'));
  return result.outcome === 'refused' ? 1 : 0;
}
