import { isAbsolute, resolve } from 'node:path';
import {
  GUARDIAN_MAX_PATH_LENGTH,
  GUARDIAN_SHA_RE,
  guardianVerificationKey,
  isValidGuardianRepoPath,
  readGuardianManifest,
  readGuardianState,
  writePrivateExclusive,
} from './guardian-schema.js';

export interface GuardianRetryOptions { manifest: string; sourceState: string; outputState: string; repo: string; sha: string }
export interface GuardianRetrySummary { removed: number; retained: number; nextAction: string }

export async function prepareGuardianRetryState(options: GuardianRetryOptions): Promise<GuardianRetrySummary> {
  if (![options.manifest, options.sourceState, options.outputState].every(p => isAbsolute(p) && p.length <= GUARDIAN_MAX_PATH_LENGTH) ||
    !isValidGuardianRepoPath(options.repo) || !GUARDIAN_SHA_RE.test(options.sha)) throw new Error('invalid guardian-retry arguments');
  if (resolve(options.sourceState) === resolve(options.outputState)) throw new Error('source and output state must differ');
  const inputs = await readGuardianManifest(options.manifest);
  const state = await readGuardianState(options.sourceState);
  const repo = resolve(options.repo);
  const matches = inputs.filter(i => resolve(i.repo) === repo && i.mergeCommit === options.sha);
  if (matches.length !== 1) throw new Error('manifest identity must match exactly once');
  const k = guardianVerificationKey(matches[0]!);
  const kept = state.entries.filter(e => !(e.key === k && e.terminal === 'fail'));
  if (kept.length === state.entries.length) throw new Error('no matching failed entry');
  await writePrivateExclusive(options.outputState, JSON.stringify({ version: 1, entries: kept }));
  return { removed: state.entries.length - kept.length, retained: kept.length, nextAction: `guardian-verify --state ${options.outputState}` };
}
