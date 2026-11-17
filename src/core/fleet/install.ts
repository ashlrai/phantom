import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { scrubPrivateText } from '../util/scrub.js';
export interface FleetInstallFile {
  name: string; source: string | null; sourceSha256: string | null; liveSha256: string | null;
  pinSha256: string | null; pinState: 'matched' | 'mismatch' | 'unpinned' | 'unknown';
  state: 'same' | 'drifted' | 'missing' | 'unknown'; diff: string | null;
}
const limit = 2 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safeName = (name: string) => /^[\w.-]+$/.test(name) && !name.includes('..');
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
async function readRegular(path: string): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Unavailable file');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const read = await fd.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) return bytes.subarray(0, size);
      size += read.bytesRead;
    }
    throw new Error('File exceeds limit');
  } finally { await fd.close(); }
}
/** Review only: candidates come from the local remote-tracking master snapshot. */
export async function previewFleetInstall(repo: string, bin: string) {
  repo = await realpath(repo);
  bin = await realpath(bin).catch(() => resolve(bin));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { timeout: 10_000, maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'] });
  const masterRef = 'refs/remotes/origin/master';
  const masterSha = git('rev-parse', '--verify', `${masterRef}^{commit}`).toString().trim();
  const source = (path: string) => git('show', `${masterSha}:${path}`);
  const manifest = JSON.parse(source('fleet/manifest.json').toString()) as { schema: string; files: { root: string; src?: string; name?: string }[] };
  if (manifest.schema !== 'fleet.machinery.v1' || !Array.isArray(manifest.files)) throw new Error('Invalid manifest');
  const entries = new Map<string, string | null>();
  const add = (name: string, path: string | null) => {
    if (!safeName(name) || (path !== null && (!/^[\w./-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..')))) throw new Error('Unsafe fleet path');
    if (entries.has(name) && entries.get(name) !== path) throw new Error('Ambiguous fleet mapping');
    entries.set(name, path);
  };
  for (const entry of manifest.files) if (entry.root === 'runs-bin') add(entry.name ?? basename(entry.src ?? ''), entry.src ?? null);
  const gaps: string[] = [];
  try {
    const names = source('contrib/mac/install.sh').toString().match(/^FILES="([^"]+)"/m)?.[1];
    if (!names) throw new Error('Unknown installer list');
    for (const name of names.split(/\s+/)) if (!entries.has(name)) add(name, `contrib/mac/${name}`);
  } catch { gaps.push('Installer inventory unknown.'); }
  let liveNames: Set<string> | null = null;
  try {
    liveNames = new Set(await readdir(bin));
    const tracked = git('ls-tree', '-r', '--name-only', masterSha, '--', 'contrib/mac').toString().trim().split('\n');
    for (const path of tracked) if (/^contrib\/mac\/[^/]+$/.test(path) && liveNames.has(basename(path)) && !entries.has(basename(path))) add(basename(path), path);
  } catch { gaps.push('Live counterpart inventory unknown; only declared modules are listed.'); }
  if (!entries.has('dispatchd_guard.py')) add('dispatchd_guard.py', null);
  const pins = new Map<string, string>();
  let pinsKnown = true;
  try {
    for (const line of (await readRegular(join(bin, 'sandbox-pins.tsv'))).toString().split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const fields = /^([\w.-]+)\t([a-f0-9]{64})$/i.exec(line);
      if (!fields || !safeName(fields[1]!) || pins.has(fields[1]!)) throw new Error('Unknown pins');
      pins.set(fields[1]!, fields[2]!.toLowerCase());
    }
  } catch { pinsKnown = false; pins.clear(); gaps.push('sandbox-pins.tsv unknown (missing, unreadable or invalid).'); }
  const scratchRoot = await realpath(tmpdir());
  if (inside(scratchRoot, bin)) throw new Error('Scratch overlaps live bin');
  const scratch = await mkdtemp(join(scratchRoot, 'fleet-install-'));
  const files: FleetInstallFile[] = [];
  try {
    for (const [name, path] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
      let candidate: Buffer | null = null; let live: Buffer | null = null;
      let missing = false;
      try { if (path) candidate = source(path); } catch { /* Unknown source stays unknown. */ }
      try { live = await readRegular(join(bin, name)); } catch (error) { missing = liveNames !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      const sourceSha256 = candidate === null ? null : digest(candidate);
      const liveSha256 = live === null ? null : digest(live);
      const state = candidate === null ? 'unknown' : missing ? 'missing' : live === null ? 'unknown' : liveSha256 === sourceSha256 ? 'same' : 'drifted';
      const pinSha256 = pins.get(name) ?? null;
      const pinState = !pinsKnown ? 'unknown' : pinSha256 === null ? 'unpinned' : liveSha256 === null ? 'unknown' : pinSha256 === liveSha256 ? 'matched' : 'mismatch';
      let diff: string | null = state === 'same' ? '' : null;
      if (candidate && (live || missing) && state !== 'same' && !candidate.includes(0) && !live?.includes(0)) {
        // Scrub before diffing so multiline redaction cannot invalidate hunk counts.
        await writeFile(join(scratch, 'live'), scrubPrivateText((live ?? Buffer.alloc(0)).toString()), { mode: 0o600 });
        await writeFile(join(scratch, 'master'), scrubPrivateText(candidate.toString()), { mode: 0o600 });
        const result = spawnSync('diff', ['-u', '-L', `live/${name}`, '-L', `master/${path}`, join(scratch, 'live'), join(scratch, 'master')], { encoding: 'utf8', timeout: 10_000, maxBuffer: limit * 3 });
        if (!result.error && (result.status === 0 || result.status === 1)) diff = result.stdout;
      }
      files.push({ name, source: path, sourceSha256, liveSha256, pinSha256, pinState, state, diff });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const unknown = files.filter(file => file.state === 'unknown' || file.pinState === 'unknown' || file.diff === null).length;
  if (unknown) gaps.push(`${unknown} modules have unknown source, live bytes, pins or diffs.`);
  const bundle = `docs/proposals/fleet-install-${new Date().toISOString().slice(0, 10)}.md`;
  const notLive = files.filter(file => file.state === 'drifted' || file.state === 'missing').length;
  const summary = `${notLive || !unknown ? `${notLive} merged fleet modules are not live; ${unknown} unknown` : `Live fleet status unknown for ${unknown} modules`}; bundle at ${bundle}`;
  const report = { schema: 'fleet.install.v1' as const, masterRef, masterSha, liveBin: bin, files, bundle, summary, gaps };
  const lines = ['# Fleet install review', '', summary, '', `Merged snapshot: ${masterRef} at ${masterSha} (local; not fetched).`,
    `Live bin: ${scrubPrivateText(bin)}. Security must review and pin before installation. Diffs are scrubbed review text, not installable patches.`,
    'Tests run: unknown; this preview runs no tests. Record validation before Security adoption.',
    'Rollback: Security retains prior files and matching pins together; restore that reviewed pair and verify hashes before resuming. This command never installs or rolls back.',
    'Gap: PR-level fix attribution and installed runtime acceptance are unknown. Counts refer to files, not PRs.', ...gaps, '',
    `Source, live hash, pin and diff unknown: ${files.filter(f => f.source === null && f.liveSha256 === null && f.pinSha256 === null && f.pinState === 'unknown').map(f => f.name).join(', ') || 'none'}.`, '',
    '| File | Source | State | Source sha256 | Live sha256 | Pin sha256 | Pin state |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...files.filter(f => f.source !== null || f.liveSha256 !== null || f.pinSha256 !== null || f.pinState !== 'unknown').map(f => `| ${f.name} | ${f.source ?? 'unknown'} | ${f.state} | ${f.sourceSha256 ?? 'unknown'} | ${f.liveSha256 ?? 'unknown'} | ${f.pinSha256 ?? 'unknown'} | ${f.pinState} |`), '', '## Diffs',
    ...files.filter(f => f.diff).map(f => `### ${f.name}\n\n~~~~diff\n${f.diff}\n~~~~`), 'Hashes compare original bytes; empty review diffs may reflect redaction. Null diffs are unknown.'];
  // Fixed output only, no symlinked directories and no writes anywhere under live bin.
  for (const part of ['docs', 'docs/proposals']) {
    const dir = join(repo, part);
    if (inside(dir, bin)) throw new Error('Bundle overlaps live bin');
    await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw new Error('Unsafe bundle directory');
  }
  const staging = await mkdtemp(join(repo, 'docs/proposals/.fleet-install-'));
  try {
    await writeFile(join(staging, 'bundle'), lines.join('\n') + '\n', { mode: 0o600 });
    await rename(join(staging, 'bundle'), join(repo, bundle));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return report;
}
