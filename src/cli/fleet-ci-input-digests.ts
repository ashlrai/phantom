import { open } from 'node:fs/promises';
import { CiResumeInputsError } from '../core/fleet/ci-resume-inputs.js';
import { ciInputDigests } from '../core/fleet/ci-input-digests.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-input-digests --manifest <file> --head <hex-revision> [--json]';
const LIMIT = 1024 * 1024;

export async function cmdFleetCiInputDigests(args: string[], deps: { git?: GitRunner; cwd?: string } = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--head'].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('-')) {
      process.stderr.write(`${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const file = values.get('--manifest'); const head = values.get('--head');
  if (!file || !head) { process.stderr.write(`${USAGE}\n`); return 2; }
  try {
    let manifest: unknown;
    try {
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > LIMIT) throw new CiResumeInputsError('manifest file must be a regular file of at most 1 MiB');
        const buffer = Buffer.alloc(LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > LIMIT) throw new CiResumeInputsError('manifest file must be a regular file of at most 1 MiB');
        manifest = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof CiResumeInputsError) throw error;
      throw new CiResumeInputsError('manifest file cannot be read as JSON');
    }
    const seeds = await ciInputDigests({ manifest, head, cwd: deps.cwd ?? process.cwd(), git: deps.git });
    if (json) console.log(JSON.stringify(seeds, null, 2));
    else {
      console.log(`CI input digest seeds (not receipts): ${seeds.repo} ${seeds.head}`);
      for (const job of seeds.jobs) console.log(`  ${job.id}: ${job.inputDigest}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof CiResumeInputsError)) throw error;
    process.stderr.write(`ci-input-digests: ${error.message}\n`); return 2;
  }
}
