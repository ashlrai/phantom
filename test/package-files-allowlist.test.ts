import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertRuntimeReleaseRootPackagePortability,
  type RuntimeReleaseDependencyInventoryV2,
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

describe('package files allowlist', () => {
  it('accepts the real package.json files declaration without packaging', () => {
    expect(() => assertRuntimeReleaseRootPackagePortability(packageJson, [], inventory))
      .not.toThrow();
  });

  it.each(['docs/FLEET-API.md', 'docs/QUARANTINE-LEDGER.md', 'docs/unreviewed.md'])(
    'rejects an unreviewed files entry: %s',
    (entry) => {
      const candidate = { ...packageJson, files: [...packageJson['files'] as string[], entry] };
      expect(() => assertRuntimeReleaseRootPackagePortability(candidate, [], inventory))
        .toThrow('release package files declaration is not portable');
    },
  );
});
