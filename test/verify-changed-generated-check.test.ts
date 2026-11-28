import { describe, expect, it } from 'vitest';
import { selectChangedFiles } from '../scripts/verify-changed.mjs';

// The Merge Gate "Check generated files" job regenerates docs/llms.txt and
// verifies bin/ashlr's digest is still listed in the canonical launcher
// manifest. verify-changed runs the same read-only --check modes, so these
// selections decide when a stale generated file fails locally instead of at
// the gate.
describe('selectChangedFiles generated-file freshness coverage', () => {
  it('selects the docs llms index check for docs pages, the index and its inputs', () => {
    for (const path of [
      'docs/NEW-PAGE.md',
      'docs/nested/guide.md',
      'docs/internal/audit.md',
      'docs/llms-source.txt',
      'docs/llms.txt',
      'scripts/generate-docs-llms.mjs',
      'scripts/lib/docs-pages.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).llmsIndexCheck).toBe(true);
    }
  });

  it('selects the docs llms index check for deleted docs pages', () => {
    expect(selectChangedFiles(['docs/gone.md'], []).llmsIndexCheck).toBe(true);
  });

  it('skips the docs llms index check for non-index paths', () => {
    for (const path of [
      'README.md',
      'AGENTS.md',
      'docs/llms-full.txt',
      'docs/assets/logo.png',
      'docs/data/feed.json',
      'src/core/x.ts',
      'scripts/other.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).llmsIndexCheck).toBe(false);
    }
  });

  it('selects the launcher digest check for the launcher, manifest and checker', () => {
    for (const path of [
      'bin/ashlr',
      'scripts/canonical-launcher-digests.json',
      'scripts/canonical-launcher-digests.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).launcherDigestCheck).toBe(true);
    }
  });

  it('selects the launcher digest check when bin/ashlr is deleted', () => {
    expect(selectChangedFiles(['bin/ashlr'], []).launcherDigestCheck).toBe(true);
  });

  it('skips the launcher digest check for unrelated paths', () => {
    for (const path of [
      'bin/other',
      '.github/tests/canonical-launcher-digests.test.mjs',
      'package.json',
      'docs/guide.md',
    ]) {
      expect(selectChangedFiles([path], [path]).launcherDigestCheck).toBe(false);
    }
  });

  it('selects the caps generated freshness check for the registry, generator and committed output', () => {
    for (const path of [
      'capabilities/registry.v1.json',
      'capabilities/generated/manifest.json',
      'capabilities/generated/SHA256SUMS',
      'capabilities/generated/codex/codex-cli.config.toml',
      'src/core/caps/generate.ts',
      'src/core/caps/registry.ts',
      'src/core/caps/schema.ts',
      'src/core/caps/output.ts',
      'src/core/caps/service.ts',
      'src/core/connectors/profile.ts',
      'src/core/run/engine-registry.ts',
      'src/core/run/model-catalog.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).capsGeneratedCheck).toBe(true);
    }
  });

  it('selects the caps generated freshness check when a caps input is deleted', () => {
    expect(selectChangedFiles(['capabilities/registry.v1.json'], []).capsGeneratedCheck).toBe(true);
    expect(selectChangedFiles(['src/core/caps/generate.ts'], []).capsGeneratedCheck).toBe(true);
    expect(selectChangedFiles(['capabilities/generated/manifest.json'], []).capsGeneratedCheck).toBe(true);
  });

  it('over-selects the whole caps module tree, dispatch.ts included', () => {
    // dispatch.ts is the OS-1 router, not a generator input, but it lives
    // under src/core/caps/ so the prefix trigger covers it — a rare 2.6 s
    // suite run is the price of not enumerating a rotting file list.
    expect(selectChangedFiles(['src/core/caps/dispatch.ts'], ['src/core/caps/dispatch.ts']).capsGeneratedCheck).toBe(true);
  });

  it('skips the caps generated freshness check for unrelated paths', () => {
    for (const path of [
      'capabilities/stacksync.md',
      'src/cli/caps.ts',
      'docs/CAPABILITY-REGISTRY.md',
      'test/caps-registry.test.ts',
      'README.md',
    ]) {
      expect(selectChangedFiles([path], [path]).capsGeneratedCheck).toBe(false);
    }
  });
});
