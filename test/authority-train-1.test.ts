/**
 * AUTHORITY-TRAIN-1. The grant check is unchanged. These tests cover the
 * seven cases Security named: a root byte, a closure byte, a release-please
 * diff, a dependency bump, signer/daemon mismatch, a same-digest install,
 * and a manifest that drops a file.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordStandingTransitions, type StandingEvaluation } from '../src/core/authority/effective-config.js';
import { configuredGrantLifetimeMs, configuredLocalEnforcementMaxRisk } from '../src/core/authority/grant-bounds.js';
import { readLedger, resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { decideDeploy, recordDeployDeferral } from '../src/core/authority/deploy-gate.js';
import {
  judgeSignerDaemon,
  pathCopiesReady,
  rewriteDaemonPlistToCurrent,
  rewriteReleasePathToCurrent,
} from '../src/core/authority/signer-daemon.js';
import { verifyStandingGrant } from '../src/core/authority/standing-grant.js';
import {
  authoritySurfaceDigest,
  resetSurfaceCachesForTest,
  verifyAuthoritySurfaceAt,
  type AuthoritySurfaceManifestV1,
} from '../src/core/authority/surface.js';
import { STANDING_GRANT_CEILINGS } from '../src/core/authority/types.js';
import { AuthorityDraftError, buildStandingGrantDraft } from '../src/core/verse/authority-api.js';
import { killSwitchPath } from '../src/core/sandbox/policy.js';
import { makeGrant, signGrant, TEST_HOST, TEST_ROOT, withTempHome } from './helpers/authority-310b.js';

interface SurfaceScript {
  authoritySurfaceDigest(core: Omit<AuthoritySurfaceManifestV1, 'digest'>): string;
  computeAuthoritySurface(opts: { packageRoot: string; roots?: readonly string[]; ts?: typeof ts }): Promise<AuthoritySurfaceManifestV1>;
}

const script = (await import(pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'authority-surface.mjs')).href)) as SurfaceScript;

let root: string;
let home: { restore: () => void } | null = null;

function put(rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function manifest(roots: readonly string[]): Promise<AuthoritySurfaceManifestV1> {
  const built = await script.computeAuthoritySurface({ packageRoot: root, roots, ts });
  writeFileSync(join(root, 'dist', 'authority-surface.json'), `${JSON.stringify(built, null, 2)}\n`);
  return built;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'authority-train-')));
  resetSurfaceCachesForTest();
  resetLedgerCachesForTest();
  home = withTempHome('authority-train-home-');
  put('package.json', '{"name":"@ashlr/phantom","version":"9.9.9"}\n');
  put('node_modules/fakepkg/package.json', '{"name":"fakepkg","version":"1.2.3"}\n');
});

afterEach(() => {
  resetLedgerCachesForTest();
  resetSurfaceCachesForTest();
  home?.restore();
  home = null;
  rmSync(root, { recursive: true, force: true });
});

describe('AUTHORITY-TRAIN-1', () => {
  it('one byte in standing-grant.js trips, pauses, and queues', async () => {
    put('dist/core/authority/standing-grant.js', 'export const grant = 1;\n');
    const first = await manifest(['dist/core/authority/standing-grant.js']);
    put('dist/core/authority/standing-grant.js', 'export const grant = 2;\n');
    expect(verifyAuthoritySurfaceAt(root, 'running', { fresh: true })).toMatchObject({ ok: false, code: 'file-changed' });
    const second = await script.computeAuthoritySurface({ packageRoot: root, roots: ['dist/core/authority/standing-grant.js'], ts });
    expect(second.digest).not.toBe(first.digest);
    const verdict = verifyStandingGrant(signGrant(makeGrant({ authoritySurfaceDigest: first.digest })), {
      nowMs: Date.now(),
      hostBinding: TEST_HOST,
      surfaceDigest: second.digest,
      minGrantSeq: 0,
      revokedGrantIds: new Set(),
    }, [TEST_ROOT]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('surface-mismatch');
    recordStandingTransitions({
      grant: verdict.grant,
      pauseCode: 'authority-code-changed',
      grantReason: verdict.ok ? null : verdict.reason,
      ledger: { chain: 'ok', head: null, brokenAtSeq: null, reason: null },
    } as StandingEvaluation, 'daemon');
    expect((await readLedger({ kinds: ['grant:paused'] })).entries).toHaveLength(1);
    expect(decideDeploy({ candidateDigest: second.digest, grantDigest: first.digest, windowOpen: false })).toEqual({
      action: 'queue',
      code: 'authority-bump',
    });
  });

  it('one byte in a closure file still trips', async () => {
    put('dist/core/inbox/merge.js', "import '../comms/unified-inbox.js';\nexport const merge = 1;\n");
    put('dist/core/comms/unified-inbox.js', 'export const inbox = 1;\n');
    const first = await manifest(['dist/core/inbox/merge.js']);
    expect(first.files.map((file) => file.path)).toContain('dist/core/comms/unified-inbox.js');
    put('dist/core/comms/unified-inbox.js', 'export const inbox = 2;\n');
    const second = await script.computeAuthoritySurface({ packageRoot: root, roots: ['dist/core/inbox/merge.js'], ts });
    expect(second.digest).not.toBe(first.digest);
    const verdict = verifyStandingGrant(signGrant(makeGrant({ authoritySurfaceDigest: first.digest })), {
      nowMs: Date.now(),
      hostBinding: TEST_HOST,
      surfaceDigest: second.digest,
      minGrantSeq: 0,
      revokedGrantIds: new Set(),
    }, [TEST_ROOT]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('surface-mismatch');
    expect(decideDeploy({ candidateDigest: second.digest, grantDigest: first.digest, windowOpen: false }).action).toBe('queue');
  });

  it('a release-please-only diff keeps the digest', async () => {
    put('dist/core/authority/standing-grant.js', 'export const grant = 1;\n');
    const first = await manifest(['dist/core/authority/standing-grant.js']);
    put('package.json', '{"name":"@ashlr/phantom","version":"9.9.10"}\n');
    put('CHANGELOG.md', '# changelog\n');
    put('README.md', '# readme\n');
    put('server.json', '{}\n');
    put('docs/QUICKSTART.md', '# start\n');
    put('.release-please-manifest.json', '{}\n');
    const second = await script.computeAuthoritySurface({ packageRoot: root, roots: ['dist/core/authority/standing-grant.js'], ts });
    expect(second.digest).toBe(first.digest);
    expect(authoritySurfaceDigest(second)).toBe(script.authoritySurfaceDigest(second));
  });

  it('a closure dependency version bump trips', async () => {
    put('dist/core/authority/standing-grant.js', "import 'fakepkg';\nexport const grant = 1;\n");
    const first = await manifest(['dist/core/authority/standing-grant.js']);
    expect(verifyAuthoritySurfaceAt(root, 'running', { fresh: true }).ok).toBe(true);
    put('node_modules/fakepkg/package.json', '{"name":"fakepkg","version":"1.2.4"}\n');
    expect(verifyAuthoritySurfaceAt(root, 'running', { fresh: true })).toMatchObject({ ok: false, code: 'package-changed' });
    const second = await script.computeAuthoritySurface({ packageRoot: root, roots: ['dist/core/authority/standing-grant.js'], ts });
    expect(second.digest).not.toBe(first.digest);
  });

  it('signer-daemon-mismatch refuses the draft', async () => {
    const cli = 'a'.repeat(64);
    const daemon = 'b'.repeat(64);
    const judged = judgeSignerDaemon({ cliDigest: cli, daemonDigest: daemon, fallbackDigest: cli });
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.code).toBe('signer-daemon-mismatch');
    await expect(buildStandingGrantDraft('new', Date.now(), { signerDaemon: () => judged })).rejects.toMatchObject({
      code: 'signer-daemon-mismatch',
    });
    await expect(buildStandingGrantDraft('reapprove', Date.now(), { signerDaemon: () => judged })).rejects.toBeInstanceOf(AuthorityDraftError);
  });

  it('a same-digest candidate installs with no ledger pause and does not touch KILL', async () => {
    const digest = 'c'.repeat(64);
    mkdirSync(dirname(killSwitchPath()), { recursive: true });
    writeFileSync(killSwitchPath(), 'stop\n');
    const before = readFileSync(killSwitchPath());
    expect(decideDeploy({ candidateDigest: digest, grantDigest: digest, windowOpen: false })).toEqual({
      action: 'install',
      reapprove: false,
    });
    expect((await readLedger({ kinds: ['grant:paused'] })).entries).toHaveLength(0);
    expect(readFileSync(killSwitchPath()).equals(before)).toBe(true);
    const deferred = recordDeployDeferral({ grantId: null, candidateDigest: 'd'.repeat(64), grantDigest: digest });
    expect(deferred.ok).toBe(true);
    expect((await readLedger({ kinds: ['grant:paused'] })).entries).toHaveLength(0);
    expect((await readLedger({ kinds: ['note'] })).entries.some((entry) => entry.data.topic === 'authority-deploy-deferred')).toBe(true);
    expect(readFileSync(killSwitchPath()).equals(before)).toBe(true);
  });

  it('a manifest that drops a file fails manifest-digest-mismatch', async () => {
    put('dist/core/authority/standing-grant.js', 'export const grant = 1;\n');
    put('dist/core/authority/ledger.js', 'export const ledger = 1;\n');
    const built = await manifest(['dist/core/authority/']);
    const tampered = structuredClone(built);
    tampered.files = tampered.files.filter((file) => file.path !== 'dist/core/authority/ledger.js');
    writeFileSync(join(root, 'dist', 'authority-surface.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    expect(verifyAuthoritySurfaceAt(root, 'running', { fresh: true })).toMatchObject({
      ok: false,
      code: 'manifest-digest-mismatch',
    });
  });

  it('keeps the lifetime and local-enforcement risk as config under the compiled ceiling', () => {
    expect(configuredGrantLifetimeMs(null)).toBe(STANDING_GRANT_CEILINGS.maxTtlMs);
    expect(configuredGrantLifetimeMs({ authority: { grantLifetimeMs: STANDING_GRANT_CEILINGS.maxTtlMs - 1 } })).toBe(STANDING_GRANT_CEILINGS.maxTtlMs - 1);
    expect(configuredGrantLifetimeMs({ authority: { grantLifetimeMs: STANDING_GRANT_CEILINGS.maxTtlMs + 1 } })).toBe(STANDING_GRANT_CEILINGS.maxTtlMs);
    expect(configuredLocalEnforcementMaxRisk(null)).toBe(STANDING_GRANT_CEILINGS.localEnforcement.maxRisk);
    expect(configuredLocalEnforcementMaxRisk({ authority: { localEnforcementMaxRisk: 'medium' } })).toBe(STANDING_GRANT_CEILINGS.localEnforcement.maxRisk);
  });

  it('rewrites a hashed release plist onto current and reports split PATH copies', () => {
    const home = '/tmp/train-home';
    const release = `${home}/.local/share/ashlr/releases/abc123/bin/ashlr`;
    const current = `${home}/.local/share/ashlr/current/bin/ashlr`;
    expect(rewriteReleasePathToCurrent(release, home)).toBe(current);
    const plist = `<plist><key>ProgramArguments</key><array><string>${release}</string></array></plist>`;
    expect(rewriteDaemonPlistToCurrent(plist, home)).toContain(`<string>${current}</string>`);
    expect(pathCopiesReady([{ name: 'phm', target: current }, { name: 'ashlr', target: current }]).ready).toBe(true);
    expect(pathCopiesReady([{ name: 'phm', target: current }, { name: 'ashlr', target: release }]).ready).toBe(false);
  });
});
