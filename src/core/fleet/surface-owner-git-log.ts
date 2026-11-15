/** Shared bounded origin/master history reader for surface ownership evidence. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SurfaceOwnerDeps } from './surface-owner.js';

const exec = promisify(execFile);

export const gitSurfaceLog: SurfaceOwnerDeps['log'] = async (file, count) => {
  const { stdout } = await exec('git', ['--literal-pathspecs', 'log', `-n${count * 3}`, '--format=%h%x09%cI%x09%s', 'origin/master', '--', file],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return Promise.all(stdout.split('\n').filter(Boolean).map(async line => {
    const [sha = '', date = '', ...subject] = line.split('\t');
    let filesChanged: number | null = null;
    try {
      const { stdout: names } = await exec('git', ['show', '--format=', '--name-only', '-z', sha],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      filesChanged = names.split('\0').filter(Boolean).length;
    } catch { /* Unknown counts preserve existing behavior. */ }
    return { sha, date, subject: subject.join('\t'), filesChanged };
  }));
};
