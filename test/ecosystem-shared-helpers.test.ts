import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdEcosystem } from '../src/cli/ecosystem.js';
import * as changelogDoc from '../src/core/ecosystem/changelog-document.js';
import { isValidIsoCalendarDay, parseStrictIsoInstant } from '../src/core/ecosystem/changelog.js';
import * as focus from '../src/core/ecosystem/focus.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('ecosystem shared helpers', () => {
  it('prunes unused runtime exports from focus and changelog-document modules', () => {
    expect('DEFAULT_ECOSYSTEM_FOCUS' in focus).toBe(false);
    expect('strategicTierMultiplier' in focus).toBe(false);
    expect('ECOSYSTEM_CHANGELOG_SCHEMA' in changelogDoc).toBe(false);
    expect('ECOSYSTEM_CHANGELOG_RECENT_DAYS' in changelogDoc).toBe(false);
  });

  it('validates plain records, normalizes unicode dashes, and exposes DAY_MS', () => {
    expect(focus.DAY_MS).toBe(86_400_000);
    expect(focus.isPlainRecord({ ok: true })).toBe(true);
    for (const bad of [null, undefined, [], 'text', 42, false]) {
      expect(focus.isPlainRecord(bad)).toBe(false);
    }

    expect(focus.normalizeUnicodeDashes('alpha\u2014beta\u2013gamma')).toBe('alpha-beta-gamma');
    expect(focus.normalizeUnicodeDashes('alpha\u2014beta', ' - ')).toBe('alpha - beta');
  });

  it('locates package repo roots and resolves repository doc paths', () => {
    const repo = makeTempDir('ecosystem-root-');
    const nested = join(repo, 'src', 'core', 'ecosystem');
    const docsDir = join(repo, 'docs');
    mkdirSync(nested, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}\n');
    const docFile = join(docsDir, 'SAMPLE.md');
    writeFileSync(docFile, '# Sample\n');

    expect(focus.findPackageRepoRoot(nested)).toBe(repo);
    const fakeModuleUrl = pathToFileURL(join(nested, 'focus.ts')).href;
    expect(focus.resolveRepoDocPath(fakeModuleUrl, 'docs', 'SAMPLE.md')).toBe(docFile);
    expect(focus.resolveRepoDocPath(fakeModuleUrl, 'docs', 'MISSING.md')).toBeNull();
  });

  it('validates ISO calendar days and parses strict ISO instants', () => {
    expect(isValidIsoCalendarDay('2024-02-29')).toBe(true);
    expect(isValidIsoCalendarDay('2025-02-29')).toBe(false);
    expect(isValidIsoCalendarDay('2026-02-30')).toBe(false);
    expect(isValidIsoCalendarDay('not-a-date')).toBe(false);

    expect(parseStrictIsoInstant('2026-11-15T10:30:00Z')).toBe('2026-11-15T10:30:00.000Z');
    expect(parseStrictIsoInstant('2026-11-15T12:30:00+02:00')).toBe('2026-11-15T10:30:00.000Z');
    expect(parseStrictIsoInstant('2026-11-15')).toBeNull();
    expect(parseStrictIsoInstant('2026-11-15', { allowDateOnly: true })).toBe('2026-11-15T00:00:00.000Z');
    expect(parseStrictIsoInstant('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseStrictIsoInstant('2026-02-30', { allowDateOnly: true })).toBeNull();
    expect(parseStrictIsoInstant(12345)).toBeNull();
  });

  it('returns exit 2 for unknown subcommands and invalid changelog windows', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });

    expect(await cmdEcosystem(['unknown-sub'])).toBe(2);
    expect(stderr.at(-1)).toContain('unknown ecosystem subcommand: unknown-sub');

    expect(await cmdEcosystem(['changelog', '--since', '2026-02-30'])).toBe(2);
    expect(stderr.at(-1)).toContain('Invalid --since timestamp');
  });
});
