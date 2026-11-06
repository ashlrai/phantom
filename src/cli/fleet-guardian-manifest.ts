import { isAbsolute, resolve } from 'node:path';
import { guardianManifestEntries, readFirstParentCommits, writeGuardianManifest } from '../core/fleet/guardian-manifest.js';

// Exit codes: 0 manifest written, 1 git failure / zero eligible commits / write
// failure, 2 invalid arguments. Never prints commit subjects or bodies.
export async function cmdFleetGuardianManifest(args: string[]): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--branch', '--limit', '--out'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-manifest arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  const repo = values['--repo'];
  const branch = values['--branch'] ?? 'master';
  const out = values['--out'];
  const limit = values['--limit'] === undefined ? 20 : /^[1-9]\d*$/.test(values['--limit']!) ? Number(values['--limit']) : NaN;
  // eslint-disable-next-line no-control-regex -- repo strings must not contain control bytes
  if (repo === undefined || !isAbsolute(repo) || repo.length > 4096 || /[\x00-\x1f\x7f]/.test(repo)) {
    process.stderr.write('error: --repo must be an absolute repository path\n'); return 2;
  }
  if (out === undefined) { process.stderr.write('error: --out is required\n'); return 2; }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    process.stderr.write('error: --limit must be an integer from 1 to 100\n'); return 2;
  }
  // eslint-disable-next-line no-control-regex -- branch names must not contain control bytes
  if (branch.length < 1 || branch.length > 256 || branch.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(branch)) {
    process.stderr.write('error: --branch must not start with - or contain whitespace or control characters\n'); return 2;
  }
  try {
    const resolvedRepo = resolve(repo);
    const commits = await readFirstParentCommits(resolvedRepo, branch, limit);
    const entries = guardianManifestEntries(commits, { repo: resolvedRepo, branch });
    const target = resolve(out);
    await writeGuardianManifest(target, entries);
    console.log(json
      ? JSON.stringify({ written: entries.length, entries, out: target })
      : `guardian-manifest: wrote ${entries.length} entries to ${target}`);
    return 0;
  } catch {
    process.stderr.write('error: guardian-manifest could not read commits or write the manifest\n');
    return 1;
  }
}
