import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectManagedResidentRuntime, observeHomebrewDesktopCopies } from '../src/core/desktop/managed-resident-runtime.js';

vi.mock('../src/core/authority/surface.js', () => ({ verifyAuthoritySurfaceAt: () => ({ ok: true, digest: 'test' }) }));
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function write(file: string, value: string, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, value, { mode });
}

it('selects the managed release instead of an older global package and reports the alternate', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'managed-resident-'))); homes.push(home);
  const parent = join(home, '.local/share/ashlr'), revision = 'a'.repeat(40);
  const root = join(parent, 'releases', revision), launcher = join(root, 'bin/ashlr'), pointer = join(parent, 'current');
  expect(inspectManagedResidentRuntime(home)).toEqual({ state: 'absent' });
  write(launcher, '#!/usr/bin/env node\n', 0o700);
  write(join(root, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.30.76', bin: { ashlr: 'bin/ashlr' } }));
  write(join(root, 'dist/build-identity.json'), JSON.stringify({
    schemaVersion: 1, packageVersion: '3.30.76', revision, dirty: false, provenance: 'git',
  }));
  symlinkSync(root, pointer);
  const prefix = join(home, 'brew'), alternate = join(prefix, 'lib/node_modules/@ashlr/phantom');
  write(join(alternate, 'package.json'), JSON.stringify({ name: '@ashlr/phantom', version: '3.30.41' }));
  expect(inspectManagedResidentRuntime(home)).toEqual({ state: 'verified', root, launcher, version: '3.30.76' });
  expect(observeHomebrewDesktopCopies('3.30.76', [prefix])).toMatchObject([
    { path: alternate, version: '3.30.41', reason: 'alternate-cli-version-mismatch' },
  ]);
  rmSync(pointer);
  symlinkSync(alternate, pointer);
  expect(inspectManagedResidentRuntime(home)).toMatchObject({ state: 'held', reason: 'managed-resident-runtime-unverified' });
});
