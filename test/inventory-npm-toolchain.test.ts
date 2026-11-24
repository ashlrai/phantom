import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findToolchainNpmCli } from '../scripts/build-release-dependency-inventory.mjs';

vi.mock('../dist/core/daemon/runtime-release-dependency-inventory.js', async () =>
  import('../src/core/daemon/runtime-release-dependency-inventory.js'));
vi.mock('../dist/core/util/private-storage.js', async () =>
  import('../src/core/util/private-storage.js'));

const roots: string[] = [];
function fakeNode(withNpm: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'npm-toolchain-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'), { recursive: true });
  const node = join(root, 'bin', 'node');
  writeFileSync(node, 'plain node file');
  if (withNpm) {
    const bin = join(root, 'lib', 'node_modules', 'npm', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npm-cli.js'), '// plain npm file');
  }
  return node;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('findToolchainNpmCli', () => {
  it('uses the npm that sits beside this node', () => {
    const node = fakeNode(true);
    expect(findToolchainNpmCli(node, 'linux')).toMatch(/lib\/node_modules\/npm\/bin\/npm-cli\.js$/);
  });

  it('returns null when the node has no npm beside it', () => {
    expect(findToolchainNpmCli(fakeNode(false), 'linux')).toBeNull();
  });

  it('returns null when the node itself is gone', () => {
    expect(findToolchainNpmCli(join(tmpdir(), 'no-such-node-dir', 'bin', 'node'), 'linux')).toBeNull();
  });
});
