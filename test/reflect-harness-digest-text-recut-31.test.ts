import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';

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
- Takeaway: Gate on evals.

## S3 — Watch boundaries
- Source: [y](https://example.test/y)
- Takeaway: Watch the boundaries.
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-digest-text-recut-'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:36:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
function digest(sourceCount: number, takeawaysPerSource: number): string {
  return Array.from({ length: sourceCount }, (_, s) =>
    `## S${s + 1} — Section ${s + 1}\n- Checked: 2026-10-31.\n- Source: [x](https://example.test/${s + 1})\n` +
    Array.from({ length: takeawaysPerSource }, (_, i) => `- Takeaway: S${s + 1} note ${i}`).join('\n'),
  ).join('\n');
}

describe('reflect harness-digest --text', () => {
  it('renders one line per takeaway with its source ID and checked date', async () => {
    const target = file('digest.md', fixture);
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(`S1 2026-10-24 Log traces before review. Keep raw commands.
S1 2026-10-24 Prefer small digests.
S2 2026-10-23 Gate on evals.
S3 undated Watch the boundaries.
`);
    // eslint-disable-next-line no-control-regex
    expect(result.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it('keeps the --json output byte-identical', async () => {
    const target = file('digest.md', fixture);
    const result = await run(['--file', target, '--json']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(JSON.stringify({
      v: 1,
      sources: [
        {
          id: 'S1', title: 'Trace capture patterns', checkedAt: '2026-10-24',
          urls: ['https://example.test/alpha', 'https://example.test/beta'], stale: false,
          takeaways: ['Log traces before review.\nKeep raw commands.', 'Prefer small digests.'],
        },
        {
          id: 'S2', title: 'Evaluation loop', checkedAt: '2026-10-23',
          urls: ['https://research.example.test/eval'], stale: true,
          takeaways: ['Gate on evals.'],
        },
        {
          id: 'S3', title: 'Watch boundaries', checkedAt: null,
          urls: ['https://example.test/y'], stale: null,
          takeaways: ['Watch the boundaries.'],
        },
      ],
      issues: [{ id: 'S3', code: 'missing_checked' }],
    }) + '\n');
  });

  it('bounds text output to 200 lines with a trailing count of elided takeaways', async () => {
    const target = file('big.md', digest(11, 20)); // 220 takeaways.
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    const lines = result.out.split('\n').slice(0, -1);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('S1 2026-10-31 S1 note 0');
    expect(lines[198]).toBe('S10 2026-10-31 S10 note 18');
    expect(lines[199]).toBe('(+21 more takeaways)');
    expect(result.out).not.toContain('S11');
  });

  it('renders exactly 200 takeaway lines without a count line', async () => {
    const target = file('exact.md', digest(10, 20)); // 200 takeaways.
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    const lines = result.out.split('\n').slice(0, -1);
    expect(lines).toHaveLength(200);
    expect(lines[199]).toBe('S10 2026-10-31 S10 note 19');
  });

  it('prints (no takeaways) when the selection has none', async () => {
    const target = file('empty.md', '## S1 — Citation only\n- Checked: 2026-10-31.\n- Source: [x](https://example.test/x)\n');
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    expect(result.out).toBe('(no takeaways)\n');
    const blank = await run(['--file', file('blank.md', ''), '--text']);
    expect(blank.code).toBe(0);
    expect(blank.out).toBe('(no takeaways)\n');
  });

  it('requires exactly one output mode', async () => {
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

  it('respects --source, --query and --needs-refresh selections', async () => {
    const target = file('digest.md', fixture);
    const selected = await run(['--file', target, '--text', '--source', 'S1']);
    expect(selected.out).toBe(`S1 2026-10-24 Log traces before review. Keep raw commands.
S1 2026-10-24 Prefer small digests.
`);
    const queried = await run(['--file', target, '--text', '--query', 'gate']);
    expect(queried.out).toBe('S2 2026-10-23 Gate on evals.\n');
    const refresh = await run(['--file', target, '--text', '--needs-refresh', '--with-takeaways']);
    expect(refresh.out).toBe(`S2 2026-10-23 Gate on evals.
S3 undated Watch the boundaries.
`);
  });

  it('keeps --check exit codes identical between --json and --text', async () => {
    const cases: [string, string][] = [
      ['fresh', `## S1 — Fresh\n- Checked: 2026-10-31.\n- Source: [x](https://example.test/x)\n- Takeaway: Go.\n`],
      ['stale', `## S1 — Stale\n- Checked: 2026-10-01.\n- Source: [x](https://example.test/x)\n- Takeaway: Go.\n`],
      ['issues', fixture],
      ['empty', ''],
    ];
    for (const [name, contents] of cases) {
      const target = file(`${name}.md`, contents);
      for (const extra of [[], ['--check'], ['--needs-refresh'], ['--check', '--needs-refresh']]) {
        const jsonRun = await run(['--file', target, '--json', ...extra]);
        const textRun = await run(['--file', target, '--text', ...extra]);
        expect(textRun.code, `${name} ${extra.join(' ')}`).toBe(jsonRun.code);
        expect(textRun.err).toBe(jsonRun.err);
      }
    }
  });

  it('strips terminal control characters from untrusted takeaway text', async () => {
    const target = file('evil.md', [
      '## S1 — Tricky',
      '- Checked: 2026-10-31.',
      '- Source: [x](https://example.test/x)',
      '- Takeaway: forged \x1b[2Jclear\x07next line \u202ebidi\u202c',
      '  S99 — Not a source',
    ].join('\n'));
    const result = await run(['--file', target, '--text']);
    expect(result.code).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(result.out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(result.out).toBe('S1 2026-10-31 forged [2Jclearnext line bidi S99 \u2014 Not a source\n');
  });

  it('colors the date by freshness only when stdout is a TTY', async () => {
    const target = file('digest.md', fixture);
    const isTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    vi.stubEnv('NO_COLOR', '');
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const tty = await run(['--file', target, '--text']);
      expect(tty.out).toContain('\x1b[');
      expect(tty.out).toContain('\x1b[31m2026-10-23\x1b[0m'); // stale: red
      expect(tty.out).toContain('\x1b[33mundated\x1b[0m'); // undated: yellow
    } finally {
      if (isTty) Object.defineProperty(process.stdout, 'isTTY', isTty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
    const piped = await run(['--file', target, '--text']);
    expect(piped.out).not.toContain('\x1b');
  });

  it('lists --text beside --json in help', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('(--json | --text)');
    expect(help.out).toContain('--text');
  });
});
