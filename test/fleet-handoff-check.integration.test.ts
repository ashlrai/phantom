import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFleetHandoff, runFleetHandoffCheck } from '../scripts/fleet-handoff-check.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const job = 'FAKE-JOB';
const pr = 'https://github.com/Example/Widget/pull/42';
let root: string;
let runs: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'handoff-check-'));
  runs = join(root, '.ashlr-runs');
  await mkdir(runs);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function artifact(suffix: string, content: string) {
  await writeFile(join(runs, `${job}.${suffix}`), content);
}
async function publish(url = pr) {
  await artifact('publish', `RESULT PR ${url}\nTEST fake suite exit 0\n`);
}
function readers(maxBytes?: number) {
  return {
    detail: (id: string) => getFleetJobDetail(id, { runsDir: runs }),
    text: (id: string, kind: 'notes' | 'prompt') => getFleetJobText(id, kind, { runsDir: runs, maxBytes }),
  };
}
async function check() { return checkFleetHandoff(job, 'example/widget', readers()); }

describe('fleet handoff PR consistency', () => {
  it('matches case-insensitively and reports supporting repositories separately', async () => {
    await publish();
    await artifact('notes.md', `Private narrative. [PR](${pr})\nSupport: https://github.com/Other/Lib/pull/7\n`);
    const result = await check();
    expect(result).toMatchObject({ verdict: 'matched', complete: true,
      publication: { state: 'published', source: 'healthy', healthy: true,
        ref: { repo: 'example/widget', number: '42', url: 'https://github.com/example/widget/pull/42' } },
      notes: { source: 'notes', state: 'ok', truncated: false,
        sameRepo: [{ repo: 'example/widget', number: '42' }], otherRepos: [{ repo: 'other/lib', number: '7' }] } });
    expect(JSON.stringify(result)).not.toContain('Private narrative');
  });

  it('treats any conflicting reference in the same repository as a mismatch', async () => {
    await publish();
    await artifact('notes.md', `${pr}\nhttps://github.com/example/widget/pull/43\n${pr}\n`);
    const result = await check();
    expect(result).toMatchObject({ verdict: 'mismatch', complete: false });
    expect(result.notes.sameRepo.map(ref => ref.number)).toEqual(['42', '43']);
  });

  it('does not infer repository identity from numbers or another repository', async () => {
    await publish();
    await artifact('notes.md', 'PR #42 and https://github.com/other/lib/pull/42\nhttps://evil.example/https://github.com/example/widget/pull/42');
    const result = await check();
    expect(result).toMatchObject({ verdict: 'no-explicit-reference', complete: false,
      notes: { sameRepo: [], otherRepos: [{ repo: 'other/lib', number: '42' }] } });
  });

  it('makes truncated, empty, missing or unpublished evidence unavailable', async () => {
    await publish();
    await artifact('notes.md', `${pr}\nmore notes`);
    expect(await checkFleetHandoff(job, 'example/widget', readers(8))).toMatchObject({
      verdict: 'unavailable', complete: false, notes: { truncated: true },
    });
    await artifact('notes.md', '  \n');
    expect(await check()).toMatchObject({ verdict: 'unavailable', notes: { nonempty: false } });
    await rm(join(runs, `${job}.notes.md`));
    expect(await check()).toMatchObject({ verdict: 'unavailable', notes: { state: 'missing' } });
    await artifact('notes.md', pr);
    await rm(join(runs, `${job}.publish`));
    expect(await check()).toMatchObject({ verdict: 'unavailable', publication: { state: 'unknown', healthy: false } });
  });

  it('requires a healthy publication with a test line and the requested repository', async () => {
    await artifact('notes.md', pr);
    await artifact('publish', `RESULT PR ${pr}\n`);
    expect(await check()).toMatchObject({ verdict: 'unavailable', publication: { hasTestLine: false } });
    await publish('https://github.com/other/lib/pull/42');
    expect(await check()).toMatchObject({ verdict: 'unavailable', publication: { healthy: false } });
    await rm(join(runs, `${job}.publish`));
    await mkdir(join(runs, `${job}.publish`));
    expect(await check()).toMatchObject({ verdict: 'unavailable', publication: { source: 'degraded' } });
  });

  it('uses the retained body fallback and executes the CLI with isolated HOME', async () => {
    await publish();
    await artifact('body.md', `Handoff: ${pr}\n`);
    expect(await check()).toMatchObject({ verdict: 'matched', notes: { source: 'body' } });
    const result = await promisify(execFile)(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'),
      'scripts/fleet-handoff-check.ts', '--job', job, '--repo', 'EXAMPLE/Widget', '--json'],
    { cwd: resolve('.'), env: { ...process.env, HOME: root } });
    expect(JSON.parse(result.stdout)).toMatchObject({ verdict: 'matched', complete: true, notes: { source: 'body' } });
    expect(result.stderr).toBe('');
  }, 30000);

  it('returns planner-friendly exits and rejects invalid arguments before reading', async () => {
    await publish();
    await artifact('notes.md', 'No link');
    const output: string[] = [];
    const write = (value: string) => { output.push(value); };
    expect(await runFleetHandoffCheck(['--job', job, '--repo', 'example/widget', '--json'], { readers: readers(), write })).toBe(1);
    expect(JSON.parse(output.pop()!).verdict).toBe('no-explicit-reference');
    expect(await runFleetHandoffCheck(['--job', job, '--repo', 'example/widget', '--json', '--json'], { readers: readers(), write })).toBe(2);
    expect(JSON.parse(output.pop()!).error).toBe('invalid_arguments');
    await artifact('notes.md', pr);
    expect(await runFleetHandoffCheck(['--job', job, '--repo', 'example/widget', '--json'], { readers: readers(), write })).toBe(0);
  });
});
