import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { verifyAuthoritySurfaceAt } from '../authority/surface.js';
import { parseBuildIdentity } from '../build-identity.js';
import { parents, regular } from './consumer-install.js';

type ManagedRuntime =
  | { state: 'absent' }
  | { state: 'held'; reason: 'managed-resident-runtime-unverified'; remedy: string }
  | { state: 'verified'; root: string; launcher: string; version: string };

const inspectCommand = 'phm desktop install --upgrade --require-app';

export function inspectManagedResidentRuntime(home = userInfo().homedir): ManagedRuntime {
  const parent = join(home, '.local/share/ashlr');
  const pointer = join(parent, 'current');
  try {
    const before = lstatSync(pointer, { throwIfNoEntry: false });
    if (!before) return { state: 'absent' };
    const root = readlinkSync(pointer), revision = basename(root);
    if (!before.isSymbolicLink() || before.uid !== process.getuid?.() ||
      dirname(root) !== join(parent, 'releases') || !/^[a-f0-9]{40}$/.test(revision)) throw new Error();
    parents(home, join(root, 'bin'), false);
    const launcher = join(root, 'bin/ashlr'), executable = regular(launcher, 65536).identity;
    if (executable.uid !== before.uid || !(executable.mode & 0o100)) throw new Error();
    const identity = parseBuildIdentity(regular(join(root, 'dist/build-identity.json'), 65536).data.toString('utf8'));
    const pkg = JSON.parse(regular(join(root, 'package.json'), 1024 * 1024).data.toString('utf8')) as {
      name?: unknown; version?: unknown; bin?: { ashlr?: unknown };
    };
    if (pkg.name !== '@ashlr/phantom' || pkg.bin?.ashlr !== 'bin/ashlr' || !identity?.packageVersion ||
      identity.packageVersion !== pkg.version || identity.provenance !== 'git' || identity.dirty || identity.revision !== revision ||
      !verifyAuthoritySurfaceAt(root, 'installed', { fresh: true }).ok) throw new Error();
    const after = lstatSync(pointer);
    if (before.dev !== after.dev || before.ino !== after.ino || readlinkSync(pointer) !== root) throw new Error();
    return { state: 'verified', root, launcher, version: identity.packageVersion };
  } catch {
    return { state: 'held', reason: 'managed-resident-runtime-unverified', remedy: inspectCommand };
  }
}

export function observeHomebrewDesktopCopies(version: string, prefixes = ['/opt/homebrew', '/usr/local']) {
  return prefixes.flatMap(prefix => {
    const path = join(prefix, 'lib/node_modules/@ashlr/phantom');
    try {
      const pkg = JSON.parse(regular(join(realpathSync(path), 'package.json'), 1024 * 1024).data.toString('utf8')) as {
        name?: unknown; version?: unknown;
      };
      if (pkg.name !== '@ashlr/phantom' || typeof pkg.version !== 'string' || !/^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(pkg.version)) return [];
      return [{ path, version: pkg.version, reason: pkg.version === version ? 'alternate-cli-present' : 'alternate-cli-version-mismatch',
        remedy: 'Use ~/.local/bin/phm for the managed release; update alternate copies with their original package manager.' }];
    } catch { return []; }
  });
}
