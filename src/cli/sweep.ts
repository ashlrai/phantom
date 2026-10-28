import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: phm sweep report [--repo <directory>]';

export async function cmdSweep(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(usage);
    return 0;
  }
  if (args[0] !== 'report') {
    console.error(usage);
    return 2;
  }
  if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) {
    console.log(usage);
    return 0;
  }
  const rest = args.slice(1);
  if (rest.length !== 0 && !(rest.length === 2 && rest[0] === '--repo' && rest[1] && !rest[1].startsWith('-'))) {
    console.error(usage);
    return 2;
  }
  // The maintenance script lives in a Phantom checkout, not in the package.
  const script = fileURLToPath(new URL('../../scripts/must-earn-its-place.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Sweep failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
