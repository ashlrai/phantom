/** Inspect or seed a worktree's TypeScript incremental cache. */
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const USAGE = 'Usage: ashlr fleet tsc-warm [--dir <dir>] [--from <donor dir>] [--apply] [--json]';

type Cache = { path: string; bytes: number | null };
export interface TscWarmReport {
  schema: 'fleet.tsc-warm.v1';
  target: Cache;
  donor: Cache | null;
  action: 'target-exists' | 'donor-missing' | 'no-donor' | 'would-copy' | 'copied';
}

async function cache(path: string): Promise<Cache> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Not a file: ${path}`);
    return { path, bytes: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, bytes: null };
    throw error;
  }
}

export async function fleetTscWarm(dir: string, from: string | undefined, apply: boolean): Promise<TscWarmReport> {
  const configPath = resolve(dir, 'tsconfig.json');
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  const value: unknown = (config as { compilerOptions?: { tsBuildInfoFile?: unknown } })?.compilerOptions?.tsBuildInfoFile;
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) {
    throw new Error(`${configPath}: compilerOptions.tsBuildInfoFile must be a relative path`);
  }
  const target = await cache(resolve(dir, value));
  const donor = from ? await cache(resolve(from, value)) : null;
  let action: TscWarmReport['action'] = target.bytes !== null ? 'target-exists' : !donor ? 'no-donor' : donor.bytes === null ? 'donor-missing' : 'would-copy';
  if (action === 'would-copy' && apply && donor) {
    await mkdir(dirname(target.path), { recursive: true });
    try {
      await copyFile(donor.path, target.path, constants.COPYFILE_EXCL);
      target.bytes = (await cache(target.path)).bytes;
      action = 'copied';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      target.bytes = (await cache(target.path)).bytes;
      action = 'target-exists';
    }
  }
  return { schema: 'fleet.tsc-warm.v1', target, donor, action };
}

export async function cmdFleetTscWarm(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${USAGE}\nInspect the cache; copy from the donor only with --apply. Existing caches are preserved.`);
    return 0;
  }
  let dir = process.cwd();
  let from: string | undefined;
  let apply = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--dir' || arg === '--from') {
      const value = args[++i];
      if (!value || value.startsWith('--')) { console.error(USAGE); return 2; }
      if (arg === '--dir') dir = value; else from = value;
    } else { console.error(USAGE); return 2; }
  }
  try {
    const report = await fleetTscWarm(dir, from, apply);
    const display = (item: Cache | null): string => item ? `${item.path} (${item.bytes === null ? 'missing' : `${item.bytes} bytes`})` : 'not provided';
    console.log(json ? JSON.stringify(report) : `Target: ${display(report.target)}\nDonor: ${display(report.donor)}\nAction: ${report.action}`);
    return 0;
  } catch (error) {
    console.error(`tsc-warm: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
