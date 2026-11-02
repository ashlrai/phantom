import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetCiSweep } from '../src/cli/fleet-ci-sweep.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const roots: string[] = [], args = ['--repo', 'AshlrAI/Phantom', '--to', 'leader:one', '--json'];
const fakeSecret = 'ghp_' + 'aB1'.repeat(12);
function run(id: number) {
  return { id, repository: { full_name: 'ashlrai/phantom' }, event: 'schedule', status: 'completed',
    conclusion: 'failure' as string | null, created_at: new Date(Date.UTC(2026, 9, 1) + id * 1000).toISOString().replace('.000Z', 'Z'),
    run_attempt: 1, name: `Daily ${fakeSecret}`, head_branch: 'master', head_sha: 'a'.repeat(40) };
}
function setup(rows = [run(1), run(2)]) {
  const root = mkdtempSync(join(tmpdir(), 'ci-sweep-')); roots.push(root);
  const calls: string[][] = [], output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let failPage = 0, failRun = 0, total = rows.length;
  const gh: CloudGh = async argv => {
    calls.push(argv);
    const endpoint = argv.at(-1)!;
    const page = /[?&]page=(\d+)/.exec(endpoint);
    if (page) {
      const n = Number(page[1]);
      if (n === failPage) return { ok: false, stdout: fakeSecret, stderr: fakeSecret };
      return { ok: true, stdout: JSON.stringify({ total_count: total, workflow_runs: rows.slice((n - 1) * 25, n * 25) }), stderr: '' };
    }
    const id = Number(/\/runs\/(\d+)/.exec(endpoint)?.[1]);
    if (id === failRun) throw new Error(fakeSecret);
    const data = endpoint.includes('/jobs?') ? { total_count: 0, jobs: [] } : rows.find(row => row.id === id);
    return { ok: true, stdout: JSON.stringify(data), stderr: '' };
  };
  const invoke = (argv = args) => cmdFleetCiSweep(argv, { gh, bus: { root, now: () => 100 } });
  const result = () => JSON.parse(String(output.mock.calls.at(-1)?.[0]));
  const retained = () => listBusInboxAfter(0, 100, { root, now: () => 100 });
  return { root, rows, calls, output, invoke, result, retained,
    failPage: (n: number) => { failPage = n; }, failRun: (n: number) => { failRun = n; }, setTotal: (n: number) => { total = n; } };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('dispatches by convention and publishes once per run attempt, newest first', async () => {
  expect(resolveFleetSubcommand('ci-sweep')).toEqual({ module: './fleet-ci-sweep.js', exportName: 'cmdFleetCiSweep' });
  const h = setup();
  expect(await h.invoke()).toBe(0);
  expect(h.result()).toMatchObject({ discovered: 2, selected: 2, posted: 2, duplicate: 0, error: 0, listing: { complete: true, pages: 1 } });
  expect(h.result().outcomes.map((o: { run: string }) => o.run)).toEqual(['2', '1']);
  expect(await h.invoke()).toBe(0);
  expect(h.result()).toMatchObject({ posted: 0, duplicate: 2 });
  h.rows[0]!.run_attempt = 2;
  expect(await h.invoke()).toBe(0);
  expect(h.result()).toMatchObject({ posted: 1, duplicate: 1 });
  const page = h.retained();
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') throw new Error('missing bus');
  expect(page.messages.map(row => row.envelope.body)).toMatchObject([
    { runId: 2, attempt: 1, workflow: 'Daily [REDACTED]' },
    { runId: 1, attempt: 1 }, { runId: 1, attempt: 2 },
  ]);
  expect(JSON.stringify(h.output.mock.calls)).not.toContain(fakeSecret);
}, 60_000);

it('previews without bus writes and excludes non-scheduled, successful, and running runs', async () => {
  const rows = [run(1), run(2), run(3), run(4)];
  rows[1]!.conclusion = 'success'; rows[2]!.event = 'push'; rows[3]!.status = 'in_progress'; rows[3]!.conclusion = null;
  const h = setup(rows);
  expect(await h.invoke([...args, '--dry-run'])).toBe(0);
  expect(h.result()).toMatchObject({ discovered: 4, selected: 1, skipped: 3, previewed: 1, posted: 0, error: 0 });
  expect(h.result().outcomes.find((o: { run: string }) => o.run === '1').result).toMatchObject({ status: 'dry-run', envelope: { body: { runId: 1 } } });
  expect(existsSync(join(h.root, 'bus-inbox'))).toBe(false);
});

it('bounds listing and publishing and reports truncation and known cap omissions', async () => {
  const h = setup(Array.from({ length: 50 }, (_, i) => run(50 - i)));
  h.setTotal(60);
  expect(await h.invoke()).toBe(1);
  expect(h.result()).toMatchObject({ discovered: 50, selected: 10, posted: 10, capOmissions: 40, error: 1,
    listing: { complete: false, pages: 2, total: 60, reason: 'GitHub listing page limit reached' } });
  expect(h.calls).toHaveLength(22);
  expect(h.calls.every(call => call.slice(0, 5).join(' ') === 'api --hostname github.com --method GET')).toBe(true);
  expect(h.result().outcomes.map((o: { run: string }) => o.run)).toEqual(Array.from({ length: 10 }, (_, i) => String(50 - i)));
}, 60_000);

it('continues valid runs after a partial listing or a publish failure without exposing errors', async () => {
  const h = setup(Array.from({ length: 26 }, (_, i) => run(26 - i)));
  h.failPage(2); h.failRun(26);
  expect(await h.invoke()).toBe(1);
  expect(h.result()).toMatchObject({ discovered: 25, selected: 10, posted: 9, error: 2,
    listing: { complete: false, pages: 1, reason: 'GitHub listing read failed' } });
  expect(h.result().outcomes.find((o: { run: string }) => o.run === '26').result).toMatchObject({ status: 'error' });
  expect(JSON.stringify(h.output.mock.calls)).not.toContain(fakeSecret);
}, 60_000);

it('rejects malformed listing rows while processing independent valid rows', async () => {
  const rows = [run(1), run(2)]; rows[0]!.repository.full_name = 'other/repo';
  const h = setup(rows);
  expect(await h.invoke()).toBe(1);
  expect(h.result()).toMatchObject({ discovered: 2, selected: 1, posted: 1, error: 1, listing: { complete: false } });
});

it('reports a short listing page and still publishes its valid rows', async () => {
  const h = setup([run(1)]); h.setTotal(2);
  expect(await h.invoke()).toBe(1);
  expect(h.result()).toMatchObject({ posted: 1, error: 1, listing: { complete: false, reason: 'incomplete GitHub listing' } });
}, 60_000);

it('reports bus storage failures for each selected run', async () => {
  const h = setup();
  const blockedRoot = join(h.root, 'bus-inbox');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(blockedRoot, 'blocked');
  expect(await h.invoke()).toBe(1);
  expect(h.result()).toMatchObject({ selected: 2, posted: 0, error: 2, listing: { complete: true } });
}, 60_000);

it.each([
  [], ['--repo', '../bad', '--to', 'leader'], ['--repo', 'x/y', '--to', 'bad address'],
  ['--repo', 'x/y', '--to', 'leader', '--repo', 'x/y'], ['--repo', 'x/y', '--to', 'leader', '--json', '--json'],
  ['--repo', 'x/y', '--to', '--dry-run'], ['--repo', 'x/y', '--to', 'leader', '--bogus'],
])('rejects malformed arguments before I/O: %j', async (...argv) => {
  const h = setup();
  expect(await h.invoke(argv)).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(existsSync(join(h.root, 'bus-inbox'))).toBe(false);
});
