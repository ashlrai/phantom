import { describe, expect, it } from 'vitest';
import { selectChangedFiles } from '../scripts/verify-changed.mjs';

// `npm run build` opens with `check:version`
// (scripts/sync-candidate-version.mjs --check), which every CI build job
// runs: it re-derives the candidate version from package.json and fails
// when any of the eleven tracked metadata files drifted. A version bump
// that reached only some files used to pass verify-changed green and go
// red at the build step — the `(version-sync)` failure shape
// src/core/fleet/ci-baseline.ts parses. These selections decide when the
// same read-only --check runs locally instead.
describe('selectChangedFiles version-sync coverage', () => {
  it('selects the version sync check for every tracked metadata input', () => {
    for (const path of [
      'package.json',
      'package-lock.json',
      'desktop/package.json',
      'desktop/src-tauri/tauri.conf.json',
      'desktop/src-tauri/Cargo.toml',
      'desktop/src-tauri/Cargo.lock',
      'server.json',
      'desktop/README.md',
      'README.md',
      'docs/QUICKSTART.md',
    ]) {
      expect(selectChangedFiles([path], [path]).versionSyncCheck).toBe(true);
    }
  });

  it('selects the version sync check for the checker itself', () => {
    // A checker edit can change the verdict on an identical tree.
    expect(selectChangedFiles(['scripts/sync-candidate-version.mjs'], ['scripts/sync-candidate-version.mjs']).versionSyncCheck).toBe(true);
  });

  it('selects the version sync check when a metadata input is deleted', () => {
    // Removing a tracked file fails the check exactly as it fails the build.
    expect(selectChangedFiles(['package.json'], []).versionSyncCheck).toBe(true);
    expect(selectChangedFiles(['docs/QUICKSTART.md'], []).versionSyncCheck).toBe(true);
    expect(selectChangedFiles(['scripts/sync-candidate-version.mjs'], []).versionSyncCheck).toBe(true);
  });

  it('skips the version sync check for unrelated paths', () => {
    for (const path of [
      'docs/guide.md',
      'docs/QUICKSTART.md.bak',
      'src/core/x.ts',
      'scripts/other.mjs',
      'scripts/sync-candidate-version.mjs.bak',
      'desktop/src-tauri/src/main.rs',
      'desktop/src-tauri/capabilities/default.json',
      'server.json.bak',
    ]) {
      expect(selectChangedFiles([path], [path]).versionSyncCheck).toBe(false);
    }
  });
});
