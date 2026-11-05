import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jobPathHistory, validJobId } from './job-path-history.js';
import { sanitizePublicJson } from '../util/public-json.js';

const exec = promisify(execFile);
const PATCH_LIMIT = 64 * 1024;

export function validPatchPath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
    && !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Drain the child even after the cap, retaining only bounded output. Git's normal
// patch format reports binary files without emitting their binary payloads.
async function readPatch(sha: string, path?: string): Promise<{ patch: string; truncated: boolean }> {
  const args = ['--literal-pathspecs', 'show', '--format=', '--first-parent', '--root', '-m',
    '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', sha, '--', ...(path ? [path] : [])];
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { timeout: 30_000, encoding: 'buffer' });
    // execFile normally buffers stdout internally; replace its data handlers.
    child.stdout!.removeAllListeners('data');
    child.stderr!.removeAllListeners('data');
    const chunks: Buffer[] = [];
    let retained = 0, total = 0;
    child.stdout!.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (retained < PATCH_LIMIT) {
        const part = chunk.subarray(0, PATCH_LIMIT - retained);
        chunks.push(part); retained += part.length;
      }
    });
    child.stderr!.resume();
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal) { reject(new Error('git patch read failed')); return; }
      let patch = Buffer.concat(chunks).toString('utf8');
      const truncated = total > PATCH_LIMIT;
      // Do not expose a partial final line, which could split a secret token.
      if (truncated) patch = patch.slice(0, Math.max(0, patch.lastIndexOf('\n') + 1));
      resolve({ patch, truncated });
    });
  });
}

export async function jobPatch(job: string, path?: string) {
  if (!validJobId(job) || (path !== undefined && !validPatchPath(path))) throw new Error('invalid arguments');
  const resolvedRef = (await exec('git', ['rev-parse', '--verify', 'origin/master^{commit}'],
    { encoding: 'utf8', timeout: 30_000 })).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(resolvedRef)) throw new Error('invalid ref');
  const history = await jobPathHistory(job, resolvedRef, 1);
  const commit = history.commits[0];
  if (commit && path !== undefined && !commit.paths.includes(path)) throw new Error('path not in commit');
  const patch = commit ? await readPatch(commit.sha, path) : { patch: '', truncated: false };
  const report = { schema: 'fleet.job-patch.v1', jobId: job, resolvedRef, status: commit ? 'found' : 'not-found-in-bounded-scan',
    commit: commit?.sha ?? null, pr: commit?.pr ?? null, paths: commit?.paths ?? [], selectedPath: path ?? null,
    scanBound: history.scanBound, scanned: history.scanned, scanMayBeTruncated: history.scanMayBeTruncated,
    matchesTruncated: history.matchesTruncated, patch: patch.patch, patchTruncated: patch.truncated };
  const safe = sanitizePublicJson(report) as typeof report;
  if (Buffer.byteLength(safe.patch) > PATCH_LIMIT) {
    const bytes = Buffer.from(safe.patch).subarray(0, PATCH_LIMIT);
    safe.patch = new TextDecoder('utf-8').decode(bytes).replace(/\uFFFD$/, '');
    safe.patchTruncated = true;
  }
  return safe;
}
