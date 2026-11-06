import { lstat, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

// Private per-invocation session directories for `fleet guardian-drain
// --new-session`: an agent reusing one output parent across unattended runs
// would otherwise collide on guardian-drain-attempt-1.json from a prior run
// (the drain refuses overwrite by design). The opt-in allocates one unique
// child per applied invocation so every attempt artifact lands under it.
export const GUARDIAN_DRAIN_SESSION_PREFIX = 'guardian-drain-';

/** Bounded from the core drain's stop-file contract: non-ENOENT means unusable. */
export type GuardianDrainStopStatus = 'stopped' | 'unsafe' | null;

/** Reports 'stopped' when the stop file exists and 'unsafe' on any other
 * lstat failure; mirrors the core drain's pre-flight so the CLI never
 * allocates a session directory the run would not use. */
export async function guardianDrainStopStatus(path?: string): Promise<GuardianDrainStopStatus> {
  if (path === undefined) return null;
  try { await lstat(path); return 'stopped'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unsafe'; }
}

/** Allocates a fresh, private (mkdtemp-default 0700) session directory
 * directly under an existing parent. The parent must already exist: any
 * failure (missing parent, permissions, exhausted names) rejects so the
 * caller can fail before launching verification. */
export async function createGuardianDrainSession(parent: string): Promise<string> {
  if (!isAbsolute(parent) || parent.length > 4000 || parent.includes('\0')) {
    throw Object.assign(new Error('guardian-drain session parent must be a bounded absolute path'), { code: 'EINVAL' });
  }
  return mkdtemp(join(parent, GUARDIAN_DRAIN_SESSION_PREFIX));
}
