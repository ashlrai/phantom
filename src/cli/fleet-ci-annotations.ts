import { readCiAnnotations, validCiRepo } from '../core/fleet/ci-annotations.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-annotations --repo <owner/repo> --job <id> [--json]';
export async function cmdFleetCiAnnotations(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--job'].includes(arg) || values.has(arg) || !args[i + 1]) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? '', jobText = values.get('--job') ?? '';
  const job = Number(jobText);
  if (!validCiRepo(repo) || !/^\d+$/.test(jobText) || !Number.isSafeInteger(job) || job <= 0) {
    process.stderr.write(`Invalid repository or ID. ${USAGE}\n`); return 2;
  }
  const result = await readCiAnnotations(repo, job, deps.gh);
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(`CI annotations ${result.repo} run ${result.run ?? 'unknown'} job ${job} check ${result.check ?? 'unknown'} head ${result.headSha ?? 'unknown'}: ${result.source.status}`);
    for (const a of result.annotations) console.log(`  ${a.path}:${a.startLine}${a.startColumn === null ? '' : `:${a.startColumn}`}: ${a.level}: ${a.title} ${a.message}`);
    if (result.source.status === 'ok' && !result.annotations.length) console.log('  No annotations.');
    if (result.source.outputTruncated) console.log('  Annotation fields were truncated.');
  }
  return result.source.status === 'ok' ? 0 : 1;
}
