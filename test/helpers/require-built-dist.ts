import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root that `npm run build` writes `dist/` into. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Fail clearly when this checkout has no build output.
 *
 * Importing `require-built-dist.js` is the marker the docs CI lane uses to
 * leave the file out of its Markdown run. The full suite still runs the file
 * after `npm run build`. Pass `root` only from tests that point at a temp tree.
 */
export function requireBuiltDist(
  relativePaths: readonly string[] = ['dist'],
  root: string = packageRoot,
): void {
  const missing = relativePaths.filter((relativePath) => !existsSync(join(root, relativePath)));
  if (missing.length > 0) {
    throw new Error(`missing ${missing.join(', ')}; run npm run build first`);
  }
}
