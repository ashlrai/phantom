import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error standalone Node verifier has no declaration output.
import {
  collectSkips,
  LEDGER_PATH,
  main,
  NON_QUARANTINABLE,
  parseLedger,
  parseUnifiedDiff,
  verifyQuarantine,
} from '../scripts/check-quarantine-ledger.mjs';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const REPO = 'ashlrai/phantom';
const HEADER = 'test\trepo\tlead\texpiry\n';
const row = (test: string, expiry = '2026-10-31', repo = REPO, lead = 'CI-Efficiency') =>
  `${test}\t${repo}\t${lead}\t${expiry}\n`;
const ledger = (...rows: string[]) => HEADER + rows.join('');
const reader = (files: Record<string, string | null>) => (path: string) => files[path] ?? null;

/** A `git diff` fragment for one file; `lines` are raw +/-/space lines per hunk. */
function diffFor(file: string, ...hunks: Array<{ at: number; lines: string[] }>): string {
  const body = hunks
    .map((h) => `@@ -1,1 +${h.at},${h.lines.filter((l) => !l.startsWith('-')).length} @@\n${h.lines.join('\n')}`)
    .join('\n');
  return `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n${body}\n`;
}
const newFileDiff = (file: string, lines: string[]) =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;

const verify = (options: Record<string, unknown>) =>
  verifyQuarantine({ now: NOW, repo: REPO, ledgerText: HEADER, readFile: () => null, ...options });
const codes = (result: { violations: Array<{ code: string }> }) => result.violations.map((v) => v.code).sort();

const FLAKY = 'test/flaky.test.ts';
const FLAKY_AFTER = [
  "import { it } from 'vitest';",
  '',
  "describe('suite', () => {",
  "  it('alpha', () => {});",
  "  it.skip('beta', () => {});",
  '});',
  '',
].join('\n');
/** `it('beta'` -> `it.skip('beta'` on line 5. */
const SKIP_BETA = diffFor(FLAKY, { at: 5, lines: ["-  it('beta', () => {});", "+  it.skip('beta', () => {});"] });
const files = { [FLAKY]: FLAKY_AFTER };

describe('quarantine ledger verifier', () => {
  // --- Acceptance: the three required behaviours -----------------------------

  it('passes a tracked skip whose ledger row is live', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader(files) });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.markers).toEqual([{ file: FLAKY, line: 5, kind: 'skip', name: 'suite > beta', status: 'tracked' }]);
  });

  it('also passes with a whole-file ledger row', () => {
    expect(verify({ diffText: SKIP_BETA, ledgerText: ledger(row(FLAKY)), readFile: reader(files) }).ok).toBe(true);
  });

  it('fails an untracked skip', () => {
    const result = verify({ diffText: SKIP_BETA, readFile: reader(files) });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['untracked-skip']);
    expect(result.violations[0].message).toContain('suite > beta');
  });

  it('fails an expired skip', () => {
    const result = verify({
      diffText: SKIP_BETA,
      ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-10-20')),
      readFile: reader(files),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['expired-row', 'expired-skip']);
  });

  // --- Coverage rules ----------------------------------------------------------

  it('rejects a row that expires beyond the 7-day window, leaving the skip untracked', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-11-10')), readFile: reader(files) });
    expect(codes(result)).toEqual(['invalid-row', 'untracked-skip']);
  });

  it('accepts date-only expiry exactly 7 days out and ISO datetimes inside the window', () => {
    const dated = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-11-04')), readFile: reader(files) });
    expect(dated.ok).toBe(true);
    const timed = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-11-01T00:00:00Z')), readFile: reader(files) });
    expect(timed.ok).toBe(true);
    const tooFar = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-11-05T00:00:01Z')), readFile: reader(files) });
    expect(codes(tooFar)).toEqual(['invalid-row', 'untracked-skip']);
  });

  it('treats a date-only expiry of today as already lapsed', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-10-28')), readFile: reader(files) });
    expect(codes(result)).toEqual(['expired-row', 'expired-skip']);
  });

  it('ignores rows for other repos when covering a skip, without flagging them stale', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`, '2026-10-31', 'ashlrai/lexicon')), readFile: reader(files) });
    expect(codes(result)).toEqual(['untracked-skip']);
  });

  it('requires the row to name the marker, not a different test', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > alpha`)), readFile: reader(files) });
    expect(codes(result)).toEqual(['stale-row', 'untracked-skip']);
  });

  // --- "only additions" --------------------------------------------------------

  it('fails a born-disabled test even when a row names it: the skip is only an addition', () => {
    const after = FLAKY_AFTER.replace("  it.skip('beta', () => {});", "  it.skip('new', () => {});\n  it('beta', () => {});");
    const diff = diffFor(FLAKY, { at: 5, lines: ['+  it.skip(\'new\', () => {});'] });
    const result = verify({ diffText: diff, ledgerText: ledger(row(`${FLAKY} > suite > new`)), readFile: reader({ [FLAKY]: after }) });
    expect(codes(result)).toEqual(['addition-only-skip']);
  });

  it('fails every marker in a newly added test file', () => {
    const added = "import { it } from 'vitest';\nit.skip('fresh', () => {});\n";
    const result = verify({ diffText: newFileDiff('test/new.test.ts', added.split('\n').slice(0, -1)), ledgerText: ledger(row('test/new.test.ts')), readFile: reader({ 'test/new.test.ts': added }) });
    expect(codes(result)).toEqual(['addition-only-skip']);
  });

  it('fails ledger rows added for nothing: a diff of only additions', () => {
    const diff = diffFor(LEDGER_PATH, { at: 2, lines: [`+${row('test/other.test.ts > gone', '2026-10-31').trim()}`] });
    const result = verify({ diffText: diff, ledgerText: ledger(row('test/other.test.ts > gone')), readFile: reader({ 'test/other.test.ts': "it('ok', () => {});\n" }) });
    expect(codes(result)).toEqual(['only-additions']);
  });

  it('lets a renewed row added in the diff cover a still-present skip', () => {
    // The marker was committed earlier and is untouched by this diff; the row
    // is deleted and re-added in the same change (a lease renewal).
    const diff = diffFor(LEDGER_PATH, { at: 2, lines: [`-${row(`${FLAKY} > suite > beta`, '2026-10-21').trim()}`, `+${row(`${FLAKY} > suite > beta`).trim()}`] });
    const result = verify({ diffText: diff, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader(files) });
    expect(result.ok).toBe(true);
  });

  it('flags a pre-existing row once its marker is gone (no coupon reuse)', () => {
    const unskip = diffFor(FLAKY, { at: 5, lines: ["-  it.skip('beta', () => {});", "+  it('beta', () => {});"] });
    const after = FLAKY_AFTER.replace("it.skip('beta'", "it('beta'");
    const result = verify({ diffText: unskip, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader({ [FLAKY]: after }) });
    expect(codes(result)).toEqual(['stale-row']);
  });

  it('passes when unskip and row removal land together', () => {
    const unskip = diffFor(FLAKY, { at: 5, lines: ["-  it.skip('beta', () => {});", "+  it('beta', () => {});"] });
    const after = FLAKY_AFTER.replace("it.skip('beta'", "it('beta'");
    expect(verify({ diffText: unskip, ledgerText: HEADER, readFile: reader({ [FLAKY]: after }) }).ok).toBe(true);
  });

  // --- Marker kinds -------------------------------------------------------------

  it.each([
    ["xit('beta'", 'skip'],
    ["it.todo('beta'", 'todo'],
    ["it.skipIf(process.env.CI)('beta'", 'skip'],
  ])('treats %s as a conversion needing a row', (replacement, kind) => {
    const after = FLAKY_AFTER.replace("it.skip('beta'", replacement);
    const diff = diffFor(FLAKY, { at: 5, lines: ["-  it('beta', () => {});", `+  ${replacement}, () => {});`] });
    const covered = verify({ diffText: diff, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader({ [FLAKY]: after }) });
    expect(covered.ok).toBe(true);
    expect(covered.markers[0].kind).toBe(kind);
  });

  it('covers a converted describe.skip with a suite-level row', () => {
    const after = FLAKY_AFTER.replace("describe('suite'", "describe.skip('suite'");
    const diff = diffFor(FLAKY, { at: 3, lines: ["-describe('suite', () => {", "+describe.skip('suite', () => {"] });
    const result = verify({ diffText: diff, ledgerText: ledger(row(`${FLAKY} > suite`)), readFile: reader({ [FLAKY]: after }) });
    expect(result.ok).toBe(true);
    expect(result.markers[0]).toMatchObject({ name: 'suite', status: 'tracked' });
  });

  it('fails an added .only unconditionally', () => {
    const after = FLAKY_AFTER.replace("it.skip('beta'", "it.only('beta'");
    const diff = diffFor(FLAKY, { at: 5, lines: ["-  it('beta', () => {});", "+  it.only('beta', () => {});"] });
    const result = verify({ diffText: diff, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader({ [FLAKY]: after }) });
    expect(codes(result)).toEqual(['focused-test']);
  });

  it('fails a skip whose title is not a literal', () => {
    const after = FLAKY_AFTER.replace("it.skip('beta'", 'it.skip(name)');
    const diff = diffFor(FLAKY, { at: 5, lines: ["-  it('beta', () => {});", '+  it.skip(name, () => {});'] });
    const result = verify({ diffText: diff, readFile: reader({ [FLAKY]: after }) });
    expect(codes(result)).toEqual(['dynamic-title']);
  });

  // --- Security R8: non-quarantinable checks -------------------------------------

  it.each(['secret-shape', 'gitleaks', 'cargo-deny', 'ci-gate'])('refuses to quarantine %s', (check) => {
    const file = `test/${check}-boundary.test.ts`;
    const after = `it.skip('x', () => {});\n`;
    const diff = diffFor(file, { at: 1, lines: ["-it('x', () => {});", "+it.skip('x', () => {});"] });
    const result = verify({ diffText: diff, ledgerText: ledger(row(`${file} > x`)), readFile: reader({ [file]: after }) });
    expect(codes(result)).toEqual(['non-quarantinable', 'non-quarantinable']);
    expect(result.violations.every((v) => v.code === 'non-quarantinable')).toBe(true);
  });

  it('refuses a ledger row that names a protected check', () => {
    const result = verify({ diffText: null, ledgerText: ledger(row('CI Gate')), readFile: reader({}) });
    expect(codes(result)).toEqual(['non-quarantinable']);
  });

  it('names the enforced protected set', () => {
    expect(NON_QUARANTINABLE).toEqual(['secret-shape', 'gitleaks', 'cargo-deny', 'ci-gate']);
  });

  // --- Ledger hygiene ------------------------------------------------------------

  it.each([
    ['fewer than four fields', `${FLAKY} > beta\t${REPO}\tCI-Efficiency\n`],
    ['empty lead', `${FLAKY} > beta\t${REPO}\t\t2026-10-31\n`],
    ['unparseable expiry', `${FLAKY} > beta\t${REPO}\tCI-Efficiency\tsomeday\n`],
    ['bad repo shape', `${FLAKY} > beta\tphantom\tCI-Efficiency\t2026-10-31\n`],
    ['escaping path', `../x.test.ts\t${REPO}\tCI-Efficiency\t2026-10-31\n`],
    ['duplicate rows', `${FLAKY} > suite > beta\t${REPO}\tCI-Efficiency\t2026-10-31\n${FLAKY} > suite > beta\t${REPO}\tOps\t2026-10-31\n`],
  ])('rejects a row with %s', (_label, body) => {
    const result = verify({ diffText: null, ledgerText: ledger(body), readFile: reader(files) });
    expect(result.violations.every((v) => v.code === 'invalid-row')).toBe(true);
  });

  it('rejects a ledger with no header row', () => {
    const result = verify({ diffText: null, ledgerText: `${row(`${FLAKY} > suite > beta`)}`, readFile: reader(files) });
    expect(codes(result)).toEqual(['invalid-ledger']);
  });

  it('skips comment and blank lines in the ledger', () => {
    const text = `# comment\n\n${HEADER}   \n${row(`${FLAKY} > suite > beta`)}`;
    expect(verify({ diffText: SKIP_BETA, ledgerText: text, readFile: reader(files) }).ok).toBe(true);
  });

  it('fails closed when a changed test file cannot be read', () => {
    const result = verify({ diffText: SKIP_BETA, ledgerText: ledger(row(`${FLAKY} > suite > beta`)), readFile: reader({}) });
    expect(codes(result)).toEqual(['stale-row', 'unverifiable-skip']);
  });

  it('passes an empty ledger when no markers are added', () => {
    expect(verify({ diffText: diffFor('src/core/git.ts', { at: 1, lines: ['-a', '+b'] }), readFile: reader({}) }).ok).toBe(true);
  });
});

// --- Unit-level contracts --------------------------------------------------------

describe('collectSkips', () => {
  const scan = (source: string) => collectSkips('test/x.test.ts', source);

  it('finds full names through nested describes and each chains', () => {
    const found = scan([
      "describe('outer', () => {",
      "  describe.each([1, 2])('part %d', () => {",
      "    it.each(['a'])('works on %s', () => {});",
      "    it.each(['a']).skip('skips on %s', () => {});",
      '  });',
      '});',
    ].join('\n'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'skip', title: 'skips on %s', full: 'outer > part %d > skips on %s' });
  });

  it('flags xdescribe/xit and it.skipIf but not plain calls or .runIf', () => {
    const found = scan([
      "xdescribe('dead', () => {});",
      "it.skipIf(false)('cond', () => {});",
      "it.runIf(true)('not a skip', () => {});",
      "it('plain', () => {});",
      "xit('legacy', () => {});",
    ].join('\n'));
    expect(found.map((m) => `${m.kind}:${m.title}`)).toEqual(['skip:dead', 'skip:cond', 'skip:legacy']);
  });

  it('ignores markers inside comments and strings', () => {
    const found = scan(["// it.skip('commented', () => {});", "const s = \"describe.skip('x')\";", "it('real', () => {});"].join('\n'));
    expect(found).toEqual([]);
  });

  it('reports non-literal titles without a title', () => {
    expect(scan("it.skip(buildName(), () => {});")[0]).toMatchObject({ kind: 'skip', title: null, literal: null });
  });
});

describe('parseUnifiedDiff', () => {
  it('tracks new-side line numbers across hunks, new files and deletions', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/a.test.ts b/a.test.ts',
      '--- a/a.test.ts',
      '+++ b/a.test.ts',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-old',
      '+new',
      '@@ -10,1 +12,1 @@',
      '-old2',
      '+new2',
      'diff --git a/b.test.ts b/b.test.ts',
      '--- /dev/null',
      '+++ b/b.test.ts',
      '@@ -0,0 +1,1 @@',
      '+born',
      'diff --git a/c.test.ts b/c.test.ts',
      '--- a/c.test.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-gone',
    ].join('\n'));
    const a = parsed.get('a.test.ts');
    expect([...a.addedLines].sort((x, y) => x - y)).toEqual([2, 12]);
    expect(a.removedText).toEqual(['old', 'old2']);
    expect(parsed.get('b.test.ts').isNew).toBe(true);
    expect(parsed.get('c.test.ts').isDeleted).toBe(true);
  });
});

describe('parseLedger', () => {
  it('classifies valid, expired and invalid rows', () => {
    const { rows } = parseLedger(ledger(
      row('a.test.ts', '2026-10-31'),
      row('b.test.ts', '2026-10-01'),
      row('c.test.ts', 'bogus'),
    ), { now: NOW });
    expect(rows.map((r) => r.state)).toEqual(['valid', 'expired', 'invalid']);
  });
});

// --- End to end: the CLI over a scratch checkout ---------------------------------

describe('check-quarantine-ledger CLI', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function checkout(filesToWrite: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-quarantine-'));
    roots.push(root);
    for (const [path, content] of Object.entries(filesToWrite)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line), out, err };
  };

  it('verifies a stored diff against the ledger in the checkout', () => {
    const cwd = checkout({
      [LEDGER_PATH]: ledger(row(`${FLAKY} > suite > beta`)),
      [FLAKY]: FLAKY_AFTER,
      'change.diff': SKIP_BETA,
    });
    const capture = io();
    expect(main(['--diff', 'change.diff'], { cwd, now: NOW, ...capture })).toBe(0);
    expect(capture.out.join('\n')).toContain('0 violation(s)');
    expect(capture.err).toEqual([]);
  });

  it('exits 1 and reports violations for an untracked skip', () => {
    const cwd = checkout({ [LEDGER_PATH]: HEADER, [FLAKY]: FLAKY_AFTER, 'change.diff': SKIP_BETA });
    const capture = io();
    expect(main(['--diff', 'change.diff'], { cwd, now: NOW, ...capture })).toBe(1);
    expect(capture.err.join('\n')).toContain('untracked-skip');
    expect(capture.err.join('\n')).toContain('suite > beta');
  });

  it('validates the ledger alone with no diff and emits --json', () => {
    const cwd = checkout({ [LEDGER_PATH]: ledger(row('test/gone.test.ts')), 'test/gone.test.ts': "it('x', () => {});\n" });
    const capture = io();
    expect(main(['--json'], { cwd, now: NOW, ...capture })).toBe(1);
    const parsed = JSON.parse(capture.out.join('\n'));
    expect(parsed.ok).toBe(false);
    expect(parsed.violations.map((v: { code: string }) => v.code)).toEqual(['stale-row']);
  });

  it('prints usage and exits 2 on a bad argument', () => {
    const capture = io();
    expect(main(['--help'], { cwd: checkout({}), now: NOW, ...capture })).toBe(0);
    expect(capture.out.join('\n')).toContain('--base');
    expect(() => main(['--bogus'], { cwd: checkout({}), now: NOW, ...io() })).toThrow();
  });
});
