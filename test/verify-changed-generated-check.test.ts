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
});
