import { isAbsolute, resolve } from 'node:path';
import {
  GUARDIAN_MANIFEST_MAX_ENTRIES,
  GUARDIAN_MAX_PATH_LENGTH,
  GUARDIAN_SHA_RE,
  guardianVerificationKey,
  isValidGuardianRepoPath,
  readGuardianManifest,
  readGuardianState,
} from './guardian-schema.js';

// Validate the entire input before reporting no work, using the same schemas as
// retry preparation. The key binds every manifest field, including optional IDs.
export async function selectNextGuardianInfraRetry(options: { manifest: string; sourceState: string; outputState: string; exclude?: readonly { repo: string; sha: string }[] }): Promise<{ repo: string; sha: string } | null> {
  if (![options.manifest, options.sourceState, options.outputState].every(p => isAbsolute(p) && p.length <= GUARDIAN_MAX_PATH_LENGTH) ||
    resolve(options.sourceState) === resolve(options.outputState)) throw new Error('invalid guardian-retry paths');
  const inputs = await readGuardianManifest(options.manifest);
  const state = await readGuardianState(options.sourceState);
  if (options.exclude !== undefined && (!Array.isArray(options.exclude) || options.exclude.length > GUARDIAN_MANIFEST_MAX_ENTRIES || options.exclude.some(e => !e || !isValidGuardianRepoPath(e.repo) || typeof e.sha !== 'string' || !GUARDIAN_SHA_RE.test(e.sha)))) throw new Error('invalid retry exclusions');
  const excluded = new Set((options.exclude ?? []).map(e => `${resolve(e.repo)}\0${e.sha}`));
  const identities = new Map(inputs.map(input => [guardianVerificationKey(input), input]));
  const eligible = state.entries.filter(e => {
    const input = identities.get(e.key);
    return !excluded.has(`${resolve(e.repo)}\0${e.sha}`) && input !== undefined && resolve(input.repo) === resolve(e.repo) && input.mergeCommit === e.sha &&
      e.terminal === 'fail' && e.failureCategory === 'infra' && (e.cleanup === 'removed' || e.cleanup === 'not-created');
  });
  eligible.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const selected = eligible[0];
  return selected ? { repo: selected.repo, sha: selected.sha } : null;
}
