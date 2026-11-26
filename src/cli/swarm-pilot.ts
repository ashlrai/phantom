import { resolve } from 'node:path';
import { readResourceJson } from '../core/resources/pool-runtime.js';
import { readSwarmPilotReport, runSwarmPilot } from '../core/swarm/pilot.js';

const usage = 'Usage: phm swarm pilot <spec.json> --runtime <file> [--root <dir>] [--apply] [--json]\n' +
  '       phm swarm pilot-report <id> [--root <dir>] [--pr <number>] [--json]\n';

export async function cmdSwarmPilot(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(usage); return 0; }
  const [verb, target, ...rest] = args;
  const report = verb === 'pilot-report';
  const flags = new Map<string, string>();
  while (rest.length) {
    const token = rest.shift()!;
    const boolean = token === '--json' || (!report && token === '--apply');
    const key = token === '--root' || (report ? token === '--pr' : token === '--runtime');
    const value = boolean ? '' : key ? rest.shift() : undefined;
    if (value === undefined || (!boolean && (!value || value.startsWith('--'))) || flags.has(token)) {
      process.stderr.write(usage); return 2;
    }
    flags.set(token, value);
  }
  const runtime = flags.get('--runtime');
  const pr = flags.get('--pr');
  if (!target || target.startsWith('-') || (!report && !runtime) || (pr !== undefined && !/^\d+$/.test(pr))) {
    process.stderr.write(usage); return 2;
  }
  const root = flags.get('--root');
  try {
    const result = report ? readSwarmPilotReport(target, root, pr === undefined ? undefined : Number(pr)) :
      await runSwarmPilot(readResourceJson(resolve(target)), resolve(runtime!), { root, apply: flags.has('--apply') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.status === 'held' || result.status === 'running' ? 1 : 0;
  } catch (error) {
    const reason = error instanceof Error && /^[a-z]+(?:-[a-z]+)+$/.test(error.message) ? error.message : 'swarm-pilot-unavailable';
    process.stderr.write(reason + '\n');
    return 1;
  }
}
