import { describe, expect, it } from 'vitest';
import { selectChangedFiles } from '../scripts/verify-changed.mjs';

// The realio-lane and verse-sync-io guards scan fixed input sets, so
// verify-changed only runs them when the diff can move their verdict.
describe('selectChangedFiles lane guard coverage', () => {
  it('selects the realio lane check for every scanned test file, including deletions', () => {
    for (const path of [
      'test/foo.test.ts',
      'test/nested/dir/suite.test.ts',
      'test/fixtures/payload.test.ts',
      'test/gone.test.ts',
    ]) {
      // A deleted path is absent from existingPaths but still selects the
      // guard: removing a member file can stale the lane manifest.
      expect(selectChangedFiles([path], path === 'test/gone.test.ts' ? [] : [path]).realioLaneCheck).toBe(true);
    }
  });

  it('selects the realio lane check for every manifest, allowlist and checker input', () => {
    for (const path of [
      'test/config/realio-lane-membership.mjs',
      'test/config/serial-cpu-lane-membership.mjs',
      'scripts/check-realio-lane-membership.mjs',
      'scripts/realio-lane-inventory.mjs',
      'scripts/realio-lane-known-fast-spawns.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).realioLaneCheck).toBe(true);
    }
  });

  it('skips the realio lane check for diffs that cannot add a spawn marker', () => {
    for (const path of [
      'src/core/x.ts',
      'docs/guide.md',
      'test/helper.ts',
      'test/fixtures/data.json',
      'test/x.test.tsx',
      'test/x.test.mts',
      'test/x.test.jsx',
      'src/web-ui/x.test.ts',
      'contest/x.test.ts',
      'latest/test/x.test.ts',
      'scripts/check-verse-sync-io.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).realioLaneCheck).toBe(false);
    }
  });

  it('selects the verse sync-I/O check for route files and the checker, including deletions', () => {
    for (const path of [
      'src/core/verse/foo-api.ts',
      'src/core/verse/nested/bar-api.ts',
      'src/core/verse/-api.ts',
      'scripts/check-verse-sync-io.mjs',
    ]) {
      expect(selectChangedFiles([path], path === 'src/core/verse/foo-api.ts' ? [] : [path]).verseSyncIoCheck).toBe(true);
    }
  });

  it('skips the verse sync-I/O check outside its scanned route set', () => {
    for (const path of [
      'src/core/verse/foo.ts',
      'src/core/verse/api.ts',
      'src/core/verse-other/x-api.ts',
      'src/core/x-api.ts',
      'test/x-api.test.ts',
      'scripts/check-realio-lane-membership.mjs',
    ]) {
      expect(selectChangedFiles([path], [path]).verseSyncIoCheck).toBe(false);
    }
  });

  it('keeps the two guards independent', () => {
    expect(selectChangedFiles(['test/x.test.ts'], ['test/x.test.ts'])).toMatchObject({ realioLaneCheck: true, verseSyncIoCheck: false });
    expect(selectChangedFiles(['src/core/verse/x-api.ts'], ['src/core/verse/x-api.ts'])).toMatchObject({ realioLaneCheck: false, verseSyncIoCheck: true });
  });
});
