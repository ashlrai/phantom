import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiAnnotations } from '../src/cli/fleet-ci-annotations.js';
import { readCiAnnotations } from '../src/core/fleet/ci-annotations.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
const secret = 'ghp_' + 'x'.repeat(36); // Synthetic credential.
const job = { id: 42, run_id: 10, head_sha: sha, check_run_url: 'https://api.github.com/repos/ashlrai/phantom/check-runs/99' };
const annotation = { path: 'src/a.ts', start_line: 2, end_line: 2, start_column: 1, end_column: 3,
  annotation_level: 'failure', title: 'Broken', message: 'Fix this' };
const ok = (value: unknown, patch: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false, ...patch });
function fake(responses: GitRunResult[]) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv, opts) => {
    expect(bin).toBe('gh'); expect(opts.timeoutMs).toBe(15_000); expect(opts.maxStdoutBytes).toBe(1024 * 1024);
    calls.push([...argv]); return responses[calls.length - 1] ?? ok(null, { code: 1 });
  };
  return { gh, calls };
}
const args = ['--repo', 'ashlrai/phantom', '--job', '42'];
let output: string[];
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('CI annotations', () => {
  it('CLI invokes the reader, links the job and paginates GETs', async () => {
    const f = fake([ok(job), ok(Array(100).fill(annotation)), ok([annotation])]);
    expect(await cmdFleetCiAnnotations([...args, '--json'], f)).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({ repo: 'ashlrai/phantom', job: 42, run: 10, check: 99, headSha: sha,
      source: { status: 'ok', truncated: false } });
    expect(result.annotations[0]).toEqual(annotationToOutput());
    expect(result.annotations).toHaveLength(101);
    expect(f.calls).toEqual([
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/jobs/42'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/check-runs/99/annotations?per_page=100&page=1'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/check-runs/99/annotations?per_page=100&page=2'],
    ]);
  });
  it('reports a successful empty response and actionable text', async () => {
    const f = fake([ok(job), ok([])]);
    expect(await cmdFleetCiAnnotations(args, f)).toBe(0);
    expect(output.join('\n')).toContain('No annotations.');
    output = [];
    expect(await cmdFleetCiAnnotations(args, fake([ok(job), ok([annotation])]))).toBe(0);
    expect(output.join('\n')).toContain('src/a.ts:2:1: failure: Broken Fix this');
  });
  it.each([
    { ...job, id: 43 }, { ...job, run_id: 0 }, { ...job, head_sha: 'bad' },
    { ...job, check_run_url: 'https://evil.test/repos/ashlrai/phantom/check-runs/99' },
    { ...job, check_run_url: 'https://api.github.com/repos/other/phantom/check-runs/99' },
    { ...job, check_run_url: job.check_run_url + '?x=1' },
    { ...job, check_run_url: 'https://api.github.com@evil.test/repos/ashlrai/phantom/check-runs/99' },
  ])('rejects invalid job linkage %j', async (bad) => {
    const f = fake([ok(bad)]);
    expect((await readCiAnnotations('ashlrai/phantom', 42, f.gh)).source.status).toBe('job_invalid');
    expect(f.calls).toHaveLength(1);
  });
  it('keeps partial evidence when a later page is unavailable or truncated', async () => {
    for (const response of [ok(null, { code: 1, stderr: secret }), ok(null, { truncated: true, code: null })]) {
      const f = fake([ok(job), ok(Array(100).fill(annotation)), response]);
      const result = await readCiAnnotations('ashlrai/phantom', 42, f.gh);
      expect(result.source.status).toBe(response.truncated ? 'annotations_truncated' : 'annotations_unavailable');
      expect(result.annotations).toHaveLength(100);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect((await readCiAnnotations('ashlrai/phantom', 42, fake([ok(null, { timedOut: true })]).gh)).source.status).toBe('job_unavailable');
  });
  it('marks the page cap truncated', async () => {
    const f = fake([ok(job), ...Array(10).fill(ok(Array(100).fill(annotation)))]);
    const result = await readCiAnnotations('ashlrai/phantom', 42, f.gh);
    expect(result.source).toMatchObject({ status: 'annotations_truncated', truncated: true });
    expect(f.calls).toHaveLength(11);
  });
  it.each([
    { path: '../secret' }, { path: '/tmp/x' }, { path: 'C:\\x' }, { path: 'a/./b' }, { path: 'a\u001b[31m' },
    { start_line: 0 }, { end_line: 1 }, { end_column: 0 }, { end_line: 3 }, { annotation_level: 'other' },
  ])('rejects unsafe annotations %j', async (patch) => {
    const result = await readCiAnnotations('ashlrai/phantom', 42, fake([ok(job), ok([{ ...annotation, ...patch }])]).gh);
    expect(result.source.status).toBe('annotations_invalid'); expect(result.annotations).toHaveLength(0);
  });
  it('scrubs controls and secrets before clipping', async () => {
    const item = { ...annotation, title: `\u001b[31m${secret.slice(0, 8)}\u0001${secret.slice(8)}\u001b[0m`, message: 'z'.repeat(2100) + secret };
    const result = await readCiAnnotations('ashlrai/phantom', 42, fake([ok(job), ok([item])]).gh);
    expect(result.annotations[0]!.title).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('\\u001b');
    expect(result.source.outputTruncated).toBe(true);
  });
  it.each([[], ['--repo', '../bad', '--job', '42'], ['--repo', 'ashlrai/phantom', '--job', '0'],
    ['--repo', 'ashlrai/phantom', '--job', '9007199254740992'], [...args, '--job', '1'], [...args, '--json', '--json']])('rejects bad arguments without network %j', async (...bad) => {
    const f = fake([]); expect(await cmdFleetCiAnnotations(bad, f)).toBe(2); expect(f.calls).toHaveLength(0);
  });
});
function annotationToOutput() {
  return { path: 'src/a.ts', startLine: 2, endLine: 2, startColumn: 1, endColumn: 3,
    level: 'failure', title: 'Broken', message: 'Fix this' };
}
