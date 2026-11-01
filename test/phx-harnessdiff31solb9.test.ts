import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflectHarnessDigest } from '../src/cli/reflect-harness-digest.js';
import * as reader from '../src/core/learn/harness-digest-reader.js';

const now = new Date('2026-10-31T12:00:00Z');
const source = (id = 'S1', notes = ['Capture traces'], date = '2026-10-30') =>
  `## ${id} — Research\n- Checked: ${date}.\n- Source: [fixture](https://example.test/${id})\n${notes.map(text => `- Takeaway: ${text}`).join('\n')}\n`;
let dir: string;
let current: string;
let previous: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-diff-'));
  current = join(dir, 'current.md');
  previous = join(dir, 'previous.md');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
function run(args = ['--file', current, '--compare-file', previous, '--json']) {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: cmdReflectHarnessDigest(args, now), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}
function compare(old: string, next: string) {
  writeFileSync(previous, old); writeFileSync(current, next);
  const result = run();
  expect(result.code).toBe(0); expect(result.err).toBe('');
  return JSON.parse(result.out);
}

describe('local harness digest comparison', () => {
  it('omits unchanged research and ignores source/takeaway ordering', () => {
    const result = compare(source('S1', ['A', 'B']) + source('S2'), source('S2') + source('S1', ['B', 'A']));
    expect(result).toEqual({ v: 1, added: [], removed: [], changed: [], addedTakeaways: [], removedTakeaways: [], ambiguous: [], issues: { previous: [], current: [] } });
  });
  it('distinguishes a citation date refresh from learned content', () => {
    const result = compare(source(), source('S1', ['Capture traces'], '2026-10-31'));
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ id: 'S1', kind: 'citation_date', before: { checkedAt: '2026-10-30' }, after: { checkedAt: '2026-10-31', urls: ['https://example.test/S1'] } });
    expect(result.addedTakeaways).toEqual([]); expect(result.removedTakeaways).toEqual([]);
  });
  it('separates new ideas, changed text and removed sources with original citations', () => {
    const result = compare(source('S1', ['Old idea', 'Keep']) + source('S2', ['Removed idea']), source('S1', ['New idea', 'Keep']) + source('S3', ['New source']));
    expect(result.changed[0].kind).toBe('content');
    expect(result.added.map((s: { id: string }) => s.id)).toEqual(['S3']);
    expect(result.removed.map((s: { id: string }) => s.id)).toEqual(['S2']);
    expect(result.addedTakeaways.map((s: { text: string }) => s.text)).toEqual(['New idea', 'New source']);
    expect(result.removedTakeaways).toEqual([
      { id: 'S1', text: 'Old idea', checkedAt: '2026-10-30', urls: ['https://example.test/S1'] },
      { id: 'S2', text: 'Removed idea', checkedAt: '2026-10-30', urls: ['https://example.test/S2'] },
    ]);
  });
  it('compares title, citation URL and license content without inventing takeaways', () => {
    const result = compare(source(), source().replace('Research', 'Updated').replace('https://example.test/S1', 'https://example.test/new') + '- License: MIT\n');
    expect(result.changed[0]).toMatchObject({ kind: 'content', after: { title: 'Updated', license: 'MIT', urls: ['https://example.test/new'] } });
    expect(result.addedTakeaways).toEqual([]);
  });
  it('retains both sides of duplicate IDs and all parser issues without inferred ideas', () => {
    const result = compare(source() + source('S1', ['Ambiguous']) + '## Sx — Bad\n', source('S1', ['Unknown']) + '## S2 — Undated\n');
    expect(result.ambiguous.map((s: { id: string }) => s.id)).toEqual(['S1', 'Sx']);
    expect(result.ambiguous[0].before).toHaveLength(2);
    expect(result.ambiguous[0].after).toHaveLength(1);
    expect(result.changed).toEqual([]); expect(result.addedTakeaways).toEqual([]);
    expect(result.issues).toEqual({ previous: [{ id: 'S1', code: 'duplicate_id' }, { id: 'Sx', code: 'malformed_id' }], current: [{ id: 'S2', code: 'missing_checked' }, { id: 'S2', code: 'missing_urls' }] });
    const reversed = compare(source(), source() + source('S1', ['Duplicate']));
    expect(reversed.ambiguous[0].after).toHaveLength(2);
    expect(reversed.addedTakeaways).toEqual([]);
  });
  it('preserves truncation flags and makes no network calls', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = compare('', source('S1', Array.from({ length: 21 }, (_, i) => `Idea ${i}`)));
    expect(result.added[0].takeawaysTruncated).toEqual({ count: true, bytes: false });
    expect(result.addedTakeaways).toHaveLength(20); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects ambiguous options before reading either file', () => {
    const read = vi.spyOn(reader, 'readHarnessDigest');
    const base = ['--file', current, '--compare-file', previous, '--json'];
    for (const extra of [['--check'], ['--source', 'S1'], ['--query', 'idea'], ['--needs-refresh'], ['--with-takeaways'], ['--text'], ['--compare-file', previous]]) {
      expect(run([...base, ...extra]).code).toBe(2);
    }
    expect(run(['--compare-file', previous, '--json']).code).toBe(2);
    expect(run(['--file', current, '--compare-file', previous, '--text']).code).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
  it('uses bounded regular-file reads for both inputs and emits no partial JSON', () => {
    writeFileSync(current, source()); writeFileSync(previous, source());
    const link = join(dir, 'link.md'); symlinkSync(previous, link);
    const large = join(dir, 'large.md'); writeFileSync(large, 'x'.repeat(1024 * 1024 + 1));
    for (const bad of [join(dir, 'missing.md'), dir, link, large]) {
      for (const [next, old] of [[current, bad], [bad, previous]]) {
        const result = run(['--file', next!, '--compare-file', old!, '--json']);
        expect(result.code).toBe(1); expect(result.out).toBe(''); expect(result.err).not.toContain(bad);
      }
    }
  });
});
