/**
 * build-outputs — every path the release build writes inside the source tree
 * is declared, gitignored and untracked (RQ-RELEASE-ISOLATED-BUILD-1).
 *
 * A build that rewrites a tracked file makes "source changed after build"
 * inevitable: `npm run build` used to regenerate docs/llms.txt, so any docs
 * page merged without regenerating it dirtied every release build. The
 * inventory in scripts/build-outputs.mjs is tied here to the real commands and
 * to git's committed ignore rules; scripts/release-isolated-tree.mjs refuses
 * any undeclared ignored output after a release build.
 *
 * Hermetic: reads package.json, the step plan and git ignore rules only.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStepPlan } from '../scripts/build-desktop-nightly.mjs';
import {
  DESKTOP_NIGHTLY_STEPS,
  NPM_BUILD_STEPS,
  RELEASE_BUILD_OUTPUTS,
  matchesBuildOutput,
  undeclaredBuildOutputs,
} from '../scripts/build-outputs.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

function git(args: string[]) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A concrete in-tree path for one declared output pattern. */
function probe(output: string): string {
  return output.endsWith('/') ? `${output}probe.bin` : output.replace('*', 'ashlr-aarch64-apple-darwin');
}

describe('release build output inventory', () => {
  it('declares exactly the commands `npm run build` runs, in order', () => {
    expect(pkg.scripts.build.split(' && ')).toEqual(NPM_BUILD_STEPS.map((step) => step.command));
  });

  it('never regenerates a tracked file during the build', () => {
    // docs/llms.txt is committed; staleness is a docs test, never a build write.
    expect(pkg.scripts.build).not.toMatch(/generate-docs-llms/);
    expect(pkg.scripts.prepack).toBe('npm run build');
  });

  it('declares every desktop nightly step and drops icon regeneration for release builds', () => {
    expect(buildStepPlan().map((step: { name: string }) => step.name)).toEqual(Object.keys(DESKTOP_NIGHTLY_STEPS));
    expect(buildStepPlan({ existingIcons: true }).map((step: { name: string }) => step.name)).not.toContain('icons');
    // Regenerated rasters are tracked: the release lane must never run that step.
    for (const output of DESKTOP_NIGHTLY_STEPS.icons) expect(RELEASE_BUILD_OUTPUTS).not.toContain(output);
    expect(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'))
      .toContain('npm run build:desktop:nightly -- --existing-icons');
  });

  it.each(RELEASE_BUILD_OUTPUTS.map((output) => [output]))('%s is gitignored by committed rules and untracked', (output) => {
    const path = probe(output);
    const ignored = git(['check-ignore', '--no-index', '--quiet', '--', path]);
    expect(ignored.status, `${path} must be ignored by a committed .gitignore`).toBe(0);
    const tracked = git(['ls-files', '-z', '--', output.endsWith('/') ? output : `:(glob)${output}`]);
    expect(tracked.status).toBe(0);
    expect(tracked.stdout, `${output} must not contain tracked files`).toBe('');
  });

  it('covers every ignored file a release build leaves and refuses anything else', () => {
    // Observed in a clean clone after npm ci, build-sea and prepare-sidecar.
    const observed = [
      'node_modules/.package-lock.json', 'node_modules/.cache/phantom-backend.tsbuildinfo', 'dist/build-identity.json',
      'dist/core/web/public/next/index.html', 'dist-bin/ashlr', 'desktop/src-tauri/binaries/ashlr-aarch64-apple-darwin',
      'desktop/src-tauri/resources/public/index.html', 'desktop/src-tauri/target/debug/ashlr-desktop',
      'desktop/src-tauri/gen/schemas/desktop-schema.json', 'desktop/dist-nightly/manifest.json',
    ];
    expect(undeclaredBuildOutputs(observed)).toEqual([]);
    expect(undeclaredBuildOutputs([
      'docs/.gitignore', 'docs/llms.txt', 'build.log', 'desktop/src-tauri/binaries/other-tool',
      'desktop/src-tauri/binaries/ashlr-x/nested', 'distribution/x', 'desktop/src-tauri/icons/icon.png',
    ])).toEqual([
      'docs/.gitignore', 'docs/llms.txt', 'build.log', 'desktop/src-tauri/binaries/other-tool',
      'desktop/src-tauri/binaries/ashlr-x/nested', 'distribution/x', 'desktop/src-tauri/icons/icon.png',
    ]);
    expect(matchesBuildOutput('dist/x', 'dist/')).toBe(true);
    expect(matchesBuildOutput('dist-bin/x', 'dist/')).toBe(false);
  });
});
