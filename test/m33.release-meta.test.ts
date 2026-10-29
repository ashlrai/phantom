/**
 * M33 — distribution metadata: package.json publish shape, the exports map,
 * the release scripts (check-version / extract-changelog), and the release
 * workflow's gates. Pure filesystem reads + child-process runs of the
 * scripts; no network, no HOME mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readBoundedJson,
  verifyNpmReleaseProvenance,
} from '../scripts/verify-npm-release-provenance.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  expect.hasAssertions();
});

describe('package.json publish shape', () => {
  it('publishes both workbench aliases through the same canonical launcher', () => {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    expect(pkg['bin']).toEqual({ ashlr: 'bin/ashlr', phm: 'bin/ashlr' });
    expect(lock.packages[''].bin).toEqual(pkg['bin']);
    expect(lock.name).toBe(pkg['name']);
    expect(lock.version).toBe(pkg['version']);
    expect(lock.packages[''].name).toBe(pkg['name']);
    expect(lock.packages[''].version).toBe(pkg['version']);
    expect((pkg['bin'] as Record<string, string>)['phantom']).toBeUndefined();
  });

  it('is the public scoped package; provenance is never baked into publishConfig', () => {
    expect(pkg['name']).toBe('@ashlr/phantom');
    expect(pkg['homepage']).toBe('https://phm.dev');
    expect(pkg['repository']).toEqual({ type: 'git', url: 'git+https://github.com/ashlrai/phantom.git' });
    expect(pkg['bugs']).toEqual({ url: 'https://github.com/ashlrai/phantom/issues' });
    expect(pkg['private']).toBeUndefined();
    // e24a7dae removed `publishConfig.provenance: true` on purpose.
    // npm can only mint provenance from a supported CI provider. The baked-in
    // flag made EVERY local publish die with "Automatic provenance generation
    // not supported for provider: null". Exact shape, not just "no
    // provenance key": a re-added flag (or any other publish-time switch)
    // should be a deliberate edit to this test, not a silent regression.
    expect(pkg['publishConfig']).toEqual({ access: 'public' });
    // Supported CI publishers request provenance per invocation. The manual
    // lane is historical: its separately signed qualified handoff did not
    // establish npm provenance, and current commissioning cannot rewrite it.
    const releasingLocally = readFileSync(join(REPO_ROOT, 'docs', 'RELEASING-LOCALLY.md'), 'utf8');
    expect(releasingLocally).toContain('publishConfig.provenance: true');
    expect(releasingLocally).toContain('Automatic provenance generation not supported for provider: null');
    const historical = (releasingLocally.split('## Historical manual publishing and provenance\n')[1]?.split('\n## ')[0] ?? '').replace(/\s+/g, ' ');
    expect(historical).toMatch(/manual lane[^.]*did not carry npm's CI provenance attestation/iu);
    expect(historical).toMatch(/qualified CI handoff separately signed and verified[^.]*original archive before local adoption/iu);
    expect(historical).toMatch(/current \[trusted publisher\][^.]*generates and verifies npm provenance/iu);
    expect(historical).toMatch(/earlier manual release does not gain provenance retroactively/iu);
  });

  it('gates publish behind the full verification suite', () => {
    const scripts = pkg['scripts'] as Record<string, string>;
    expect(scripts['prepublishOnly']).toContain('typecheck');
    expect(scripts['prepublishOnly']).toContain('test');
    expect(scripts['prepare']).toBeUndefined();
    expect(scripts['prepack']).toContain('build');
  });

  it('exports map covers ., ./core, ./types, ./plugin with types conditions', () => {
    const exports = pkg['exports'] as Record<string, Record<string, string> | string>;
    for (const entry of ['.', './core', './types', './plugin']) {
      const e = exports[entry];
      expect(e, `missing exports["${entry}"]`).toBeTruthy();
      expect((e as Record<string, string>)['types']).toMatch(/^\.\/dist\/api\/.+\.d\.ts$/);
      expect((e as Record<string, string>)['import']).toMatch(/^\.\/dist\/api\/.+\.js$/);
    }
    expect(exports['./package.json']).toBe('./package.json');
  });

  it('the api source files behind the exports map exist', () => {
    for (const f of ['index.ts', 'core.ts', 'types.ts', 'plugin.ts']) {
      expect(existsSync(join(REPO_ROOT, 'src', 'api', f)), `src/api/${f} missing`).toBe(true);
    }
  });
});

describe('release scripts', () => {
  it('check-version passes on a matching tag and fails on a mismatch', () => {
    const version = pkg['version'] as string;
    const ok = execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), `v${version}`], {
      encoding: 'utf8',
    });
    expect(ok).toContain('ok');

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/check-version.mjs'), 'v0.0.1-nope'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('extract-changelog prints the current version section and fails on unknown versions', () => {
    const version = pkg['version'] as string;
    const body = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
      encoding: 'utf8',
    });
    expect(body.trim().length).toBeGreaterThan(50);
    const implicitBody = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs')], {
      encoding: 'utf8',
    });
    expect(implicitBody).toBe(body);

    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), '0.0.1'], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it.each([
    '3.2.0.*',
    '3.2.0[abc]',
    '3.2.0\\',
    '3.2.0/../3.1.0',
    '3.2.0\n## [3.1.0]',
    '03.2.0',
    '3.02.0',
    '3.2.00',
    'v3.2.0',
    '3.2',
    '3.2.0-beta.1',
    '3.2.0+build',
    '1'.repeat(65),
    '',
  ])('extract-changelog rejects noncanonical argv %j without regex interpretation', (version) => {
    expect(() =>
      execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
        encoding: 'utf8', stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('extract-changelog never compiles release argv as a regular expression', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/extract-changelog.mjs'), 'utf8');
    expect(source).not.toContain('new RegExp');
    expect(source).toContain('canonicalVersionRe');
    expect(source).toContain('line.startsWith(`${heading} — `)');
  });
});

describe('exact npm release provenance', () => {
  const digest = 'ab'.repeat(64);
  const integrity = `sha512-${Buffer.from(digest, 'hex').toString('base64')}`;
  const release = {
    packageName: '@ashlr/hub',
    version: '3.2.0',
    integrity,
    repository: 'https://github.com/ashlrai/ashlr-hub',
    workflowPath: '.github/workflows/release.yml',
    ref: 'refs/tags/v3.2.0',
    revision: '1'.repeat(40),
    runId: '31870000000',
    runAttempt: '1',
  };

  function audit(
    overrides: Record<string, unknown> = {},
    identityOverrides: Partial<typeof release> = {},
  ) {
    const identity = { ...release, ...identityOverrides };
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: 'pkg:npm/%40ashlr/hub@3.2.0', digest: { sha512: digest } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: { workflow: {
            ref: identity.ref, repository: identity.repository, path: identity.workflowPath,
          } },
          internalParameters: { github: { event_name: 'push' } },
          resolvedDependencies: [{
            uri: `git+${identity.repository}@${identity.ref}`,
            digest: { gitCommit: identity.revision },
          }],
        },
        runDetails: {
          builder: { id: 'https://github.com/actions/runner/github-hosted' },
          metadata: {
            invocationId:
              `${identity.repository}/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
          },
        },
      },
      ...overrides,
    };
    return {
      invalid: [],
      missing: [],
      verified: [{
        name: release.packageName,
        version: release.version,
        location: `node_modules/${release.packageName}`,
        attestationBundles: [{
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: { dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          } },
        }],
      }],
    };
  }

  it('accepts the exact package, workflow, tag, revision, builder, and run', () => {
    expect(verifyNpmReleaseProvenance({ audit: audit(), ...release })).toBe(true);
  });

  it('requires the explicitly bound dispatch event for canonical publishing', () => {
    const observed = audit();
    const envelope = observed.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope;
    const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString());
    statement.predicate.buildDefinition.internalParameters.github.event_name = 'workflow_dispatch';
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    expect(() => verifyNpmReleaseProvenance({audit: observed, ...release})).toThrow();
    expect(verifyNpmReleaseProvenance({audit: observed, ...release, eventName: 'workflow_dispatch'})).toBe(true);
    expect(() => verifyNpmReleaseProvenance({audit: observed, ...release, eventName: 'pull_request'})).toThrow();
  });

  it.each([
    ['wrong subject digest', { subject: [{
      name: 'pkg:npm/%40ashlr/hub@3.2.0', digest: { sha512: 'cd'.repeat(64) },
    }] }],
    ['wrong statement type', { _type: 'https://in-toto.io/Statement/v0.1' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => verifyNpmReleaseProvenance({ audit: audit(overrides), ...release })).toThrow();
  });

  it.each([
    ['repository', { repository: 'https://github.com/attacker/fork' }],
    ['workflow path', { workflowPath: '.github/workflows/other.yml' }],
    ['tag ref', { ref: 'refs/tags/v3.2.0-forged' }],
    ['Git revision', { revision: '2'.repeat(40) }],
    ['workflow run', { runId: '31870000001' }],
    ['workflow run attempt', { runAttempt: '2' }],
  ])('rejects a coherently wrong %s identity', (_label, identityOverrides) => {
    expect(() => verifyNpmReleaseProvenance({
      audit: audit({}, identityOverrides),
      ...release,
    })).toThrow();
  });

  it('reads only a stable descriptor-bound audit snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-read-'));
    try {
      const auditPath = join(root, 'audit.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      expect(readBoundedJson(auditPath)).toEqual({ verified: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic and hard-linked audit inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-links-'));
    try {
      const source = join(root, 'source.json');
      const symbolic = join(root, 'symbolic.json');
      const hard = join(root, 'hard.json');
      writeFileSync(source, '{"verified":[]}\n');
      symlinkSync(source, symbolic);
      linkSync(source, hard);

      expect(() => readBoundedJson(symbolic)).toThrow();
      expect(() => readBoundedJson(hard)).toThrow(/single-link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a path swap after opening the audit descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-swap-'));
    try {
      const auditPath = join(root, 'audit.json');
      const replacement = join(root, 'replacement.json');
      const displaced = join(root, 'displaced.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      writeFileSync(replacement, '{"invalid":[]}\n');
      let swapped = false;
      const fs = {
        ...nodeFs,
        readSync(...args: Parameters<typeof nodeFs.readSync>) {
          if (!swapped) {
            swapped = true;
            renameSync(auditPath, displaced);
            renameSync(replacement, auditPath);
          }
          return nodeFs.readSync(...args);
        },
      };

      expect(() => readBoundedJson(auditPath, fs)).toThrow(/changed during read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects audit growth while reading', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-audit-growth-'));
    try {
      const auditPath = join(root, 'audit.json');
      writeFileSync(auditPath, '{"verified":[]}\n');
      let grown = false;
      const fs = {
        ...nodeFs,
        readSync(...args: Parameters<typeof nodeFs.readSync>) {
          if (!grown) {
            grown = true;
            appendFileSync(auditPath, '{}');
          }
          return nodeFs.readSync(...args);
        },
      };

      expect(() => readBoundedJson(auditPath, fs)).toThrow(/grew during read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
