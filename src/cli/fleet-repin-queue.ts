import { securityRepinQueue } from './security-repin-queue.js';

const usage = 'Usage: phm fleet repin-queue --json\nRead the repository Security re-pin queue without inspecting or modifying the host.';

export async function cmdFleetRepinQueue(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(usage);
    return 0;
  }
  if (args.length !== 1 || args[0] !== '--json') {
    console.error(usage);
    return 2;
  }
  console.log(JSON.stringify(securityRepinQueue));
  return 0;
}
