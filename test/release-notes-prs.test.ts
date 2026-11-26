import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import {
  buildPrNotes, formatPrNotesMarkdown, ghPrSourceWith, resolveRepo, PR_NOTES_SCHEMA, NOTHING_TO_RELEASE, UNKNOWN_CHANGE,
  type GhRead, type MergedPr, type PrSource,
} from '../src/core/release/pr-notes.js';
import type { GhRunResult } from '../src/core/integrations/github.js';

const pr = (number: number, title: string, body = '', files?: string[]): MergedPr => ({ number, title, body, files });
const mixed: MergedPr[] = [
  pr(101, 'bridge(RQ-A): feat: add offline search', '## Summary\n\n- Search now works without a network connection.\n\n## Test plan\n- ran it', ['src/core/search.ts']),
  pr(102, 'bridge(RQ-B): fix: keep saved searches after restart', '', ['src/core/search.ts']),
  pr(103, 'bridge(RQ-C): fix: block path traversal in uploads', '', ['src/core/upload.ts']),
  pr(104, 'bridge(RQ-D): test: cover search edge cases', '', ['test/search.test.ts']),
  pr(105, 'bridge(RQ-E): update search wording', '## BRIDGE_NOTES\n\nBRIDGE_NOTES: nothing\n', ['BRIDGE_NOTES.md', 'test/search.test.ts']),
  pr(106, 'bridge(RQ-F): speed up search results', '', ['src/core/search.ts']),
];
const lines = (n: ReturnType<typeof buildPrNotes>) => Object.fromEntries(Object.entries(n.sections).map(([k, v]) => [k, v.map(l => `${l.text} ${l.prs.join(',')}`)]));

describe('release notes from pull requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says "Nothing to release." for 0 PRs', () => {
    const notes = buildPrNotes('ashlrai/phantom', 'v1.0.0', { prs: [], complete: true });
    expect(notes.summary).toBe(NOTHING_TO_RELEASE);
    expect(notes.schema).toBe(PR_NOTES_SCHEMA);
    expect(formatPrNotesMarkdown(notes)).toBe('Nothing to release.\n');
  });

  it('groups a mixed set of 6, drops 2 internal-only PRs and states security in plain words', () => {
    const notes = buildPrNotes(undefined, 'v1.0.0', { prs: mixed, complete: true });
    expect(notes.skipped).toEqual([104, 105]);
    expect(lines(notes)).toEqual({
      Added: ['Search now works without a network connection 101'],
      Changed: ['Speed up search results 106'],
      Fixed: ['Keep saved searches after restart 102'],
      Security: ['Block path traversal in uploads 103'],
    });
    expect(notes.summary).toBe('4 changes since v1.0.0.');
    expect(formatPrNotesMarkdown(notes)).toBe([
      '## Unreleased', '', '### Added', '', '- Search now works without a network connection (#101)', '',
      '### Changed', '', '- Speed up search results (#106)', '', '### Fixed', '', '- Keep saved searches after restart (#102)', '',
      '### Security', '', '- Block path traversal in uploads (#103)', '',
    ].join('\n'));
    expect(JSON.stringify(notes)).not.toMatch(/RQ-|bridge\(/);
  });

  it('falls back to the title without the bridge prefix when the body is empty', () => {
    const notes = buildPrNotes(undefined, 'v1.0.0', { prs: [pr(7, 'bridge(RQ-X): add dark mode (#7)', '')], complete: true });
    expect(notes.sections.Added).toEqual([{ text: 'Add dark mode', prs: [7] }]);
    expect(notes.unknown).toEqual([]);
  });

  it('shows an unreadable change as unknown and flags a cut-off list', () => {
    const notes = buildPrNotes(undefined, 'v1.0.0', { prs: [pr(9, 'bridge(RQ-X):', '')], complete: false });
    expect(notes.sections.Changed).toEqual([{ text: UNKNOWN_CHANGE, prs: [9] }]);
    expect(notes.unknown).toEqual([9]);
    expect(notes.complete).toBe(false);
    expect(formatPrNotesMarkdown(notes)).toContain('cut off');
  });

  it('merges identical lines from recut PRs into one line with both numbers', () => {
    const notes = buildPrNotes(undefined, 'v1', { prs: [pr(2, 'feat: add clock'), pr(1, 'feat: add clock')], complete: true });
    expect(notes.sections.Added).toEqual([{ text: 'Add clock', prs: [1, 2] }]);
  });

  it('resolves repo names and rejects odd ones', () => {
    expect(resolveRepo('phantom')).toBe('ashlrai/phantom');
    expect(resolveRepo('acme/tool')).toBe('acme/tool');
    expect(() => resolveRepo('a b;c')).toThrow('Invalid repo name');
  });
});

describe('phm release notes --repo', () => {
  const source = (prs: MergedPr[], complete = true): PrSource & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return { calls, async mergedSince(repo, since) { calls.push([repo, since]); return { prs, complete }; } };
  };
  const run = async (args: string[], src: PrSource) => {
    let out = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await cmdRelease(['notes', ...args], { prs: src });
    write.mockRestore(); err.mockRestore();
    return { code, out };
  };

  it('prints typed JSON with a schema id', async () => {
    const src = source(mixed);
    const { code, out } = await run(['--since', 'v1.0.0', '--repo', 'phantom', '--json'], src);
    expect(code).toBe(0);
    expect(src.calls).toEqual([['ashlrai/phantom', 'v1.0.0']]);
    const json = JSON.parse(out);
    expect(json.schema).toBe('phantom.release-notes-prs.v1');
    expect(json.repo).toBe('ashlrai/phantom');
    expect(json.sections.Security).toHaveLength(1);
  });

  it('prints a pasteable Markdown section with --markdown and the empty message for 0 PRs', async () => {
    expect((await run(['--since', 'v1', '--repo', 'phantom', '--markdown'], source(mixed))).out).toMatch(/^## Unreleased\n\n### Added/);
    expect((await run(['--since', 'v1', '--repo', 'phantom'], source([]))).out).toBe('Nothing to release.\n');
  });

  it('needs --since, refuses --write, and reports a failed read as JSON exit 1', async () => {
    expect((await run(['--repo', 'phantom', '--json'], source([]))).code).toBe(1);
    expect((await run(['--since', 'v1', '--repo', 'phantom', '--write'], source([]))).code).toBe(2);
    const failing: PrSource = { async mergedSince() { throw new Error('Cannot read merged PRs from GitHub'); } };
    const { code, out } = await run(['--since', 'v1', '--repo', 'phantom', '--json'], failing);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({ ok: false, reason: 'Cannot read merged PRs from GitHub' });
  });
});

describe('ghPrSource (the real gh reader, hermetic)', () => {
  const ok = (stdout: string): GhRunResult => ({ stdout, failure: null });
  const fail = (failure: 'spawn' | 'timeout' | 'exit' | 'aborted'): GhRunResult => ({ stdout: null, failure });
  /** A GhRead answering the tag lookup then the PR list, recording every call. */
  const reader = (tag: GhRunResult, list: GhRunResult) => {
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const read: GhRead = async (_cwd, args, timeoutMs) => {
      calls.push({ args, timeoutMs });
      return args[0] === 'api' ? tag : list;
    };
    return { read, calls };
  };
  const stamp = ok('2026-11-22T17:14:53Z');
  const prsJson = JSON.stringify([
    { number: 7, title: 'feat: add thing', body: '', mergedAt: '2026-11-23T00:00:00Z', files: [{ path: 'src/x.ts' }] },
    { number: 6, title: 'fix: old', body: '', mergedAt: '2026-11-21T00:00:00Z', files: [{ path: 'src/y.ts' }] },
  ]);

  it('reads the tag stamp then merged PRs after it, with a longer deadline for the list call', async () => {
    const { read, calls } = reader(stamp, ok(prsJson));
    const source = ghPrSourceWith(read);
    const out = await source.mergedSince('ashlrai/phantom', 'v3.30.71');
    expect(out.prs.map(p => p.number)).toEqual([7]);
    expect(out.complete).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(['api', 'repos/ashlrai/phantom/commits/v3.30.71', '--jq', '.commit.committer.date']);
    expect(calls[0]!.timeoutMs).toBeUndefined();
    expect(calls[1]!.args.slice(0, 6)).toEqual(['pr', 'list', '--repo', 'ashlrai/phantom', '--state', 'merged']);
    expect(calls[1]!.args.join(' ')).toContain('merged:>=2026-11-22');
    expect(calls[1]!.timeoutMs).toBeGreaterThan(8_000);
  });

  it('rejects an invalid tag before any gh call', async () => {
    const { read, calls } = reader(stamp, ok(prsJson));
    await expect(ghPrSourceWith(read).mergedSince('ashlrai/phantom', 'bad tag;')).rejects.toThrow('Invalid release tag');
    expect(calls).toHaveLength(0);
  });

  it('keeps the unreadable-tag message when gh ran and refused', async () => {
    const { read } = reader(fail('exit'), ok(prsJson));
    await expect(ghPrSourceWith(read).mergedSince('ashlrai/phantom', 'v9')).rejects.toThrow('Cannot read the release tag from GitHub; check the repo and tag');
  });

  it('names a missing gh instead of blaming the tag or repo', async () => {
    const { read } = reader(fail('spawn'), ok(prsJson));
    await expect(ghPrSourceWith(read).mergedSince('ashlrai/phantom', 'v9')).rejects.toThrow('gh could not run');
  });

  it('names a slow gh instead of blaming the tag or repo', async () => {
    const { read } = reader(stamp, fail('timeout'));
    await expect(ghPrSourceWith(read).mergedSince('ashlrai/phantom', 'v9')).rejects.toThrow('gh did not answer in time while reading merged PRs');
  });

  it('keeps the merged-PR message when gh ran and refused, and on malformed JSON', async () => {
    const refused = reader(stamp, fail('exit'));
    await expect(ghPrSourceWith(refused.read).mergedSince('ashlrai/phantom', 'v9')).rejects.toThrow('Cannot read merged PRs from GitHub');
    const malformed = reader(stamp, ok('not json'));
    await expect(ghPrSourceWith(malformed.read).mergedSince('ashlrai/phantom', 'v9')).rejects.toThrow('Cannot read merged PRs from GitHub');
  });
});
