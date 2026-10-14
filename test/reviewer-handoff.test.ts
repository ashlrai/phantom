import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { collectReviewerHandoff, parseReviewerHandoffArgs, readBoundedReport, renderReviewerHandoff, summarizeTestEvidence } from '../scripts/reviewer-handoff.js';

const roots: string[] = [];
// Real subprocess fixtures belong in the real-io lane without inheriting its longer deadline.
vi.setConfig({ testTimeout: 5000, hookTimeout: 5000 });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phantom-review-handoff-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'maintenance.auto', 'false'); git('config', 'gc.auto', '0');
  const put = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  put('package.json', JSON.stringify({ name: '@ashlr/phantom', version: '1.0.0' }));
  put('.github/CODEOWNERS', '/src/core/** @source-owner\n/src/web-ui/** @ui-owner\n');
  put('scripts/gate-smoke.json', JSON.stringify({ backend: [{ file: 'test/smoke.test.ts' }], web: [{ file: 'src/web-ui/smoke.test.tsx' }] }));
  const commit = () => { git('add', '-A'); git('-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'absent-hooks')}`, 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); return { root, git, put, commit, base };
}
function serializedReport() {
  return { success: true, numFailedTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
    testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }] }] };
}
function snapshot(root: string): string {
  const rows: unknown[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name); const stat = lstatSync(path);
      rows.push([path.slice(root.length), stat.mode, stat.size, stat.mtimeMs, stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null]);
      if (stat.isDirectory()) walk(path);
    }
  }; walk(root); return JSON.stringify(rows);
}

describe('local reviewer handoff', () => {
  it.each([
    { name: 'release planner', script: 'ecosystem-release-plan.ts', reader: 'localJson', reason: 'Changed local snapshot' },
    { name: 'reviewer handoff', script: 'reviewer-handoff.ts', reader: 'evidence', reason: 'Evidence reference changed' },
  ])('$name refuses post-stat nonregular replacement without blocking or reading', ({ script, reader, reason }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-advisory-fifo-'))); roots.push(root);
    const target = join(root, 'report.json'); writeFileSync(target, '{}');
    const source = join(import.meta.dirname, '../scripts', script);
    // Expose the actual private reader only in a fixture module. Git planning
    // remains covered by the complete handoff tests, outside this FIFO window.
    const subject = readFileSync(source, 'utf8').replace(/from '(\.\.?\/[^']+)'/g, (_match, path: string) =>
      `from ${JSON.stringify(pathToFileURL(resolve(dirname(source), path.replace(/\.js$/, '.ts'))).href)}`)
      + `\nexport { ${reader} as fixtureReader };\n`;
    const compiled = ts.transpileModule(subject, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const readerPath = join(root, 'reader-fixture.mjs'); writeFileSync(readerPath, compiled);
    const program = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(target)}, root = ${JSON.stringify(root)};
let swapped = false, targetFd = null, targetReads = 0;
const stat = fs.lstatSync, open = fs.openSync, read = fs.readSync;
fs.lstatSync = (...args) => {
  const before = stat(...args);
  if (!swapped && args[0] === target) {
    fs.unlinkSync(target);
    if (process.platform === 'win32') fs.mkdirSync(target);
    else execFileSync('mkfifo', ['-m', '600', target]);
    swapped = true; fs.writeSync(2, 'nonregular-installed\\n');
  }
  return before;
};
fs.openSync = (...args) => { const fd = open(...args); if (args[0] === target) targetFd = fd; return fd; };
fs.readSync = (...args) => { if (args[0] === targetFd) targetReads++; return read(...args); };
syncBuiltinESMExports();
const { fixtureReader } = await import(${JSON.stringify(pathToFileURL(readerPath).href)});
try { fixtureReader(${reader === 'localJson' ? 'target' : "root, target, 'a'.repeat(40), 'b'.repeat(40)"}); process.exitCode = 2; }
catch (error) {
  const installed = swapped && stat(target);
  const windowsDirectoryRefusal = process.platform === 'win32' && swapped && installed.isDirectory() && !installed.isSymbolicLink() &&
    ['EISDIR', 'EPERM'].includes(error.code) && error.syscall === 'open' && error.path === target;
  if (!swapped || targetReads !== 0 || !(error.message.includes(${JSON.stringify(reason)}) || windowsDirectoryRefusal)) process.exitCode = 3;
  else process.stdout.write('nonregular-refused');
}
`;
    // Use private files rather than embedding a whole module in Windows' bounded argv.
    const probePath = join(root, 'reader-probe.mjs'); writeFileSync(probePath, program);
    const args = ['--import', join(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'), probePath];
    // Conservative UTF-16 quoting bound: each character can escape at most once.
    expect([process.execPath, ...args].reduce((count, arg) => count + 2 * arg.length + 3, 1)).toBeLessThan(32767);
    const result = spawnSync(process.execPath, args,
      { cwd: root, encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    expect(result.stderr).toBe('nonregular-installed\n'); expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('nonregular-refused');
  });

  it('binds exact source and reuses existing owner-lane rules without executing checks', () => {
    const f = fixture();
    f.put('src/core/resources/native-profile.ts', 'export const changed = true;');
    f.put('src/core/resources/billing.ts', 'export const dollars = 0;');
    f.put('src/web-ui/regular.tsx', 'export const display = true;');
    const head = f.commit(); const before = snapshot(f.root);
    const report = collectReviewerHandoff({ root: f.root, base: f.base, head });
    expect(snapshot(f.root)).toBe(before);
    expect(report.source).toMatchObject({ base: f.base, head, currentHead: head, dirtyExcluded: false });
    expect(report.checksExecuted).toBe(false); expect(report.releaseAdmission).toBe(false);
    const identity = report.changedPaths.find((row) => row.path.endsWith('native-profile.ts'))!;
    expect(identity.existingOwnerLane?.ruleId).toBe('tier1-authority-code');
    expect(identity.reviewFocus).toEqual(expect.arrayContaining(['authority', 'identity', 'filesystem']));
    expect(identity.codeownersAfter).toEqual(['@source-owner']);
    expect(report.changedPaths.find((row) => row.path.endsWith('billing.ts'))?.reviewFocus).toContain('financial');
    expect(report.reviewEvidence).toEqual({ agentReview: 'not-proven', humanReview: 'not-proven' });
    expect(report.affectedPlan?.backend?.mode).toBe('related');
    expect(report.limitations.join(' ')).toContain('adds no approval-count');
  });

  it('keeps both sides of a rename and preserves deleted tests importing protected source', () => {
    const f = fixture(); f.put('test/plain.test.ts', "import '../src/core/authority/grants.js';"); const base = f.commit();
    renameSync(join(f.root, 'test/plain.test.ts'), join(f.root, 'test/renamed.test.ts')); const head = f.commit();
    const report = collectReviewerHandoff({ root: f.root, base, head });
    expect(report.changedPaths.map((row) => [row.change, row.path])).toEqual([['D', 'test/plain.test.ts'], ['A', 'test/renamed.test.ts']]);
    expect(report.changedPaths.every((row) => row.existingOwnerLane?.ruleId === 'tier1-test')).toBe(true);
  });

  it('shows actual changed owner references without inventing a human reviewer or cofounder', () => {
    const f = fixture(); f.put('src/web-ui/display.ts', 'export const value = 1;'); const base = f.commit();
    f.put('.github/CODEOWNERS', '/src/web-ui/** @actual-contributor\n'); f.put('src/web-ui/display.ts', 'export const value = 2;');
    const report = collectReviewerHandoff({ root: f.root, base, head: f.commit() });
    const row = report.changedPaths.find((item) => item.path.endsWith('display.ts'))!;
    expect(row.codeownersBefore).toEqual(['@ui-owner']); expect(row.codeownersAfter).toEqual(['@actual-contributor']);
    expect(report.reviewEvidence.humanReview).toBe('not-proven');
    expect(report.changedPaths.find((item) => item.path === '.github/CODEOWNERS')?.existingOwnerLane?.ruleId).toBe('ci-config');
  });

  it('records count-checked report references while withholding execution and review provenance', () => {
    const f = fixture(); f.put('src/web-ui/display.ts', 'export const changed = true;'); const head = f.commit();
    const initial = collectReviewerHandoff({ root: f.root, base: f.base, head });
    const raw = { ...serializedReport(), source: { revision: head, tree: initial.source.headTree }, secret: 'must-not-appear-in-output' };
    f.put('result.json', JSON.stringify(raw));
    const report = collectReviewerHandoff({ root: f.root, base: f.base, head, evidencePaths: ['result.json'] });
    expect(report.evidence[0]).toMatchObject({ sourceBinding: 'reported-match', countsVerified: true,
      executionProvenance: 'not-verified', reportedExecution: 'passed', counts: { passed: 1, failed: 0, skipped: 1, todo: 1 } });
    expect(JSON.stringify(report)).not.toContain('must-not-appear');
    expect(report.reviewEvidence).toEqual({ agentReview: 'not-proven', humanReview: 'not-proven' });
    expect(report.source.dirtyExcluded).toBe(true);
    expect(report.unknowns.join(' ')).toContain('working-tree changes are excluded');
  });

  it('holds unbound/mismatched evidence and treats a gate plan as not executed', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;'); const head = f.commit();
    f.put('unbound.json', JSON.stringify(serializedReport()));
    f.put('old.json', JSON.stringify({ ...serializedReport(), source: { revision: f.base, tree: '0'.repeat(40) } }));
    f.put('plan.json', JSON.stringify({ mode: 'plan', checksExecuted: false, ok: true }));
    const report = collectReviewerHandoff({ root: f.root, base: f.base, head, evidencePaths: ['unbound.json', 'old.json', 'plan.json'] });
    expect(report.evidence.map((row) => row.sourceBinding)).toEqual(['unreported', 'mismatch', 'unreported']);
    expect(report.evidence[2]?.reportedExecution).toBe('not-executed');
    expect(report.unknowns.join(' ')).toContain('cannot prove exact-source');
  });

  it('refuses inconsistent case counts rather than reporting passing evidence', () => {
    expect(() => summarizeTestEvidence({ ...serializedReport(), numPassedTests: 3 })).toThrow(/counts disagree/);
    expect(summarizeTestEvidence({ ok: true })).toMatchObject({ reportedExecution: 'unknown', countsVerified: false });
    expect(summarizeTestEvidence({ ...serializedReport(), numFailedTestSuites: 1 })).toMatchObject({ reportedExecution: 'failed' });
  });

  it('refuses symlink and secret-shaped evidence without exposing its contents', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;'); const head = f.commit();
    f.put('actual.json', JSON.stringify(serializedReport())); symlinkSync('actual.json', join(f.root, 'linked.json'));
    f.put('credentials.json', '{"private":"not for handoff"}');
    expect(() => collectReviewerHandoff({ root: f.root, base: f.base, head, evidencePaths: ['linked.json'] })).toThrow(/Unsafe/);
    expect(() => collectReviewerHandoff({ root: f.root, base: f.base, head, evidencePaths: ['credentials.json'] })).toThrow(/sensitive/);
  });

  it('bounds FD reads when the same inode grows after admission, and refuses oversized reports', () => {
    const f = fixture(); f.put('result.json', '{}'); const file = join(f.root, 'result.json'); const fd = openSync(file, 'r');
    let totalRead = 0; let first = true;
    try {
      const growingRead = (descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
        const count = readSync(descriptor, buffer, offset, length, position); totalRead += count;
        if (first) { first = false; appendFileSync(file, Buffer.alloc(9 * 1024 * 1024)); }
        return count;
      };
      expect(() => readBoundedReport(fd, 2, growingRead)).toThrow(/size changed/);
      expect(totalRead).toBe(3); // the original two bytes plus one overflow sentinel
      expect(() => readBoundedReport(fd, 8 * 1024 * 1024 + 1)).toThrow(/Unsafe report size/);
    } finally { closeSync(fd); }
    expect(() => collectReviewerHandoff({ root: f.root, base: f.base, head: f.base, evidencePaths: ['result.json'] })).toThrow(/Unsafe evidence/);
  });

  it('reports unsupported ownership and absent smoke inputs as unknown', () => {
    const f = fixture(); f.put('.github/CODEOWNERS', '/src/** somebody-without-github-reference');
    f.put('src/web-ui/value.ts', 'export const changed = true;'); rmSync(join(f.root, 'scripts/gate-smoke.json'));
    const report = collectReviewerHandoff({ root: f.root, base: f.base, head: f.commit() });
    expect(report.affectedPlan).toBeNull(); expect(report.unknowns.join(' ')).toContain('unsupported');
    expect(report.unknowns.join(' ')).toContain('selectors are unavailable');
  });

  it('does not read secret source blobs into the public report', () => {
    const f = fixture(); f.put('.env', 'API_KEY=never-print-this'); const report = collectReviewerHandoff({ root: f.root, base: f.base, head: f.commit() });
    expect(report.changedPaths[0]?.existingOwnerLane?.ruleId).toBe('secrets');
    expect(JSON.stringify(report)).not.toContain('never-print-this');
  });

  it('CLI observation is read-only and adds no approvals, test execution or public effects', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;'); const head = f.commit();
    const before = snapshot(f.root); const script = join(import.meta.dirname, '../scripts/reviewer-handoff.ts');
    const result = spawnSync(process.execPath, ['--import', join(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'), script,
      '--base', f.base, '--head', head, '--json'], { cwd: f.root, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); expect(snapshot(f.root)).toBe(before);
    expect(JSON.parse(result.stdout)).toMatchObject({ checksExecuted: false, releaseAdmission: false,
      reviewEvidence: { humanReview: 'not-proven', agentReview: 'not-proven' } });
  });

  it('refuses inherited Git source overrides and does not invoke a configured fsmonitor hook', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;'); const head = f.commit();
    f.put('monitor.sh', '#!/bin/sh\necho called > monitor-called\n'); chmodSync(join(f.root, 'monitor.sh'), 0o700);
    f.git('config', 'core.fsmonitor', join(f.root, 'monitor.sh'));
    const previous = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(f.root, 'unrelated-git-directory');
      expect(collectReviewerHandoff({ root: f.root, base: f.base, head }).source.head).toBe(head);
      expect(readdirSync(f.root)).not.toContain('monitor-called');
    } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  });

  it('CLI errors do not expose private JSON parser input', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;'); const head = f.commit();
    f.put('invalid.json', 'private-client-data-this-is-not-json');
    const result = spawnSync(process.execPath, ['--import', join(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs'),
      join(import.meta.dirname, '../scripts/reviewer-handoff.ts'), '--base', f.base, '--head', head, '--evidence', 'invalid.json'],
    { cwd: f.root, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain('could not be verified');
    expect(result.stderr).not.toContain('private-client-data');
  });

  it('renders concrete files/questions with escaped Markdown and no mandatory human gate', () => {
    const f = fixture(); f.put('src/web-ui/value.ts', 'export const changed = true;');
    const report = collectReviewerHandoff({ root: f.root, base: f.base, head: f.commit() });
    const markdown = renderReviewerHandoff(report);
    expect(markdown).toContain('src/web-ui/value.ts'); expect(markdown).toContain('Review questions');
    expect(markdown).toContain('npm run check:docs'); expect(markdown).toContain('Advisory web selection');
    expect(markdown).toContain('src/web-ui/smoke.test.tsx'); expect(markdown).toContain('not executed by this tool');
    expect(markdown).toContain('qualified automated merge apply'); expect(markdown).toContain('not proven');
    expect(markdown).not.toContain('approved by');
  });

  it('rejects unknown/missing arguments and option-shaped refs', () => {
    expect(parseReviewerHandoffArgs(['--base', 'base', '--head', 'HEAD', '--evidence', 'tests.json', '--json']))
      .toEqual({ base: 'base', head: 'HEAD', evidencePaths: ['tests.json'], json: true });
    for (const args of [['--approve'], ['--base'], ['--head', '--help']]) expect(() => parseReviewerHandoffArgs(args)).toThrow();
  });
});
