import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export interface BridgeInstallDeps { fs?: typeof fs; now?: () => Date; source?: string }
interface Manifest { schemaVersion: 1; releaseId: string; time: string; files: Record<string, string> }
export interface BridgeInstallResult {
  schemaVersion: 1; root: string; releaseId: string; applied: boolean; unchanged: boolean;
  started: false; files: { name: string; status: 'new' | 'changed' | 'same' | 'removed'; sha256?: string }[];
}
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const selected = (name: string) => (name.endsWith('.py') && !name.startsWith('test_')) || name === 'with-memory.sh';
const releaseId = (files: Record<string, string>) => hash(Object.keys(files).sort().map(name => `${files[name]} ${name}`).join('\n')).slice(0, 12);
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };

/** Locate checkout assets from either src/ or dist/, without depending on cwd. */
export async function findBridgeSource(io: typeof fs = fs): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'scripts/mac-bridge');
    try { if ((await io.stat(candidate)).isDirectory()) return candidate; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('bridge-install needs a source checkout (scripts/mac-bridge is absent).');
    dir = parent;
  }
}

/** Copy and verify immutable releases, then publish through one atomic symlink rename. */
export async function installBridge(options: { root?: string; apply?: boolean } = {}, deps: BridgeInstallDeps = {}): Promise<BridgeInstallResult> {
  const io = deps.fs ?? fs;
  const root = await io.realpath(resolve(options.root ?? join(homedir(), '.ashlr-runs')));
  if (!(await io.stat(root)).isDirectory()) throw new Error(`Root is not an existing directory: ${root}`);
  const source = deps.source ?? await findBridgeSource(io);
  const base = join(root, 'mac-bridge'), releases = join(base, 'releases'), current = join(base, 'current');
  const exists = async (path: string) => { try { return await io.lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  for (const path of [base, releases, current]) {
    const stat = await exists(path);
    if (stat?.isSymbolicLink() && !inside(base, await io.realpath(path))) throw new Error(`Outside symlink refused: ${path}`);
    if (stat && !(await io.stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  }
  const readManifest = async (dir: string): Promise<Manifest> => {
    const manifestPath = join(dir, 'manifest.json');
    if (!(await io.lstat(manifestPath)).isFile()) throw new Error(`Invalid manifest: ${manifestPath}`);
    const raw = JSON.parse(await io.readFile(manifestPath, 'utf8')) as Manifest;
    if (raw.schemaVersion !== 1 || raw.releaseId !== basename(dir) || !/^[a-f0-9]{12}$/.test(raw.releaseId)
      || !Number.isFinite(Date.parse(raw.time)) || !raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)
      || Object.entries(raw.files).some(([name, sum]) => basename(name) !== name || !selected(name) || typeof sum !== 'string' || !/^[a-f0-9]{64}$/.test(sum))
      || releaseId(raw.files) !== raw.releaseId) throw new Error(`Invalid manifest: ${dir}`);
    return raw;
  };
  const verify = async (dir: string, manifest: Manifest) => {
    for (const [name, sum] of Object.entries(manifest.files)) {
      const path = join(dir, name);
      const stat = await exists(path);
      if (!stat?.isFile() || stat.isSymbolicLink() || hash(await io.readFile(path)) !== sum) throw new Error(`Release verification failed: ${name}`);
    }
  };
  const contents = new Map<string, Buffer>();
  for (const entry of (await io.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && !entry.isSymbolicLink() && selected(entry.name)) contents.set(entry.name, await io.readFile(join(source, entry.name)));
  }
  const sums = Object.fromEntries([...contents].map(([name, data]) => [name, hash(data)]));
  const id = releaseId(sums), target = join(releases, id);
  const oldDir = await exists(current) ? await io.realpath(current) : null;
  const old = oldDir ? await readManifest(oldDir) : null;
  const result: BridgeInstallResult = { schemaVersion: 1, root, releaseId: id, applied: false, unchanged: false, started: false,
    files: Object.keys(sums).sort().map(name => ({ name, sha256: sums[name], status: !old?.files[name] ? 'new' : old.files[name] === sums[name] ? 'same' : 'changed' })) };
  for (const name of Object.keys(old?.files ?? {}).sort()) if (!(name in sums)) result.files.push({ name, status: 'removed' });
  if (await exists(target)) {
    if (!(await io.lstat(target)).isDirectory()) throw new Error(`Invalid release directory: ${target}`);
    await verify(target, await readManifest(target));
    if (oldDir === target) { result.unchanged = true; return result; }
  }
  if (!options.apply) return result;
  await io.mkdir(base, { recursive: true, mode: 0o700 });
  await io.mkdir(releases, { recursive: true, mode: 0o700 });
  const temp = await io.mkdtemp(join(base, '.install-'));
  const link = `${temp}.link`;
  try {
    if (!await exists(target)) {
      for (const [name, data] of contents) {
        await io.writeFile(join(temp, name), data, { mode: 0o644 });
        await io.chmod(join(temp, name), 0o644);
      }
      const manifest: Manifest = { schemaVersion: 1, releaseId: id, time: (deps.now ?? (() => new Date()))().toISOString(), files: sums };
      await io.writeFile(join(temp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
      await io.chmod(join(temp, 'manifest.json'), 0o644);
      await verify(temp, manifest);
      await io.rename(temp, target);
    }
    await io.symlink(join('releases', id), link);
    await io.rename(link, current);
    result.applied = true;
    const candidates: { dir: string; time: number }[] = [];
    for (const entry of await io.readdir(releases, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = join(releases, entry.name);
      try { candidates.push({ dir, time: Date.parse((await readManifest(dir)).time) }); } catch { /* Unrecognized directories belong to the operator. */ }
    }
    candidates.sort((a, b) => b.time - a.time || a.dir.localeCompare(b.dir));
    for (const candidate of candidates.slice(3)) if (candidate.dir !== await io.realpath(current)) await io.rm(candidate.dir, { recursive: true });
    return result;
  } finally {
    await io.rm(link, { force: true });
    await io.rm(temp, { recursive: true, force: true });
  }
}
