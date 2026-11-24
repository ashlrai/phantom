import { NODE_RUNNER_PACKS, NODE_RUNNER_PROTOCOL, readNodeRunnerRequest, runNodeRunner } from '../core/drive/nodes/runner.js';

export async function cmdNodeRunOnce(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === 'packs') {
    console.log(JSON.stringify({ protocol: NODE_RUNNER_PROTOCOL, packs: NODE_RUNNER_PACKS }));
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) {
    console.error('Usage: phm node run-once [--json] < request.json | phm node run-once packs');
    return 2;
  }
  try {
    console.log(JSON.stringify(await runNodeRunner(await readNodeRunnerRequest(process.stdin))));
    return 0;
  } catch {
    console.error('Node runner refused, failed or lost its lease. No completion was returned.');
    return 1;
  }
}
