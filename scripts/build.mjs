import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NPM_BUILD_STEPS } from './build-outputs.mjs';

export function runBuild(steps = NPM_BUILD_STEPS, spawn = spawnSync) {
  const previousMask = process.umask(0o022);
  try {
    for (const { command } of steps) {
      const result = spawn(command, { shell: true, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    process.umask(previousMask);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runBuild();
}
