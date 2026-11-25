import { NODE_RUNNER_PACKS, NODE_RUNNER_PROTOCOL, readNodeRunnerRequest, runNodeRunner } from '../core/drive/nodes/runner.js';
import { nodeErrorEnvelope } from './node-fleet-usage.js';

export async function cmdNodeRunOnce(args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (args.length === 1 && args[0] === 'packs') {
    console.log(JSON.stringify({ protocol: NODE_RUNNER_PROTOCOL, packs: NODE_RUNNER_PACKS }));
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) {
    const message = 'Usage: phm node run-once [--json] < request.json | phm node run-once packs';
    if (json) console.log(JSON.stringify(nodeErrorEnvelope('run-once',
      { code: 'usage', message, fix: 'Run: phm node run-once packs to list runner packs, or pipe one runner request on stdin.' })));
    else console.error(message);
    return 2;
  }
  try {
    console.log(JSON.stringify(await runNodeRunner(await readNodeRunnerRequest(process.stdin))));
    return 0;
  } catch {
    const message = 'Node runner refused, failed or lost its lease. No completion was returned.';
    if (json) console.log(JSON.stringify(nodeErrorEnvelope('run-once',
      { code: 'unavailable', message, fix: 'Re-pull the job with phm node pull --json and retry on a node holding a live lease; see docs/NODES.md.' })));
    else console.error(message);
    return 1;
  }
}
