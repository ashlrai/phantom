import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface DeployPlanFile {
  repoPath: string;
  livePath: string;
  repoSha256: string;
  liveSha256: string | null;
  shaPinned: boolean | null;
  status: 'missing' | 'drifted' | 'unreadable';
  action: 'security-review' | 'review';
}
export interface FleetDeployPlan {
  schema: 'fleet.deploy-plan.v1';
  since: string;
  head: string;
  checked: number;
  inSync: number;
  files: DeployPlanFile[];
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Compare committed fleet sources only. No execution, installation or pin changes. */
export async function buildFleetDeployPlan(repo: string, bin: string, since: string): Promise<FleetDeployPlan> {
  if (!/^[a-f0-9]{7,40}$/i.test(since)) throw new Error('--since needs a commit SHA (7–40 hex characters).');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const head = git('rev-parse', 'HEAD').toString().trim();
  const base = git('rev-parse', '--verify', `${since}^{commit}`).toString().trim();
  git('merge-base', '--is-ancestor', base, head);
  const manifest = JSON.parse(git('show', `${head}:fleet/manifest.json`).toString()) as {
    schema: string; files: { src?: string; name?: string; root: string; class: string; sha256?: string; note?: string }[];
  };
  if (manifest.schema !== 'fleet.machinery.v1' || !Array.isArray(manifest.files)) throw new Error('Unsupported fleet manifest.');
  const installer = git('show', `${head}:contrib/mac/install.sh`).toString();
  const pinnedNames = new Set((installer.match(/^FILES="([^"]+)"/m)?.[1] ?? '').split(/\s+/));
  const paths = git('diff', '--name-only', '-z', '--diff-filter=ACMRT', base, head).toString().split('\0').filter(Boolean);
  const report: FleetDeployPlan = { schema: 'fleet.deploy-plan.v1', since: base, head, checked: 0, inSync: 0, files: [] };
  for (const repoPath of paths.sort()) {
    const entry = manifest.files.find(file => file.root === 'runs-bin' && file.src === repoPath);
    if (!entry && !/^contrib\/mac\/[^/]+\.(?:py|sh|pl)$/.test(repoPath)) continue;
    const name = entry?.name ?? basename(repoPath);
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw new Error('Unsafe fleet destination name.');
    const livePath = join(bin, name);
    const repoSha256 = digest(git('show', `${head}:${repoPath}`));
    const shaPinned = entry?.class === 'pinned' || !!entry?.sha256 || /re-pin|sha-pinned/i.test(entry?.note ?? '') || pinnedNames.has(name) ? true : entry ? false : null;
    let liveSha256: string | null = null;
    let status: DeployPlanFile['status'] = 'missing';
    try {
      const stat = await lstat(livePath);
      if (!stat.isFile() || stat.isSymbolicLink()) status = 'unreadable';
      else { liveSha256 = digest(await readFile(livePath)); status = 'drifted'; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') status = 'unreadable';
    }
    report.checked++;
    if (liveSha256 === repoSha256) { report.inSync++; continue; }
    report.files.push({ repoPath, livePath, repoSha256, liveSha256, shaPinned, status, action: shaPinned !== false ? 'security-review' : 'review' });
  }
  return report;
}
