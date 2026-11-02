import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readHarnessDigest } from '../src/core/learn/harness-digest-reader.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const digestPath = join(repoRoot, 'docs/research/harness-digest-2026-10-31.md');
// Pinned just after the digest's Checked dates so freshness is deterministic.
const digest = readHarnessDigest(digestPath, new Date('2026-10-31T23:59:59Z'));

/** Repo-relative paths named inside backticks in a takeaway string. */
function namedPaths(takeaway: string): string[] {
  const paths: string[] = [];
  for (const match of takeaway.matchAll(/`([^`]+)`/g)) {
    const value = match[1]!;
    if (/^(?:src|test|docs|examples|scripts)\/[^\s]+$/.test(value)) paths.push(value);
  }
  return paths;
}

describe('harness digest 2026-10-31', () => {
  it('parses to at least 8 sources with no diagnostics', () => {
    expect(digest).not.toBeNull();
    expect(digest!.sources.length).toBeGreaterThanOrEqual(8);
    expect(digest!.issues).toEqual([]);
    for (const source of digest!.sources) {
      expect(source.checkedAt, `${source.id} checkedAt`).toBe('2026-10-31');
      expect(source.stale, `${source.id} stale`).toBe(false);
      expect(source.urls.length, `${source.id} urls`).toBeGreaterThan(0);
      expect(source.license, `${source.id} license`).toBeTruthy();
      expect(source.takeaways?.length ?? 0, `${source.id} takeaways`).toBeGreaterThan(0);
    }
  });

  it('names an existing Phantom file in every takeaway', () => {
    expect(digest).not.toBeNull();
    for (const source of digest!.sources) {
      for (const takeaway of source.takeaways ?? []) {
        const paths = namedPaths(takeaway);
        expect(paths.length, `${source.id} takeaway names a Phantom path: ${takeaway}`).toBeGreaterThan(0);
        for (const path of paths) {
          expect(existsSync(join(repoRoot, path)), `${source.id} path exists: ${path}`).toBe(true);
        }
      }
    }
  });
});
