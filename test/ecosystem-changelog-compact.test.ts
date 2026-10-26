import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeEcosystemChangelogArtifacts, CHANGELOG_MAX_BYTES, compactGeneratedEcosystemMarkdown, compactEcosystemChangelog, parseEcosystemChangelog, readRecentEcosystemChanges, renderEcosystemChangelogText } from '../src/core/ecosystem/changelog.js';

const entry = (id = 1) => ({ repo: 'ashlrai/phantom', date: '2026-10-26T12:00:00.000Z', title: 'Improve planner', url: `https://github.com/ashlrai/phantom/pull/${id}` });
describe('compact ecosystem changelog', () => {
  it('consumes the GEN Markdown contract with dated releases and source links', () => {
    const markdown = readFileSync('test/fixtures/ecosystem-changelog-compact/generated.md', 'utf8');
    const data = compactGeneratedEcosystemMarkdown(markdown);
    expect(data.entries).toHaveLength(14);
    expect(data.entries.filter((change) => change.repo === 'ashlrai/phantom')).toHaveLength(2);
    expect(data.entries[0].date).toBe('2026-10-26T00:00:00.000Z');
    expect(data.entries.find((change) => change.repo === 'ashlrai/phantom')?.url).toBe('https://github.com/ashlrai/phantom/blob/HEAD/CHANGELOG.md#120---2026-10-26');
    expect(data.entries.every((change) => change.url.includes('/blob/HEAD/CHANGELOG.md#'))).toBe(true);
    expect(parseEcosystemChangelog(JSON.stringify(data))).toEqual(data);
    expect(compactGeneratedEcosystemMarkdown('### [phantom](https://github.com/ashlrai/phantom)\n#### [Unreleased]\n- Future change\n').entries).toEqual([]);
    expect(compactGeneratedEcosystemMarkdown('```\n' + markdown + '\n```').entries).toEqual([]);
  });
  it('round trips the versioned schema and rejects invalid contracts', () => {
    const data = compactEcosystemChangelog([entry()]);
    expect(parseEcosystemChangelog(JSON.stringify(data))).toEqual(data);
    for (const value of [null, { ...data, schemaVersion: 2 }, { ...data, extra: true }, { ...data, entries: [{ ...entry(), url: 'https://evil.test' }] }, { ...data, entries: [{ ...entry(), date: '2026-02-30T12:00:00.000Z' }] }]) {
      expect(() => parseEcosystemChangelog(JSON.stringify(value))).toThrow();
    }
    expect(() => parseEcosystemChangelog(' '.repeat(CHANGELOG_MAX_BYTES + 1))).toThrow();
    expect(() => parseEcosystemChangelog(JSON.stringify({ ...data, entries: Array.from({ length: 51 }, () => entry()) }))).toThrow();
    expect(() => compactEcosystemChangelog([{ ...entry(), url: 'https://github.com/ashlrai/other/pull/1' }])).toThrow();
    expect(() => compactEcosystemChangelog([{ ...entry(), title: '   ' }])).toThrow();
  });
  it('caps UTF-8 bytes and entries, normalizes text and deduplicates deterministically', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ ...entry(i), title: '界'.repeat(240) }));
    const data = compactEcosystemChangelog(entries);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(data) + '\n')).toBeLessThanOrEqual(CHANGELOG_MAX_BYTES);
    expect(Buffer.byteLength(renderEcosystemChangelogText(data))).toBeLessThanOrEqual(CHANGELOG_MAX_BYTES);
    expect(compactEcosystemChangelog([...entries].reverse())).toEqual(data);
    const clean = compactEcosystemChangelog([{ ...entry(), title: ' One\u2014two\nthree ' }, entry()]);
    expect(clean.entries).toHaveLength(1);
    expect(renderEcosystemChangelogText(clean)).not.toMatch(/[\u2014]/);
  });
  it('emits both artifacts and reads filtered recent entries with safe fallbacks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ecosystem-changelog-'));
    try {
      const input = join(dir, 'input.json');
      await writeFile(input, JSON.stringify([entry(), { ...entry(2), date: '2026-10-25T12:00:00.000Z' }]));
      await writeEcosystemChangelogArtifacts(input, dir);
      const path = join(dir, 'ecosystem-changelog.json');
      expect(parseEcosystemChangelog(readFileSync(path, 'utf8')).entries).toHaveLength(2);
      expect(readFileSync(join(dir, 'ecosystem-changelog.txt'), 'utf8')).toContain('# Ecosystem changelog');
      expect(await readRecentEcosystemChanges(path, { since: '2026-10-26', limit: 1 })).toEqual([entry()]);
      expect(await readRecentEcosystemChanges(path, { repo: 'ashlrai/other' })).toEqual([]);
      expect(await readRecentEcosystemChanges(path, { limit: NaN })).toEqual([]);
      expect(await readRecentEcosystemChanges(path, { since: 'invalid' })).toEqual([]);
      expect(await readRecentEcosystemChanges(join(dir, 'missing'))).toEqual([]);
      await writeFile(path, JSON.stringify({ schemaVersion: 2, entries: [entry()] }));
      expect(await readRecentEcosystemChanges(path)).toEqual([]);
      await writeFile(path, 'x'.repeat(CHANGELOG_MAX_BYTES + 1));
      expect(await readRecentEcosystemChanges(path)).toEqual([]);
      await writeFile(path, '{');
      expect(await readRecentEcosystemChanges(path)).toEqual([]);
      await writeEcosystemChangelogArtifacts('test/fixtures/ecosystem-changelog-compact/generated.md', dir);
      expect(await readRecentEcosystemChanges(path, { repo: 'ashlrai/locus', limit: 1 })).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
