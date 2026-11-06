import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { hasComputedImportCandidate } from './helpers/sidecar-ast-gate.js';

const root = resolve(__dirname, '..');
describe('generated fleet convention loaders', () => {
  it('is in sync with committed convention modules', () => {
    expect(generateFleetRegistry(['--check'])).toBe(0);
  });

  it('detects a newly added convention verb without rewriting the registry', () => {
    const temp = mkdtempSync(join(tmpdir(), 'fleet-registry-'));
    try {
      const cli = join(temp, 'cli');
      cpSync(join(root, 'src/cli'), cli, { recursive: true });
      writeFileSync(join(cli, 'fleet-zzz.ts'), 'export async function cmdFleetZzz() {}\n');
      expect(generateFleetRegistry(['--check', cli])).toBe(1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  // Cold imports include verification's full dependency graph; still load every module.
  it.each(Object.entries(FLEET_SUBCOMMAND_LOADERS))('%s exports its convention handler', { timeout: 120_000 }, async (verb, loader) => {
    const resolved = resolveFleetSubcommand(verb);
    expect(resolved).not.toBeNull();
    expect(typeof (await loader())[resolved!.exportName]).toBe('function');
  });
});

it.each([
  [String.raw`import('a\\' + ')')`, true],
  [String.raw`import('a\\')`, false],
  ['import(value)', true],
  ['import /* comment */ (value)', true],
  ['import("literal" + value)', true],
  ['import(("literal"))', true],
  ['import(`template`)', true],
  ['import("literal")', false],
  ["import('literal' /* comment */)", false],
  ['const value = 1;', false],
])('prefilters %s conservatively', (source, candidate) => {
  expect(hasComputedImportCandidate(source)).toBe(candidate);
});
