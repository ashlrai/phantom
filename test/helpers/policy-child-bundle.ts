/**
 * Pre-built policy module for authority-recovery subprocess tests.
 *
 * M422/M425 run the real enrollment policy in fresh Node processes so each
 * call observes only the on-disk transaction state a restarted host would see.
 * Spawning those children as `node --import tsx` made every call boot the tsx
 * loader (its hooks worker thread plus esbuild's JS API, loaded twice) before
 * touching policy.ts: about 350 ms per child on Linux and several seconds on a
 * contended hosted Windows runner, paid 14 times in M422 alone.
 *
 * The policy graph is plain TypeScript over Node builtins, so it is bundled
 * once per file with esbuild (the same transform tsx would apply) and the
 * children import the resulting ESM with plain `node`. The product code a
 * child runs is unchanged; only the per-child loader boot is gone. Same
 * pattern as test/resource-quota-launch-handoff.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const policySourcePath = fileURLToPath(new URL('../../src/core/sandbox/policy.ts', import.meta.url));

export interface PolicyChildBundle {
  /** file:// URL a child imports in place of src/core/sandbox/policy.ts. */
  moduleUrl: string;
  dispose(): void;
}

export async function bundlePolicyModuleForChildren(): Promise<PolicyChildBundle> {
  const directory = mkdtempSync(join(tmpdir(), 'ashlr-policy-child-'));
  const outfile = join(directory, 'policy.mjs');
  try {
    // Every dependency is bundled (platform 'node' keeps only builtins
    // external), so the output resolves nothing relative to the temp dir.
    await build({
      entryPoints: [policySourcePath],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outfile,
      logLevel: 'silent',
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    moduleUrl: pathToFileURL(outfile).href,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
