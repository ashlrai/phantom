import { execFileSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const gitProbe = spawnSync('git', ['--version'], { stdio: 'ignore' });
const gitUnavailable = gitProbe.error && (gitProbe.error as NodeJS.ErrnoException).code === 'ENOENT';

it.skipIf(gitUnavailable)('keeps generated binaries and oversized files out of the tracked root', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const bunArtifacts = paths.filter((path) => path.endsWith('.bun-build'));
  expect(bunArtifacts, `Tracked Bun build artifacts: ${bunArtifacts.join(', ')}`).toEqual([]);

  const oversized = paths.filter((path) => {
    if (path.includes('/')) return false;
    try {
      return statSync(new URL(`../${path}`, import.meta.url)).size > 5 * 1024 * 1024;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
  expect(oversized, `Tracked root files larger than 5 MB: ${oversized.join(', ')}`).toEqual([]);
});
