import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { list, extract } from 'tar';
import { credentialSpawnSync as spawnSync } from '../integrations/secrets.js';
import { probeNpmRegistry, registryBytes } from './registry.js';

export interface ReleaseUpdateResult {
  from: string | null; to: string | null; verified: boolean; rolled_back: boolean;
  log_line: string; attestation: 'unknown' | 'verified'; updated: boolean; error: string | null;
}
const basePath = (home: string) => join(home, '.local/share/ashlr');
const readPointer = (path: string): string | null => fs.lstatSync(path, { throwIfNoEntry: false }) ? fs.readlinkSync(path) : null;

/** Only the exact per-user release layout qualifies, never a checkout or dependency. */
export function detectReleaseDirectory(root: string, home = homedir()): boolean {
  const leaf = relative(join(basePath(home), 'releases'), resolve(root));
  return !!leaf && leaf !== '..' && !leaf.includes(sep) && !fs.existsSync(join(root, '.git'));
}

type Run = (command: string, args: string[]) => { status: number | null; stdout?: string | null; error?: NodeJS.ErrnoException };
interface Options {
  home?: string; check?: boolean; run?: Run;
  services?: () => string[];
}
function atomicLink(path: string, target: string): void {
  const temporary = `${path}.update-${process.pid}`;
  try { fs.symlinkSync(target, temporary); fs.renameSync(temporary, path); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export async function updateReleaseDirectory(root: string, options: Options = {}): Promise<ReleaseUpdateResult> {
  const home = options.home ?? homedir(), base = basePath(home), current = join(base, 'current');
  const result: ReleaseUpdateResult = { from: null, to: null, verified: false, rolled_back: false,
    log_line: '', attestation: 'unknown', updated: false, error: null };
  const run: Run = options.run ?? ((command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const checkedRun = (command: string, args: string[]) => {
    const output = run(command, args);
    if (output.status !== 0 || output.error) throw new Error(`${command === 'launchctl' ? 'Service' : 'Release'} ${args[0]} failed`);
    return output;
  };
  const changed: Array<[string, string | null]> = [], paused: string[] = [];
  let stage: string | undefined, candidate: string | undefined, locked = false;
  const lock = join(base, '.update-lock');
  const log = () => {
    result.log_line = `Phantom ${result.from ?? 'unknown'} to ${result.to ?? 'unknown'}: ${result.error ?? (result.updated ? 'updated' : 'up to date')}; integrity: ${result.verified ? 'verified' : 'unknown'}; attestation: ${result.attestation}; rolled back: ${result.rolled_back}`;
    fs.mkdirSync(join(home, '.ashlr-runs'), { recursive: true, mode: 0o700 });
    fs.appendFileSync(join(home, '.ashlr-runs/installs.log'), result.log_line + '\n', { mode: 0o600 });
  };
  try {
    if (!detectReleaseDirectory(root, home) || fs.realpathSync(root) !== resolve(root)) throw new Error('Unsupported release directory');
    const local = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    if (local.name !== '@ashlr/phantom' || !/^\d+\.\d+\.\d+$/.test(local.version)) throw new Error('Unsupported package identity');
    result.from = local.version;
    const probe = await probeNpmRegistry('@ashlr/phantom');
    if (!probe.reachable) throw new Error('Registry unreachable');
    const latest = probe.metadata as { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } } | null;
    if (!latest || latest.name !== local.name || typeof latest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest.version)) throw new Error('Registry metadata unavailable');
    result.to = latest.version;
    if (options.check) return result;
    fs.mkdirSync(lock, { mode: 0o700 }); locked = true;
    if (result.from === result.to) { log(); return result; }
    const previous = readPointer(current);
    if (previous !== null && fs.realpathSync(current) !== root) throw new Error('Current release changed');
    const aliases: Array<[string, string]> = [];
    for (const name of ['phm', 'ashlr']) {
      const path = join(home, '.local/bin', name);
      if (!fs.existsSync(path) && name === 'ashlr') continue;
      const target = fs.realpathSync(path);
      if (!fs.lstatSync(path).isSymbolicLink() || ![join(root, 'phm'), join(root, 'bin/ashlr')].includes(target)) throw new Error('CLI link is not owned by this release');
      aliases.push([path, fs.readlinkSync(path)]);
    }
    const integrity = latest.dist?.integrity, url = latest.dist?.tarball;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
        url !== `https://registry.npmjs.org/@ashlr/phantom/-/phantom-${result.to}.tgz`) throw new Error('Release integrity metadata unavailable');
    const bytes = await registryBytes(url, 256 * 1024 * 1024);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) throw new Error('Release integrity verification failed');
    stage = fs.mkdtempSync(join(base, '.update-'));
    const archive = join(stage, 'package.tgz'); fs.writeFileSync(archive, bytes, { mode: 0o600 });
    const gh = run('gh', ['--version']);
    if (gh.error?.code !== 'ENOENT') {
      if (gh.status !== 0 || gh.error) throw new Error('GitHub verifier unavailable');
      checkedRun('gh', ['attestation', 'verify', archive, '--repo', 'ashlrai/phantom', '--hostname', 'github.com']);
      result.attestation = 'verified';
    }
    result.verified = true;
    let safe = true;
    list({ file: archive, sync: true, strict: true, onReadEntry: entry => {
      if (!entry.path.startsWith('package/') || entry.path.includes('\\') || entry.path.split('/').includes('..') ||
          !['File', 'Directory'].includes(entry.type)) safe = false;
    } });
    if (!safe) throw new Error('Release archive contains unsafe entries');
    const unpacked = join(stage, 'unpacked'); fs.mkdirSync(unpacked);
    extract({ file: archive, cwd: unpacked, strip: 1, sync: true, strict: true });
    const pkg = JSON.parse(fs.readFileSync(join(unpacked, 'package.json'), 'utf8'));
    if (pkg.name !== local.name || pkg.version !== result.to) throw new Error('Release package identity mismatch');
    fs.chmodSync(join(unpacked, 'bin/ashlr'), 0o755);
    fs.symlinkSync('bin/ashlr', join(unpacked, 'phm'));
    const destination = join(base, 'releases', createHash('sha256').update(bytes).digest('hex'));
    // Existing releases are immutable. Never trust or overwrite a prior directory.
    if (fs.existsSync(destination)) throw new Error('Candidate release directory already exists');
    fs.renameSync(unpacked, destination);
    candidate = destination;
    const smoke = checkedRun(join(destination, 'phm'), ['--version']);
    if (smoke.stdout?.trim() !== result.to) throw new Error('Release smoke version mismatch');
    for (const target of options.services?.() ?? []) {
      paused.push(target);
      // SIGSTOP keeps launchd registration intact and prevents KeepAlive relaunch.
      checkedRun('launchctl', ['kill', 'SIGSTOP', target]);
    }
    if (readPointer(current) !== previous) throw new Error('Current release changed');
    atomicLink(current, destination); changed.push([current, previous]);
    for (const [path, before] of aliases) {
      if (fs.readlinkSync(path) !== before) throw new Error('CLI link changed');
      atomicLink(path, join(current, 'phm')); changed.push([path, before]);
    }
    for (const target of paused) checkedRun('launchctl', ['kickstart', '-k', target]);
    result.updated = true; log();
  } catch (error) {
    result.error = error instanceof Error && /^(Unsupported|Registry|Release|GitHub|Current|CLI|Candidate|Service) /.test(error.message)
      ? error.message : 'Release update failed';
    result.updated = false;
    try {
      for (const [path, before] of changed.reverse()) {
        if (before === null) fs.unlinkSync(path); else atomicLink(path, before);
      }
      result.rolled_back = changed.length > 0;
      if (candidate) fs.rmSync(candidate, { recursive: true, force: true });
    } catch { result.error = 'Release rollback failed'; }
    for (const target of paused) {
      try { checkedRun('launchctl', ['kickstart', '-k', target]); }
      catch { result.error = 'Service recovery failed'; }
    }
    if (!options.check) { try { log(); } catch { result.error = 'Release install log unavailable'; } }
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (locked) fs.rmdirSync(lock);
  }
  return result;
}
