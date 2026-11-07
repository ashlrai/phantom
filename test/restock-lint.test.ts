import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_REPOS, lintRestockDocument, lintRestockLine } from '../src/core/portfolio/restock-lint.js';
import { cmdBacklogLint } from '../src/cli/backlog-lint.js';
import { cmdBacklog } from '../src/cli/backlog.js';
import { rqDigest } from '../src/core/portfolio/rq-backlog.js';

let root: string;
let reposRoot: string;
const originalHome = process.env['HOME'];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'restock-lint-'));
  process.env['HOME'] = root;
  reposRoot = join(root, 'Projects', 'ashlrai');
  for (const repo of FLEET_REPOS) mkdirSync(join(reposRoot, repo), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  rmSync(root, { recursive: true, force: true });
});

const options = () => ({ reposRoot });
const dropOf = (line: string, opts = options()) => {
  const verdict = lintRestockLine(line, 1, opts);
  if (verdict === null || 'candidate' in verdict) throw new Error(`expected a drop, got ${JSON.stringify(verdict)}`);
  return verdict.drop;
};
const acceptOf = (line: string, opts = options()) => {
  const verdict = lintRestockLine(line, 1, opts);
  if (verdict === null || 'drop' in verdict) throw new Error(`expected a candidate, got ${JSON.stringify(verdict)}`);
  return verdict.candidate;
};

describe('restock lint admission fixtures', () => {
  it('rejects a line with no concrete file path', () => {
    const drop = dropOf('- READY RQ-NOPATH-1 (P1, pool=devin, tier=mid, repo=phantom): Improve retry handling; verify with npm test');
    expect(drop.jobId).toBe('RQ-NOPATH-1');
    expect(drop.reasons).toContain('no-file-path');
  });

  it('rejects a line with no test or acceptance command', () => {
    const drop = dropOf('- READY RQ-NOACC-1 (P1, pool=devin, tier=mid, repo=phantom): Update src/core/foo.ts to handle empty input');
    expect(drop.reasons).toContain('no-test-command');
  });

  it('rejects a line depending on an unmerged reference', () => {
    const drop = dropOf('- READY RQ-DEP-1 (P1, pool=devin, tier=mid, repo=phantom, after RQ-PRIOR-9): Update src/core/foo.ts; run npm test');
    expect(drop.reasons).toContain('unlanded-dep');
  });

  it('accepts a line with a file path, verification and no pending deps', () => {
    const candidate = acceptOf('- READY RQ-GOOD-1 (P1, pool=devin, tier=mid, repo=phantom): Update src/core/foo.ts to handle retries; run npm test');
    expect(candidate.repo).toBe('phantom');
    expect(candidate.deps).toEqual([]);
    expect(candidate.escalation).toBeNull();
  });

  it('rejects repo= outside the seven fleet repositories', () => {
    mkdirSync(join(reposRoot, 'measurably'));
    const drop = dropOf('- READY RQ-BADREPO-1 (P1, pool=devin, repo=measurably): Update src/core/foo.ts; run npm test');
    expect(drop.reasons).toEqual(['bad-repo']);
    expect(dropOf('- READY RQ-BADREPO-2 (P1, pool=devin, repo=other/phantom): Update src/core/foo.ts; run npm test').reasons).toContain('bad-repo');
  });

  it('rejects a fleet repo whose ~/Projects/ashlrai/<repo> folder is missing', () => {
    rmSync(join(reposRoot, 'lexicon'), { recursive: true });
    const drop = dropOf('- READY RQ-NODIR-1 (P1, pool=devin, repo=lexicon): Update src/core/foo.ts; run npm test');
    expect(drop.reasons).toEqual(['repo-folder-missing']);
  });

  it('parses esc=devin after 1 failed attempt as an escalation, not a dependency', () => {
    for (const attrs of ['esc=devin after 1 failed attempt', 'esc=devin, after 1 failed']) {
      const candidate = acceptOf(`- READY RQ-ESC-1 (P1, pool=codex-personal, repo=phantom, ${attrs}): Update src/core/foo.ts; run npm test`);
      expect(candidate.deps).toEqual([]);
      expect(candidate.escalation).toEqual({ pool: 'devin', afterFailed: 1 });
    }
  });

  it('accepts the canonical fixture set 3-to-1 and logs every rejected line', () => {
    const text = [
      '# Router queue',
      '- READY RQ-NOPATH-1 (P1, pool=devin, repo=phantom): Improve retry handling; verify with npm test',
      '- READY RQ-NOACC-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts to handle empty input',
      '- READY RQ-DEP-1 (P1, pool=devin, repo=phantom, after RQ-PRIOR-9): Update src/core/foo.ts; run npm test',
      '- READY RQ-GOOD-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; run npm test',
      '',
    ].join('\n');
    const report = lintRestockDocument(text, options());
    expect(report.candidates).toBe(4);
    expect(report.accepted.map((candidate) => candidate.jobId)).toEqual(['RQ-GOOD-1']);
    expect(report.drops).toHaveLength(3);
    for (const drop of report.drops) {
      expect(drop.jobId).toBeTruthy();
      expect(drop.reasons.length).toBeGreaterThan(0);
      expect(drop.sha).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(drop)).not.toContain('retry handling');
    }
  });
});

describe('restock lint semantics', () => {
  it('lands deps through the document status map and the landed set', () => {
    const text = [
      '- DONE RQ-OLD-1 (pool=devin, repo=phantom): shipped earlier',
      '- CLAIMED RQ-WIP-1 (pool=devin, repo=phantom): in flight',
      '- READY RQ-NEW-1 (P1, pool=devin, repo=phantom, after RQ-OLD-1): Update src/core/foo.ts; run npm test',
      '- READY RQ-NEW-2 (P1, pool=devin, repo=phantom, after RQ-WIP-1): Update src/core/foo.ts; run npm test',
      '- READY RQ-NEW-3 (P1, pool=devin, repo=phantom, after RQ-EXT-1): Update src/core/foo.ts; run npm test',
    ].join('\n');
    const report = lintRestockDocument(text, { ...options(), landed: new Set(['RQ-EXT-1']) });
    expect(report.accepted.map((candidate) => candidate.jobId)).toEqual(['RQ-NEW-1', 'RQ-NEW-3']);
    expect(report.drops[0]).toMatchObject({ jobId: 'RQ-NEW-2', reasons: ['unlanded-dep'] });
  });

  it('checks PR dependencies against merged evidence', () => {
    const url = 'https://github.com/ashlrai/locus/pull/42';
    const line = `- READY RQ-PR-1 (P1, pool=devin, repo=phantom, after ${url}): Update src/core/foo.ts; run npm test`;
    expect(dropOf(line).reasons).toContain('unlanded-dep');
    acceptOf(line, { ...options(), landed: new Set([url]) });
    acceptOf(line, { ...options(), landed: new Set(['ashlrai/locus/pull/42']) });
    acceptOf(line, { ...options(), landed: new Set(['locus#42']) });
    const bare = acceptOf('- READY RQ-PR-2 (P1, pool=devin, repo=phantom, depends=PR#42): Update src/core/foo.ts; run npm test',
      { ...options(), landed: new Set(['phantom#42']) });
    expect(bare.deps).toEqual(['pr:phantom#42']);
    acceptOf('- READY RQ-PR-3 (P1, pool=devin, repo=phantom, depends=#7): Update src/core/foo.ts; run npm test',
      { ...options(), landed: new Set(['#7']) });
  });

  it('expands -X sibling deps and flags malformed dependency tokens', () => {
    const candidate = acceptOf('- READY RQ-FAM-1-B (P1, pool=devin, repo=phantom, after -A): Update src/core/foo.ts; run npm test',
      { ...options(), landed: new Set(['RQ-FAM-1-A']) });
    expect(candidate.deps).toEqual(['RQ-FAM-1-A']);
    expect(dropOf('- READY RQ-FAM-2 (P1, pool=devin, repo=phantom, after -A): Update src/core/foo.ts; run npm test').reasons)
      .toContain('bad-dep');
    expect(dropOf('- READY RQ-FAM-3 (P1, pool=devin, repo=phantom, after not a dep!): Update src/core/foo.ts; run npm test').reasons)
      .toContain('bad-dep');
  });

  it('applies identity, duplicate, protected-path and pool rules', () => {
    expect(dropOf('- READY rq-lower-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; run npm test').reasons).toContain('bad-id');
    const text = [
      '- READY RQ-DUP-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; run npm test',
      '- READY RQ-DUP-1 (P1, pool=devin, repo=phantom): Update src/core/bar.ts; run npm test',
      '- READY RQ-GH-1 (P1, pool=devin, repo=phantom): Update .github/workflows/ci.yml; run npm test',
      '- READY RQ-GH-2 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; do not touch .github/; run npm test',
      '- READY RQ-POOL-1 (P1, pool=bogus-lane, repo=phantom): Update src/core/foo.ts; run npm test',
    ].join('\n');
    const report = lintRestockDocument(text, { ...options(), pools: new Set(['devin', 'codex-personal']) });
    expect(report.accepted.map((candidate) => candidate.jobId)).toEqual(['RQ-DUP-1', 'RQ-GH-2']);
    expect(report.drops.map((drop) => [drop.jobId, drop.reasons[0]])).toEqual([
      ['RQ-DUP-1', 'dup-line'], ['RQ-GH-1', 'github-protected'], ['RQ-POOL-1', 'unknown-pool'],
    ]);
  });

  it('drops unparseable READY lines and ignores non-READY records', () => {
    const text = [
      '# Router queue',
      'Freeform operator note.',
      '- BLOCKED RQ-BLOCKED-1 (pool=devin, repo=phantom): not a candidate',
      '- READY RQ-MISSING-PARENS repo=phantom: no attr block',
      '- READY RQ-NOREPO-1 (P1, pool=devin): Update src/core/foo.ts; run npm test',
    ].join('\n');
    const report = lintRestockDocument(text, options());
    expect(report.candidates).toBe(2);
    expect(report.drops.map((drop) => drop.reasons)).toEqual([['unparseable'], ['no-repo']]);
  });

  it('accepts repo= forms, LAND-id fallback and broad path/verification shapes', () => {
    acceptOf('- READY RQ-ALT-1 (P1, pool=devin, repo=ashlrai/locus): Update locus/core/src/lib.rs; run cargo test');
    acceptOf('- READY LAND-lexicon-3 (P1, pool=devin): Update docs/README.md; Acceptance: npm run check:docs');
    acceptOf('- READY RQ-ALT-2 (P1, pool=devin, repo=ashlr-md): Fix dispatchd.py:595 logging; tests: pytest test_disk.py');
    expect(dropOf('- READY RQ-ALT-3 (P1, pool=devin, repo=phantom): Update queue.v1 handling; run npm test').reasons)
      .toContain('no-file-path');
  });
});

describe('backlog lint CLI', () => {
  const files: string[] = [];
  const make = (name: string, text: string): string => {
    const path = join(root, name);
    files.push(path);
    writeFileSync(path, text);
    return path;
  };
  async function capture(args: string[]) {
    let out = '';
    const logs: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    vi.spyOn(console, 'error').mockImplementation((message) => { logs.push(String(message)); });
    vi.spyOn(console, 'log').mockImplementation((message) => { out += String(message) + '\n'; });
    const code = args[0] === 'lint' ? await cmdBacklog(['lint', ...args.slice(1)]) : await cmdBacklogLint(args);
    return { code, out, logs: logs.map((line) => JSON.parse(line)) };
  }

  const fixture = () => make('router-queue.md', [
    '# Router queue',
    '- READY RQ-NOPATH-1 (P1, pool=devin, repo=phantom): Improve retry handling; verify with npm test',
    '- READY RQ-NOACC-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts to handle empty input',
    '- READY RQ-DEP-1 (P1, pool=devin, repo=phantom, after RQ-PRIOR-9): Update src/core/foo.ts; run npm test',
    '- READY RQ-BADREPO-1 (P1, pool=devin, repo=measurably): Update src/core/foo.ts; run npm test',
    '- READY RQ-ESC-1 (P1, pool=devin, repo=phantom, esc=devin after 1 failed attempt): Update src/core/foo.ts; run npm test',
    '- READY RQ-GOOD-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; run npm test',
    '',
  ].join('\n'));

  it('emits one logged drop event per rejected line and only accepted lines on stdout', async () => {
    const queue = fixture();
    const run = await capture(['--queue', queue]);
    expect(run.code).toBe(1);
    const events = run.logs.map((log) => log.event);
    expect(events.filter((event) => event === 'rq-lint-drop')).toHaveLength(4);
    expect(events.at(-1)).toBe('rq-lint');
    expect(run.logs.at(-1)).toMatchObject({ candidates: 6, accepted: 2, dropped: 4, queueSha: rqDigest(readFileSync(queue, 'utf8')) });
    expect(run.logs.slice(0, 4).map((log) => [log.job, log.reasons[0]])).toEqual([
      ['RQ-NOPATH-1', 'no-file-path'], ['RQ-NOACC-1', 'no-test-command'], ['RQ-DEP-1', 'unlanded-dep'], ['RQ-BADREPO-1', 'bad-repo'],
    ]);
    const admitted = run.out.split('\n').filter(Boolean);
    expect(admitted).toHaveLength(2);
    expect(admitted.join('\n')).toContain('RQ-ESC-1');
    expect(admitted.join('\n')).toContain('RQ-GOOD-1');
  });

  it('honours --landed and reports a structured --json result', async () => {
    const queue = fixture();
    const landed = make('landed.txt', 'RQ-PRIOR-9\n');
    const run = await capture(['--queue', queue, '--landed', landed, '--json']);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.out);
    expect(report.v).toBe(1);
    expect(report.accepted.map((row: { job: string }) => row.job)).toEqual(['RQ-DEP-1', 'RQ-ESC-1', 'RQ-GOOD-1']);
    expect(report.drops).toHaveLength(3);
    expect(run.logs.filter((log) => log.event === 'rq-lint-drop')).toHaveLength(3);
  });

  it('exits 0 when every candidate is admitted and honours --repos-root', async () => {
    const queue = make('clean.md', '- READY RQ-GOOD-1 (P1, pool=devin, repo=phantom): Update src/core/foo.ts; run npm test\n');
    expect((await capture(['--queue', queue])).code).toBe(0);
    const run = await capture(['--queue', queue, '--repos-root', join(root, 'empty-root')]);
    expect(run.code).toBe(1);
    expect(run.logs[0]).toMatchObject({ event: 'rq-lint-drop', reasons: ['repo-folder-missing'] });
  });

  it.each([[], ['--landed', 'x'], ['--queue'], ['--queue', 'a', '--queue', 'b'], ['--bogus', 'x'], ['--queue', '--landed', 'x']].map((args) => ({ args })))('rejects bad flags $args', async ({ args }) => {
    const run = await capture(args);
    expect(run.code).toBe(2);
    expect(run.out).toBe('');
  });

  it('fails closed on a missing queue and shows help without reading', async () => {
    expect((await capture(['--queue', join(root, 'absent.md')])).code).toBe(2);
    const run = await capture(['lint', '--help']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('--queue');
    expect(run.logs).toEqual([]);
  });
});
