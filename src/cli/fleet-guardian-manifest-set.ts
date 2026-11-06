import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  GUARDIAN_MANIFEST_SET_DEFAULT_LIMIT,
  GUARDIAN_MANIFEST_SET_MAX_ENTRIES,
  parseGuardianManifestSetSpecs,
  runGuardianManifestSet,
  type GuardianManifestSetDeps,
  type GuardianManifestSetSpec,
} from '../core/fleet/guardian-manifest-set.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

// Exit codes: 0 manifest written, 1 git failure / a repo with zero eligible
// entries / write failure, 2 invalid arguments or repos-file content. Errors
// are fixed text only: never file contents, commit subjects or user input.
export async function cmdFleetGuardianManifestSet(
  args: string[],
  deps: GuardianManifestSetDeps = {},
): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--repos-file', '--out', '--limit-per-repo'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-manifest-set arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  const reposFile = values['--repos-file'];
  const out = values['--out'];
  const rawLimit = values['--limit-per-repo'];
  const limit = rawLimit === undefined ? GUARDIAN_MANIFEST_SET_DEFAULT_LIMIT
    : /^[1-9]\d*$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (reposFile === undefined || out === undefined || !isAbsolute(reposFile) || !isAbsolute(out)) {
    process.stderr.write('error: guardian-manifest-set requires absolute --repos-file and --out paths\n'); return 2;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GUARDIAN_MANIFEST_SET_MAX_ENTRIES) {
    process.stderr.write('error: --limit-per-repo must be an integer from 1 to 100\n'); return 2;
  }
  let specs: GuardianManifestSetSpec[];
  try {
    specs = parseGuardianManifestSetSpecs(JSON.parse(await readFile(reposFile, 'utf8')));
  } catch {
    process.stderr.write('error: --repos-file must decode to an array of 1..20 {repo, branch?} objects: absolute repo paths, valid branches, no duplicate repository+branch\n');
    return 2;
  }
  if (specs.length * limit > GUARDIAN_MANIFEST_SET_MAX_ENTRIES) {
    process.stderr.write('error: configured entry budget (repos x --limit-per-repo) exceeds 100\n'); return 2;
  }
  try {
    const target = resolve(out);
    const summary = await runGuardianManifestSet({ specs, limitPerRepo: limit, out: target }, deps);
    const safe = sanitizePublicJson(summary);
    console.log(json
      ? JSON.stringify(safe)
      : `guardian-manifest-set: wrote ${summary.written} entries from ${summary.repos.length} repos to ${target}`);
    return 0;
  } catch {
    process.stderr.write('error: guardian-manifest-set could not read commits or write the manifest\n');
    return 1;
  }
}
