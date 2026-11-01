import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRedFix } from '../src/cli/fleet-red-fix.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { runRedPrFix } from '../src/core/fleet/red-pr-fix-job.js';
import { DROP_JOB_QUEUE_LIMIT } from '../src/core/fleet/drop-job-writer.js';

const head = 'a'.repeat(40), now = Date.parse('2026-11-01T12:00:00Z');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(options: { status?: string; conclusion?: string; bind?: boolean; mergeable?: string; draft?: boolean; newer?: string; log?: string; fail?: string; evidenceHead?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'red-fix-test-')); roots.push(root);
  const step = options.bind ? 'Bind candidate source' : 'Run tests';
  const job = { id: 42, run_id: 10, name: 'Test', head_sha: options.evidenceHead ?? head, conclusion: 'failure', steps: [{ name: step, conclusion: 'failure' }] };
  const run = (id: number, status: string, conclusion: string | null) => ({ id, name: 'CI', event: 'pull_request', head_branch: 'topic', pull_requests: [{ number: 7 }], status, conclusion, created_at: new Date(now - (id === 10 ? 2000 : 1000)).toISOString() });
  const gh = vi.fn(async (args: string[]) => {
    const path = args.at(-1)!;
    if (options.fail && path.includes(options.fail)) throw new Error('private stderr');
    if (args[0] === 'pr') return JSON.stringify([{ number: 7, title: 'bridge: RQ-PHX-EXAMPLE01', headRefOid: head, mergeable: options.mergeable ?? 'MERGEABLE', isDraft: options.draft ?? false }]);
    if (path.includes('/actions/runs?')) return JSON.stringify({ workflow_runs: [run(10, options.status ?? 'completed', options.conclusion ?? 'failure'), ...(options.newer ? [run(11, options.newer === 'in_progress' ? 'in_progress' : 'completed', options.newer === 'in_progress' ? null : options.newer)] : [])] });
    if (path.includes('/jobs?filter=')) return JSON.stringify([{ total_count: 1, jobs: [job] }]);
    if (path.includes('/runs/10/jobs?')) return JSON.stringify({ jobs: [job] });
    if (path.includes('/jobs/42/logs')) return options.log ?? 'error: test failed';
    throw new Error('unexpected request');
  });
  const call = (write = false) => runRedPrFix({ repo: 'ashlrai/phantom', hours: 24, write, runsDir: root, gh, now: () => now });
  return { root, call, gh };
}

describe('fleet red-fix', () => {
  it('is dry by default, then publishes once with the real writer', async () => {
    const f = await fixture();
    const dry = await f.call();
    expect(dry.reason).toBeNull(); expect(dry.candidates[0]).toMatchObject({ written: false, skipped: null });
    expect(await readdir(f.root)).toEqual([]);
    const written = await f.call(true);
    expect(written.candidates[0]).toMatchObject({ written: true, skipped: null });
    const dir = join(f.root, 'leader/drop/claude');
    const files = await readdir(dir); expect(files).toHaveLength(1);
    const text = await readFile(join(dir, files[0]!), 'utf8');
    expect(text).toContain('#job repo=phantom lane=codex-personal tier=work');
    expect(text).toContain(`PR #7, job RQ-PHX-EXAMPLE01, head ${head}`);
    expect(text).toContain('Observed run: 10'); expect(text).toContain('git show FETCH_HEAD:<path>');
    expect((await f.call(true)).candidates[0]).toMatchObject({ written: false, skipped: 'already-dropped' });
    expect(await readdir(dir)).toEqual(files);
  });
  it.each([{ newer: 'success' }, { newer: 'in_progress' }, { bind: true }, { mergeable: 'DIRTY' }, { mergeable: 'UNKNOWN' }, { draft: true }, { status: 'in_progress' }])('skips nonqualifying facts %j', async options => {
    const f = await fixture(options); expect((await f.call(true)).candidates).toEqual([]); expect(await readdir(f.root)).toEqual([]);
  });
  it('exposes collector failures and refuses stale evidence', async () => {
    const f = await fixture({ fail: '/actions/runs?' });
    expect((await f.call(true)).reason).toBeTruthy(); expect(await readdir(f.root)).toEqual([]);
    const stale = await fixture({ evidenceHead: 'b'.repeat(40) });
    expect((await stale.call(true)).candidates[0]?.skipped).toBe('evidence-unavailable-or-stale');
    const logFail = await fixture({ fail: '/logs' });
    expect((await logFail.call(true)).candidates[0]?.skipped).toBe('evidence-unavailable-or-stale');
  });
  it('scrubs secret fields and bounds oversized log excerpts', async () => {
    const f = await fixture({ log: Array.from({ length: 30 }, () => `error password=FAKESECRET12345 ${'long '.repeat(200)}`).join('\n') });
    const result = await f.call(true); expect(result.candidates[0]?.written).toBe(true);
    const dir = join(f.root, 'leader/drop/claude'); const text = await readFile(join(dir, (await readdir(dir))[0]!), 'utf8');
    expect(text).not.toContain('FAKESECRET12345'); expect(text).toContain('[REDACTED]');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8000);
  });
  it('bounds attempts and refuses concurrent duplicate writes', async () => {
    const f = await fixture();
    const pair = await Promise.all([f.call(true), f.call(true)]);
    expect(pair.flatMap(r => r.candidates).filter(c => c.written)).toHaveLength(1);
    const dir = join(f.root, 'leader/drop/claude');
    for (let i = 0; i < 4; i++) {
      const files = await readdir(dir);
      const latest = join(dir, files.sort().at(-1)!);
      await writeFile(latest, (await readFile(latest, 'utf8')).replace('Observed run: 10', 'Observed run: 11'));
      expect((await f.call(true)).candidates[0]?.written).toBe(true);
    }
    const files = await readdir(dir);
    const latest = join(dir, files.sort().at(-1)!);
    await writeFile(latest, (await readFile(latest, 'utf8')).replace('Observed run: 10', 'Observed run: 11'));
    expect((await f.call(true)).candidates[0]?.skipped).toBe('attempts-exhausted');
    expect(await readdir(dir)).toHaveLength(5);
  });
  it('honors queue backpressure', async () => {
    const f = await fixture(); const dir = join(f.root, 'queue/prompts'); await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: DROP_JOB_QUEUE_LIMIT }, (_, i) => writeFile(join(dir, `RQ-PHX-QUEUE${i}.md`), 'queued')));
    expect((await f.call(true)).candidates[0]?.skipped).toBe('queue-full');
  });
  it('rejects invalid flags and resolves the registered convention', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--bad'], ['--hours', '1e2'], ['--hours', '0'], ['--write', '--write'], ['--runs-dir', 'relative'], ['--repo', 'other/repo'], ['--hours'], ['--help', '--write']]) expect(await cmdFleetRedFix(args)).toBe(2);
    const resolved = resolveFleetSubcommand('red-fix');
    expect(resolved).toEqual({ module: './fleet-red-fix.js', exportName: 'cmdFleetRedFix' });
    expect((await FLEET_SUBCOMMAND_LOADERS['red-fix']!())[resolved!.exportName]).toBe(cmdFleetRedFix);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRedFix([], { run: async opts => { expect(opts.write).toBe(false); return { candidates: [], reason: 'unavailable' }; } })).toBe(1);
    expect(output).not.toHaveBeenCalledWith('no red fleet PRs');
  });
});
