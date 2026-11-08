import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Locate the same standard-library implementation used by the restocker. */
export function findQueueUnparkScript(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const script = join(dir, 'contrib', 'mac', 'queue_autounpark.py');
    if (existsSync(script)) return script;
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) {
      throw new Error('Queue unpark helper is missing from this installation');
    }
  }
}

export async function cmdQueueParked(args: string[]): Promise<number> {
  const dryRun = args[0] === 'unpark';
  if (args.some(arg => !['parked', 'unpark', '--dry-run', '--json'].includes(arg)) ||
      (dryRun && !args.includes('--dry-run')) || (!dryRun && args.includes('--dry-run'))) {
    console.error('Usage: phm queue parked [--json] | phm queue unpark --dry-run [--json]');
    return 2;
  }
  try {
    const { stdout } = await exec('python3', ['-I', findQueueUnparkScript(), dryRun ? 'dry-run' : 'parked'], {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    const result = JSON.parse(stdout);
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch {
    console.error('Queue parking inspection failed; no queue files changed.');
    return 1;
  }
}
