/**
 * Protected model roots: directories that hold downloaded model weights and
 * engine caches. Disk maintenance (steward policy, cache sweeps) must never
 * delete these by default — re-downloading multi-GB weights is expensive and
 * the bytes are operator-owned data, not rebuildable build output.
 *
 * These are the custody roots the oMLX/HF download path relies on; see
 * docs/OMLX-SMALL-MACS.md. Weights live under $HOME, never inside the repo.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Home-relative directories that store model weights or engine model caches. */
export const PROTECTED_MODEL_CACHE_DIRS: readonly string[] = Object.freeze([
  // Hugging Face hub cache (HF_HOME default): oMLX and mlx-lm download here.
  '.cache/huggingface',
  // oMLX's own data/model caches (XDG-style and app-root variants).
  '.cache/omlx',
  '.omlx',
  // Other local-engine weight stores; same "never reap" policy.
  '.ollama/models',
  '.lmstudio/models',
  // Phantom's own model root.
  '.ashlr/models',
]);

/** Absolute protected roots under `home`. */
export function modelCacheRoots(home: string = homedir()): string[] {
  return PROTECTED_MODEL_CACHE_DIRS.map(dir => join(home, dir));
}

/** True when `path` equals or sits inside a protected model cache root under `home`. */
export function isProtectedModelPath(path: string, home: string = homedir()): boolean {
  if (!isAbsolute(path) || !isAbsolute(home)) return false;
  const base = resolve(home);
  for (const dir of PROTECTED_MODEL_CACHE_DIRS) {
    const root = resolve(base, dir);
    const rel = relative(root, resolve(path));
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
  }
  return false;
}
