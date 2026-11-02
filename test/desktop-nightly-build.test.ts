/**
 * desktop-nightly-build — contract for the reproducible unsigned desktop dev
 * build that runs in the scheduled master CI run (RQ-DESKTOP-BUILD-NIGHTLY).
 *
 * Hermetic: every spawn uses a stubbed PATH toolchain or explicit
 * TAURI_ENV_PLATFORM, so no real compile, network or ~/.ashlr access happens.
 * The paste-ready workflow job documented in desktop/README.md is validated as
 * data here so the pending .github change stays a mechanical copy.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  SIGNING_ENV_KEYS,
  buildStepPlan,
  createManifest,
  extractVersion,
  loadToolchainPins,
  nightlyArtifactName,
  packageArtifact,
  resolveDesktopNightlyTarget,
  scrubSigningEnv,
} from '../scripts/build-desktop-nightly.mjs';
import { DESKTOP_RELEASE_TOOL_PINS } from '../scripts/desktop-release-policy.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'build-desktop-nightly.mjs');
const scriptText = readFileSync(SCRIPT, 'utf8');
const releaseWorkflow = readFileSync(join(REPO_ROOT, '.github/workflows/release-desktop.yml'), 'utf8');
const desktopReadme = readFileSync(join(REPO_ROOT, 'desktop/README.md'), 'utf8');
const desktopPointer = readFileSync(join(REPO_ROOT, 'DESKTOP.md'), 'utf8');
const desktopGitignore = readFileSync(join(REPO_ROOT, 'desktop/.gitignore'), 'utf8');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  version: string;
};
const tauriVersion = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
    version: string;
  }
).version;
const pins = loadToolchainPins();

/** Stub tools that report the pinned versions, including `rustc -vV`. */
function stubToolchainBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-nightly-tools-'));
  const stubs: Record<string, string> = {
    node: `#!/bin/sh\necho "v${pins.node}"\n`,
    npm: `#!/bin/sh\necho "${pins.npm}"\n`,
    bun: `#!/bin/sh\necho "${pins.bun}"\n`,
    cargo: `#!/bin/sh\necho "cargo ${pins.rust} (stub 2026-01-01)"\n`,
    tauri: `#!/bin/sh\necho "tauri-cli ${pins.tauriCli}"\n`,
    rustc: `#!/bin/sh
if [ "$1" = "-vV" ]; then
  echo "rustc ${pins.rust} (stub 2026-01-01)"
  echo "host: aarch64-apple-darwin"
else
  echo "rustc ${pins.rust} (stub 2026-01-01)"
fi
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return dir;
}

function runCheck(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
    encoding: 'utf8',
    env: { HOME: tmpdir(), ...env },
    timeout: 30_000,
  });
  let report: Record<string, unknown> | null = null;
  try {
    report = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch { /* surfaced via assertions on status/stdout */ }
  return { ...result, report };
}

const stubBin = stubToolchainBin();
const PinnedEnv = { PATH: stubBin, TAURI_ENV_PLATFORM: 'darwin' } as const;

describe('desktop nightly admission gate', () => {
  it('admits only the macOS target and keeps the Linux quarantine', () => {
    expect(resolveDesktopNightlyTarget({}, 'darwin')).toEqual({
      raw: 'darwin', os: 'macos', admitted: true, reason: null,
    });
    expect(resolveDesktopNightlyTarget({}, 'linux')).toMatchObject({
      admitted: false, reason: 'linux-quarantined',
    });
    // TAURI_ENV_PLATFORM is Tauri's own cross-build signal and wins over host.
    expect(resolveDesktopNightlyTarget({ TAURI_ENV_PLATFORM: 'linux' }, 'darwin')).toMatchObject({
      admitted: false, reason: 'linux-quarantined',
    });
    expect(resolveDesktopNightlyTarget({ TAURI_ENV_PLATFORM: 'darwin' }, 'linux')).toMatchObject({
      admitted: true, os: 'macos',
    });
    for (const platform of ['win32', 'freebsd', 'windows']) {
      expect(resolveDesktopNightlyTarget({ TAURI_ENV_PLATFORM: platform }, 'darwin')).toMatchObject({
        admitted: false, reason: 'unsupported-target',
      });
    }
    expect(resolveDesktopNightlyTarget({}, 'win32')).toMatchObject({
      admitted: false, reason: 'unsupported-target',
    });
  });

  it('--check emits a passing plan against the pinned stubbed toolchain', () => {
    const run = runCheck(PinnedEnv);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.report).toMatchObject({
      schemaVersion: 1,
      mode: 'check',
      ok: true,
      host: expect.any(String),
      missingFiles: [],
    });
    expect(run.report?.['target']).toEqual({
      raw: 'darwin', os: 'macos', admitted: true, reason: null,
    });
    const toolchain = run.report?.['toolchain'] as { tool: string; ok: boolean }[];
    expect(toolchain.map((row) => row.tool)).toEqual([
      'node', 'npm', 'bun', 'rustc', 'cargo', 'tauri',
    ]);
    expect(toolchain.every((row) => row.ok)).toBe(true);
    const plan = run.report?.['plan'] as Record<string, unknown>;
    expect(plan['triple']).toBe('aarch64-apple-darwin');
    expect(plan['artifactName']).toBe(
      `Phantom_${tauriVersion}_aarch64-nightly-debug.app.tar.gz`,
    );
    expect((plan['steps'] as { name: string }[]).map((step) => step.name)).toEqual([
      'install', 'sidecar-build', 'sidecar-smoke', 'sidecar-stage', 'icons', 'bundle', 'package',
    ]);
  });

  it('--check refuses a drifted toolchain before any build step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-nightly-drift-'));
    for (const name of ['node', 'npm', 'bun', 'cargo', 'tauri']) {
      writeFileSync(join(dir, name), `#!/bin/sh\necho "0.0.0"\n`);
      chmodSync(join(dir, name), 0o755);
    }
    writeFileSync(join(dir, 'rustc'), '#!/bin/sh\necho "rustc 0.0.0 (stub)"\n');
    chmodSync(join(dir, 'rustc'), 0o755);
    const run = runCheck({ PATH: dir, TAURI_ENV_PLATFORM: 'darwin' });
    expect(run.status).toBe(1);
    expect(run.report?.['ok']).toBe(false);
    expect(run.stderr).toContain('ASHLR_DESKTOP_NIGHTLY_PREFLIGHT_FAILED');
    expect(run.stderr).toContain('rustc');
  });

  it('--check refuses Linux with the quarantine marker and Windows as unadmitted', () => {
    const linux = runCheck({ PATH: stubBin, TAURI_ENV_PLATFORM: 'linux' });
    expect(linux.status).toBe(1);
    expect(linux.report?.['ok']).toBe(false);
    expect(linux.stderr).toContain('ASHLR_DESKTOP_NIGHTLY_ADMISSION_REFUSED');
    expect(linux.stderr).toContain('GHSA-wrw7-89jp-8q8g');
    expect(linux.stderr).toContain('RUSTSEC-2024-0429');

    const windows = runCheck({ PATH: stubBin, TAURI_ENV_PLATFORM: 'windows' });
    expect(windows.status).toBe(1);
    expect(windows.report?.['ok']).toBe(false);
    expect(windows.stderr).toContain('ASHLR_DESKTOP_NIGHTLY_ADMISSION_REFUSED');
    expect(windows.stderr).toContain('macOS-only');
  });

  it('--check fails closed when the toolchain is absent from PATH', () => {
    const run = runCheck({ PATH: '/nonexistent-nightly-path', TAURI_ENV_PLATFORM: 'darwin' });
    expect(run.status).toBe(1);
    expect(run.report?.['ok']).toBe(false);
    const toolchain = (run.report?.['toolchain'] ?? []) as { ok: boolean }[];
    expect(toolchain.length).toBe(6);
    expect(toolchain.every((row) => !row.ok)).toBe(true);
  });
});

describe('desktop nightly pipeline shape', () => {
  it('reproduces the release pipeline minus release authority', () => {
    const steps = buildStepPlan();
    expect(steps.map((step) => step.name)).toEqual([
      'install', 'sidecar-build', 'sidecar-smoke', 'sidecar-stage', 'icons', 'bundle', 'package',
    ]);
    const [install, seaBuild, , stage, icons, bundle] = steps;
    expect(install?.command).toEqual(['npm', ['ci']]);
    expect(seaBuild?.command?.[1]).toEqual(['scripts/build-sea.mjs']);
    expect(stage?.command?.[1]).toEqual(['desktop/scripts/prepare-sidecar.mjs']);
    expect(icons?.command).toEqual(['tauri', ['icon', 'src-tauri/icons/icon.svg']]);
    // Unsigned debug dev build: --no-sign is unconditional, --bundles app keeps
    // the job off the DMG/Finder path, --locked pins Cargo resolution.
    expect(bundle?.command).toEqual([
      'tauri', ['build', '--debug', '--no-sign', '--bundles', 'app', '--', '--locked'],
    ]);
    expect(bundle?.env).toEqual({ CI: '1' });
    expect(bundle?.cwd).toContain('desktop');
    for (const step of steps) expect(step.timeoutMs).toBeGreaterThan(0);
  });

  it('names artifacts on the release convention with an explicit nightly marker', () => {
    expect(nightlyArtifactName({ version: '3.29.15', triple: 'aarch64-apple-darwin' })).toBe(
      'Phantom_3.29.15_aarch64-nightly-debug.app.tar.gz',
    );
    expect(nightlyArtifactName({ version: '3.29.15', triple: 'x86_64-apple-darwin' })).toBe(
      'Phantom_3.29.15_x86_64-nightly-debug.app.tar.gz',
    );
    expect(() => nightlyArtifactName({ version: '', triple: 'aarch64-apple-darwin' })).toThrow();
  });

  it('parses exact versions out of real tool output shapes', () => {
    expect(extractVersion('v22.23.2\n')).toBe('22.23.2');
    expect(extractVersion('10.9.8\n')).toBe('10.9.8');
    expect(extractVersion('rustc 1.97.1 (8bab26f4f 2026-07-14)')).toBe('1.97.1');
    expect(extractVersion('tauri-cli 2.11.4')).toBe('2.11.4');
    expect(extractVersion('no version here')).toBeNull();
    expect(extractVersion('')).toBeNull();
  });
});

describe('unsigned dev build enforcement', () => {
  it('scrubs every signing variable the release workflow documents', () => {
    const documented = [
      'APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY',
      'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID',
      'WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD',
      'TAURI_WINDOWS_SIGN_PFX', 'TAURI_WINDOWS_SIGN_PFX_PASSWORD',
      'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ];
    for (const key of documented) {
      expect(releaseWorkflow).toContain(key);
      expect(SIGNING_ENV_KEYS).toContain(key);
    }
    const { env, scrubbed } = scrubSigningEnv({
      PATH: '/bin',
      TAURI_SIGNING_PRIVATE_KEY: 'shh',
      APPLE_ID: 'dev@example.com',
    } as NodeJS.ProcessEnv);
    expect(scrubbed.sort()).toEqual(['APPLE_ID', 'TAURI_SIGNING_PRIVATE_KEY']);
    expect(env['PATH']).toBe('/bin');
    expect(env['TAURI_SIGNING_PRIVATE_KEY']).toBeUndefined();
    expect(env['APPLE_ID']).toBeUndefined();
  });

  it('keeps the unsigned and no-publication guards in the script source', () => {
    expect(scriptText).toContain("'--no-sign'");
    expect(scriptText).toContain('scrubSigningEnv');
    expect(scriptText).toContain('unsigned: true');
    expect(scriptText).toContain('releaseArtifact: false');
    expect(scriptText).toContain('GITHUB_OUTPUT');
    // Only key names are ever logged or recorded; values stay in the scrubbed
    // copy of the environment and are never written to the manifest.
    expect(scriptText).not.toMatch(/console\.(log|error)\([^)]*env\[[^\]]*SIGN/);
    expect(scriptText).not.toMatch(/npm\s+publish|gh\s+release|tauri-action/);
  });

  it('packs a staged Phantom.app into a verifiable sha256 tarball', () => {
    const bundleRoot = join(REPO_ROOT, 'desktop', 'src-tauri', 'target', 'debug', 'bundle', 'macos');
    const appContents = join(bundleRoot, 'Phantom.app', 'Contents');
    const preExistingBundle = existsSync(bundleRoot);
    const outDir = mkdtempSync(join(tmpdir(), 'desktop-nightly-out-'));
    mkdirSync(appContents, { recursive: true });
    writeFileSync(join(appContents, 'Info.plist'), '<plist>nightly-fixture</plist>');
    try {
      const artifact = packageArtifact({
        outDir, version: '3.29.15', triple: 'aarch64-apple-darwin', env: process.env,
      });
      expect(artifact.name).toBe('Phantom_3.29.15_aarch64-nightly-debug.app.tar.gz');
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(`${artifact.path}.sha256`, 'utf8')).toBe(
        `${artifact.sha256}  ${artifact.name}\n`,
      );
      const list = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf8' });
      expect(list.status).toBe(0);
      expect(list.stdout).toContain('Phantom.app/Contents/Info.plist');
      const digest = createHash('sha256').update(readFileSync(artifact.path)).digest('hex');
      expect(digest).toBe(artifact.sha256);
      // A second run reuses the dir by replacing only its own output.
      const again = packageArtifact({
        outDir, version: '3.29.15', triple: 'aarch64-apple-darwin', env: process.env,
      });
      expect(again.sha256).toBe(artifact.sha256);
      // Foreign entries are never cleaned: the out dir refuses unexpected files.
      writeFileSync(join(outDir, 'unrelated.txt'), 'keep me');
      expect(() => packageArtifact({
        outDir, version: '3.29.15', triple: 'aarch64-apple-darwin', env: process.env,
      })).toThrow(/refusing to reuse non-empty artifact dir/);
      expect(existsSync(join(outDir, 'unrelated.txt'))).toBe(true);
    } finally {
      if (preExistingBundle) rmSync(join(bundleRoot, 'Phantom.app'), { recursive: true, force: true });
      else rmSync(join(REPO_ROOT, 'desktop', 'src-tauri', 'target'), { recursive: true, force: true });
    }
  });

  it('records an unsigned, non-release artifact in the manifest', () => {
    const manifest = createManifest({
      version: '3.29.15',
      triple: 'aarch64-apple-darwin',
      profile: 'debug',
      toolchain: [
        { tool: 'node', expected: '22.23.2', actual: '22.23.2', ok: true },
      ],
      scrubbed: ['APPLE_ID'],
      artifact: { name: 'Phantom_3.29.15_aarch64-nightly-debug.app.tar.gz', bytes: 1, sha256: 'a'.repeat(64) },
      steps: [{ name: 'install', seconds: 1 }],
      env: { GITHUB_SHA: 'b'.repeat(40), GITHUB_REPOSITORY: 'ashlrai/phantom' },
    });
    expect(manifest.kind).toBe('phantom-desktop-nightly');
    expect(manifest.unsigned).toBe(true);
    expect(manifest.releaseArtifact).toBe(false);
    expect(manifest.retentionDays).toBeLessThanOrEqual(7);
    expect(manifest.artifacts?.[0]?.kind).toBe('app-tarball');
    expect(manifest.source.commit).toBe('b'.repeat(40));
    expect(manifest.scrubbedSigningEnv).toEqual(['APPLE_ID']);
  });
});

describe('toolchain pin coherence', () => {
  it('keeps desktop/toolchain.json identical to the release workflow and publisher policy', () => {
    const releasePin = (name: string) =>
      releaseWorkflow.match(new RegExp(`^[ ]{2}${name}: "([^"]+)"$`, 'm'))?.[1];
    expect(pins.node).toBe(releasePin('NODE_VERSION'));
    expect(pins.bun).toBe(releasePin('BUN_VERSION'));
    expect(pins.rust).toBe(releasePin('RUST_VERSION'));
    expect(pins.tauriCli).toBe(releasePin('TAURI_CLI_VERSION'));

    expect(pins.node).toBe(DESKTOP_RELEASE_TOOL_PINS.node.version.replace(/^v/, ''));
    expect(pins.npm).toBe(DESKTOP_RELEASE_TOOL_PINS.npm.version);
    expect(pins.bun).toBe(DESKTOP_RELEASE_TOOL_PINS.bun.version);
    expect(pins.rust).toBe(extractVersion(DESKTOP_RELEASE_TOOL_PINS.rustc.version));
    expect(pins.rust).toBe(extractVersion(DESKTOP_RELEASE_TOOL_PINS.cargo.version));
    expect(pins.tauriCli).toBe(extractVersion(DESKTOP_RELEASE_TOOL_PINS.tauri.version));
  });

  it('wires the entry point through package.json and keeps build output untracked', () => {
    expect(pkg.scripts['build:desktop:nightly']).toBe('node scripts/build-desktop-nightly.mjs');
    expect(desktopGitignore).toContain('dist-nightly/');
    expect(desktopGitignore).toContain('src-tauri/icons/*.png');
    expect(desktopGitignore).toContain('!src-tauri/icons/tray.png');
  });
});

describe('nightly job contract carried in the docs', () => {
  // The m30 CI contract fails on public-effect vocabulary in ci.yml itself; the
  // paste-ready job in desktop/README.md must satisfy the same scan so copying
  // it into the scheduled workflow cannot regress the gate.
  const jobBlock = desktopReadme.match(/```yaml\n( {2}desktop-nightly:[\s\S]*?)```/)?.[1] ?? '';

  it('documents a paste-ready job that passes the CI public-effect scan', () => {
    expect(jobBlock).not.toBe('');
    expect(jobBlock).not.toMatch(/\b(npm\s+publish|deploy|release)\b/i);
    expect(jobBlock).not.toContain('secrets.');
    const job = (parse(`jobs:\n${jobBlock}`) as { jobs: Record<string, Record<string, unknown>> })
      .jobs['desktop-nightly']!;
    expect(job['runs-on']).toBe('macos-latest');
    expect(job['if']).toBe(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    );
    expect(job['needs']).toBeUndefined();
    expect(job['timeout-minutes']).toBeLessThanOrEqual(120);

    const uses = [...jobBlock.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]!);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/i);

    const text = jobBlock;
    expect(text).toContain(`bun-version: "${pins.bun}"`);
    expect(text).toContain(`node-version: "${pins.node}"`);
    expect(text).toContain(`toolchain: "${pins.rust}"`);
    expect(text).toContain(`@tauri-apps/cli@${pins.tauriCli}`);
    expect(text).toContain('run: node scripts/build-desktop-nightly.mjs');
    expect(text).toMatch(/retention-days: [1-7]\b/);
    expect(text).toContain('${{ steps.nightly.outputs.artifact_dir }}');
  });

  it('states the unsigned, non-publication, macOS-only, 7-day contract in both guides', () => {
    for (const doc of [desktopReadme, desktopPointer]) {
      expect(doc).toContain('build:desktop:nightly');
      expect(doc).toMatch(/unsigned/i);
      expect(doc).toMatch(/7.day|retention-days: 7/);
    }
    expect(desktopReadme).toContain('### Nightly dev build (scheduled master CI)');
    expect(desktopReadme).toContain('desktop/toolchain.json');
    expect(desktopReadme).toContain('--no-sign');
    expect(desktopReadme).toContain('disabled_manually');
    expect(desktopReadme).toContain('Phantom_<version>_<arch>-nightly-debug.app.tar.gz');
  });
});
