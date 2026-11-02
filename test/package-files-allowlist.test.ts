import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRuntimeReleaseRootPackagePortability,
  buildRuntimeReleaseDependencyInventory,
  type RuntimeReleaseDependencyInventoryV2,
  type RuntimeReleasePackFileRecord,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

// This check only consumes the inventory's portability contract. No build or
// package bytes are needed to validate the real manifest's files declaration.
const inventory: RuntimeReleaseDependencyInventoryV2 = {
  algorithm: 'sha256',
  assurance: 'packaged-build-byte-observation',
  inventoryDigest: '',
  package: { manifestSha256: '', name: '', version: '' },
  packages: [],
  portability: 'platform-independent-no-native-or-install-variance',
  rootDependencies: [],
  schemaVersion: 2,
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A package root needs only a manifest: the pack report is rejected in
// normalization before the lockfile is ever read.
function reportOutcome(packagedFiles: RuntimeReleasePackFileRecord[]) {
  const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-pack-report-')));
  tempDirs.push(packageRoot);
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({
    name: '@fixture/pack-report',
    version: '1.0.0',
    files: ['bin', 'dist', 'scripts/run-verify-command.mjs'],
    dependencies: {},
    bundledDependencies: [],
  })}\n`);
  return buildRuntimeReleaseDependencyInventory(packageRoot, { packagedFiles });
}

describe('package files allowlist', () => {
  it('accepts the real package.json files declaration without packaging', () => {
    expect(() => assertRuntimeReleaseRootPackagePortability(packageJson, [], inventory))
      .not.toThrow();
  });

  it.each(['docs/ECOSYSTEM-MAP.md', 'docs/QUARANTINE-LEDGER.md', 'docs/unreviewed.md'])(
    'rejects an unreviewed files entry: %s',
    (entry) => {
      const candidate = { ...packageJson, files: [...packageJson['files'] as string[], entry] };
      expect(() => assertRuntimeReleaseRootPackagePortability(candidate, [], inventory))
        .toThrow('release package files declaration is not portable');
    },
  );

  it.each([
    'docs\\FLEET-API.md',
    'docs\\contracts\\CONTRACT-M521.md',
    'C:\\docs\\FLEET-API.md',
    'C:/docs/FLEET-API.md',
    '/docs/FLEET-API.md',
    './docs/FLEET-API.md',
    'docs/../docs/FLEET-API.md',
    'docs//FLEET-API.md',
  ])('rejects a non-portable files entry: %s', (entry) => {
    const candidate = { ...packageJson, files: [...packageJson['files'] as string[], entry] };
    expect(() => assertRuntimeReleaseRootPackagePortability(candidate, [], inventory))
      .toThrow('release package files declaration is not portable');
  });

  it.each(['CHANGELOG.MD', 'BIN', 'Dist', 'docs/readme.md'])(
    'rejects a case-colliding files entry: %s',
    (entry) => {
      const candidate = { ...packageJson, files: [...packageJson['files'] as string[], entry] };
      expect(() => assertRuntimeReleaseRootPackagePortability(candidate, [], inventory))
        .toThrow('release package files declaration is not portable');
    },
  );

  it('admits the reviewed docs/FLEET-API.md entry', () => {
    const candidate = {
      ...packageJson,
      files: ['bin', 'dist', 'scripts/run-verify-command.mjs', 'docs/FLEET-API.md'],
    };
    expect(() => assertRuntimeReleaseRootPackagePortability(candidate, [], inventory))
      .not.toThrow();
  });

  it.each([
    'node_modules\\example\\index.js',
    'docs\\FLEET-API.md',
    'C:\\node_modules\\example\\index.js',
    'C:/node_modules/example/index.js',
    '/node_modules/example/index.js',
    'node_modules//example/index.js',
    'node_modules/example/../index.js',
    'node_modules/./example/index.js',
  ])('rejects the non-portable npm pack report path %s', (path) => {
    expect(reportOutcome([{ mode: 0o644, path, size: 1 }])).toEqual({
      ok: false,
      reason: 'npm pack file report is invalid',
    });
  });

  it('rejects npm pack report paths that collide case-insensitively', () => {
    expect(reportOutcome([
      { mode: 0o644, path: 'dist/cli/index.js', size: 1 },
      { mode: 0o644, path: 'dist/cli/INDEX.js', size: 1 },
    ])).toEqual({ ok: false, reason: 'npm pack file report is invalid' });
  });
});
