import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REAL_IO_TEST_FILES } from './config/realio-lane-membership.mjs';
import { KNOWN_FAST_SPAWN_FILES } from '../scripts/realio-lane-known-fast-spawns.mjs';
import { canonicalTestPath, realIoLaneInventory } from '../scripts/realio-lane-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realIo = REAL_IO_TEST_FILES.map(canonicalTestPath);
const fast = KNOWN_FAST_SPAWN_FILES.map(canonicalTestPath);

function discoverTests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discoverTests(path);
    return entry.isFile() && entry.name.endsWith('.test.ts')
      ? [canonicalTestPath(`test/${path.slice(join(root, 'test').length + 1)}`)]
      : [];
  });
}

describe('real-I/O lane guard', () => {
  it('lists existing, collected test files in both manifests', () => {
    const members = [...realIo, ...fast];
    expect(members.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
    expect(realIoLaneInventory(members, discoverTests(join(root, 'test'))).stale).toEqual([]);
  });

  it('keeps the real-I/O and fast manifests disjoint', () => {
    const fastSet = new Set(fast);
    expect(realIo.filter((path) => fastSet.has(path))).toEqual([]);
  });

  it('accepts the current marker classifications', () => {
    const output = execFileSync(process.execPath, ['scripts/check-realio-lane-membership.mjs'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(output).toContain('[check-realio-lane-membership] ok');
  });
});
