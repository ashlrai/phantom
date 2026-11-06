import { checkIMessagePath, type IMessagePathDeps } from '../core/comms/imessage-path-check.js';

const usage = 'Usage: ashlr fleet imessage-path [--json]';
export async function cmdFleetImessagePath(args: string[], deps: IMessagePathDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nInspect bounded iMessage path evidence without sending or changing configuration.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(usage);
    return 2;
  }
  const report = checkIMessagePath(deps);
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else {
    for (const [name, value] of Object.entries(report)) {
      if (typeof value !== 'string') console.log(`${name}: ${value.state} (${value.reason}) — ${value.nextStep}`);
    }
  }
  return 0;
}
