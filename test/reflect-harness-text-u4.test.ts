import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import { MAX_TAKEAWAY_BYTES, MAX_TAKEAWAYS } from '../src/core/learn/harness-digest-reader.js';

const fixture = `# Harness learning

## S1 — Trace capture patterns
- Checked: 2026-10-24.
- Source: Examples from [Alpha](https://example.test/alpha) and [Beta](https://example.test/beta).
- Takeaway: Log traces before review.
  Keep raw commands.
- Takeaway: Prefer small digests.

## S2 — Evaluation loop
- Checked: 2026-10-23.
- Source: [Study](https://research.example.test/eval).
`;

const issued = `## S3 — Fresh one
- Checked: 2026-10-31.
- Source: [x](https://example.test/x)
## S2 — Undated
- Source: [y](https://example.test/y)
## Sx — Bad
- Checked: 2026-10-31.
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-digest-text-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T23:59:59Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
function file(name: string, text: string): string {
  const target = join(dir, name);
  writeFileSync(target, text);
  return target;
}
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['harness-digest', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('reflect harness-digest --text', () => {
  it('renders selected sources with freshness, URLs, multiline takeaways and issues', async () => {
    const target = file('digest.md', fixture);
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(`S1 — Trace capture patterns
  checked: 2026-10-24 (fresh)
  url: https://example.test/alpha
  url: https://example.test/beta
  takeaway: Log traces before review.
    Keep raw commands.
  takeaway: Prefer small digests.

S2 — Evaluation loop
  checked: 2026-10-23 (stale)
  url: https://research.example.test/eval
`);
  });

  it('lets a leader see what to refresh and why with --needs-refresh, without jq', async () => {
    const target = file('digest.md', fixture + issued);
    const result = await run(['--file', target, '--text', '--needs-refresh']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`S2 — Evaluation loop
  checked: 2026-10-23 (stale)
  url: https://research.example.test/eval

S2 — Undated
  checked: none (undated)
  url: https://example.test/y

issues:
  S2 duplicate_id
  S2 missing_checked
  Sx malformed_id
`);
  });

  it('selects one source and its matching issues with --source', async () => {
    const target = file('digest.md', issued);
    const result = await run(['--file', target, '--text', '--source', 'S2']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`S2 — Undated
  checked: none (undated)
  url: https://example.test/y

issues:
  S2 missing_checked
`);
    const missing = await run(['--file', target, '--text', '--source', 'S9']);
    expect(missing.code).toBe(0);
    expect(missing.out).toBe('(no sources selected)\n');
  });

  it('marks count and byte truncation of takeaways', async () => {
    const many = Array.from({ length: MAX_TAKEAWAYS + 2 }, (_, i) => `- Takeaway: Note ${i}`).join('\n');
    const heavy = `- Takeaway: ${'a'.repeat(MAX_TAKEAWAY_BYTES + 1)}`;
    const target = file('truncated.md', `## S1 — Many\n- Checked: 2026-10-31.\n- Source: [x](https://example.test/x)\n${many}\n## S2 — Heavy\n- Checked: 2026-10-31.\n- Source: [y](https://example.test/y)\n${heavy}\n`);
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('S1 — Many\n');
    expect(result.out).toContain('  takeaway: Note 0\n');
    expect(result.out).toContain(`  takeaway: Note ${MAX_TAKEAWAYS - 1}\n`);
    expect(result.out).not.toContain(`Note ${MAX_TAKEAWAYS}`);
    expect(result.out).toContain('  (takeaways truncated: count limit)\n');
    expect(result.out).toContain('S2 — Heavy\n');
    expect(result.out).toContain(`  takeaway: ${'a'.repeat(MAX_TAKEAWAY_BYTES)}\n`);
    expect(result.out).toContain('  (takeaways truncated: byte limit)\n');
    expect(result.out.indexOf('byte limit')).toBeGreaterThan(result.out.indexOf('S2 — Heavy'));
  });

  it('strips terminal control sequences from titles, URLs, takeaways and issue IDs', async () => {
    const target = file('evil.md', [
      '## S1 — Title with \x1b[31mred\x1b[0m and \u202ebidi',
      '- Checked: 2026-10-31.',
      '- Source: [x](https://example.test/x) [y](https://example.test/\x1b[9m)',
      '- Takeaway: forged \x1b[2Jclear\x07next line',
      '  still the same takeaway',
      '- Takeaway: newline in header',
      '  S99 — Not a source',
      '## S\x1b[9m — Forged issue ID',
      '- Checked: 2026-10-31.',
    ].join('\n'));
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(result.out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(result.out).toContain('S1 — Title with [31mred[0m and bidi\n');
    expect(result.out).toContain('  url: https://example.test/[9m\n');
    expect(result.out).toContain('  takeaway: forged [2Jclearnext line\n    still the same takeaway\n');
    expect(result.out).toContain('  takeaway: newline in header\n    S99 — Not a source\n');
    expect(result.out).not.toMatch(/\nS99/);
    expect(result.out).toContain('issues:\n  S[9m malformed_id\n');
  });

  it('keeps check exit codes identical between --json and --text', async () => {
    const cases: [string, string][] = [
      ['fresh', `## S1 — Fresh\n- Checked: 2026-10-31.\n- Source: [x](https://example.test/x)\n`],
      ['stale', `## S1 — Stale\n- Checked: 2026-10-01.\n- Source: [x](https://example.test/x)\n`],
      ['issues', issued],
      ['empty', ''],
    ];
    for (const [name, contents] of cases) {
      const target = file(`${name}.md`, contents);
      for (const extra of [[], ['--needs-refresh'], ['--check'], ['--check', '--needs-refresh']]) {
        const jsonRun = await run(['--file', target, '--json', ...extra]);
        const textRun = await run(['--file', target, '--text', ...extra]);
        expect(textRun.code, `${name} ${extra.join(' ')}`).toBe(jsonRun.code);
        expect(textRun.err).toBe(jsonRun.err);
      }
    }
    const missing = join(dir, 'missing.md');
    const gone = await run(['--file', missing, '--text', '--check']);
    expect(gone.code).toBe(1);
    expect(gone.out).toBe('');
  });

  it('requires exactly one output mode and rejects duplicates', async () => {
    const target = file('digest.md', fixture);
    for (const args of [
      ['--file', target],
      ['--file', target, '--json', '--text'],
      ['--file', target, '--text', '--json'],
      ['--file', target, '--text', '--text'],
      ['--file', target, '--json', '--json'],
      ['--text'],
      ['--text', '--check'],
    ]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.out).toBe('');
    }
  });

  it('keeps JSON output byte-for-byte unchanged and never fetches URLs', async () => {
    const target = file('digest.md', fixture);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const json = await run(['--file', target, '--json']);
    const text = await run(['--file', target, '--text']);
    expect(json.code).toBe(0);
    expect(json.out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(json.out);
    expect(parsed.v).toBe(1);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0].takeaways).toEqual([
      'Log traces before review.\nKeep raw commands.',
      'Prefer small digests.',
    ]);
    expect(text.out.startsWith('S1 — ')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--text');
    expect(help.out).toContain('(--json | --text)');
  });
});
