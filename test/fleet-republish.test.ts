import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readFleetRepublish } from '../src/core/fleet/republish.js';
import { cmdFleetRepublish } from '../src/cli/fleet-republish.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [], sha = 'a'.repeat(40), job = 'RQ-EXAMPLE';
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(log?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'republish-')); dirs.push(dir);
  await writeFile(join(dir, `${job}.publish`), log ?? await readFile('test/fixtures/republish/aborted.publish', 'utf8'));
  return dir;
}
const ref = (suffix = '') => ({ ref: `refs/heads/codex-bridge/${job}${suffix}`, object: { sha } });
const pr = (state: string, merged_at: string | null = null) => ({ state, merged_at, head: { label: `example:codex-bridge/${job}` } });
function github(branches: unknown = [ref()], prs: unknown = [], more = false) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(branches))
    .mockResolvedValueOnce(Response.json(prs, { headers: more ? { link: '<https://api.github.com/next>; rel="next"' } : {} }));
}
it.each([
  ['aborted after push', [ref()], [], 'ready', 'none'], ['branch gone', [], [], 'skip', 'unknown'],
  ['prefix is not the branch', [ref('-OTHER')], [], 'skip', 'unknown'], ['open PR', [ref()], [pr('open')], 'skip', 'open'],
  ['merged PR', [ref()], [pr('closed', '2026-11-16T00:00:00Z')], 'skip', 'merged'], ['closed unmerged PR', [ref()], [pr('closed')], 'ready', 'closed'],
])('republish fixture: %s', async (_label, branches, prs, status, pr_state) => {
  const fetcher = github(branches, prs), report = await readFleetRepublish(await fixture(), fetcher);
  expect(report.jobs[0]).toMatchObject({ job, status, pr_state });
  expect(report.jobs[0]!.readyLine !== null).toBe(status === 'ready');
  if (status === 'ready') expect(report.jobs[0]!.readyLine).toContain(`Cherry-pick ${sha} from example/phantom branch codex-bridge/${job} onto fresh master`);
  expect(fetcher.mock.calls.every(([url, options]) => String(url).startsWith('https://api.github.com/repos/') && options?.method === 'GET' && options.redirect === 'error')).toBe(true);
  if (status === 'ready') expect(String(fetcher.mock.calls[1]![0])).toBe(`https://api.github.com/repos/ashlrai/phantom/pulls?state=all&head=example%3Acodex-bridge%2F${job}&per_page=100`);
});
it('republish ignores aborts before push and successful later results without network calls', async () => {
  const log = await readFile('test/fixtures/republish/aborted.publish', 'utf8');
  for (const text of ['RESULT ABORT push\n', `RESULT ABORT default-fetch\n${log.split('RESULT')[0]}`, `${log}\nRESULT PR https://github.com/ashlrai/phantom/pull/1`]) {
    const fetcher = github(); expect((await readFleetRepublish(await fixture(text), fetcher)).jobs[0]!.status).toBe('skip'); expect(fetcher).not.toHaveBeenCalled();
  }
});
it('republish keeps missing links, denied reads, malformed responses and incomplete lists unknown', async () => {
  for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport detail')), vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })), github({}), github([ref()], {}), github([ref()], [], true), github([ref()], [pr('unexpected')])]) {
    const report = await readFleetRepublish(await fixture(), fetcher);
    expect(report.status).toBe('unknown'); expect(report.jobs[0]!.readyLine).toBeNull(); expect(report.jobs[0]!.pr_state).toBe('unknown'); expect(JSON.stringify(report)).not.toContain('private transport detail');
  }
  expect((await readFleetRepublish(await fixture(`remote: Create a pull request for 'codex-bridge/${job}' on GitHub by visiting:\nRESULT ABORT pr`), github())).status).toBe('unknown');
});
it('republish refuses symlink logs and offers JSON and one plain line per job through its registered CLI', async () => {
  const dir = await fixture(); await symlink(join(dir, `${job}.publish`), join(dir, 'RQ-LINK.publish'));
  const report = await readFleetRepublish(dir, github()), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(report.jobs[1]).toMatchObject({ job: 'RQ-LINK', status: 'unknown' });
  expect(await cmdFleetRepublish(['--dry-run', '--json'], async () => report)).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(report);
  await cmdFleetRepublish([], async () => report); expect(String(log.mock.calls[1]![0]).split('\n')).toHaveLength(2);
  expect(await cmdFleetRepublish(['--runs-dir', join(dir, 'missing'), '--json'])).toBe(1);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetRepublish(['--apply'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS.republish!()).cmdFleetRepublish).toBe('function');
});
it('republish handles bare ABORT, leaves the log and bin untouched, and rejects oversized logs', async () => {
  const original = (await readFile('test/fixtures/republish/aborted.publish', 'utf8')).replace('RESULT ABORT', 'ABORT').replace(' on GitHub by visiting:', '');
  const dir = await fixture(original), bin = join(dir, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'sentinel.publish'), original);
  const report = await readFleetRepublish(dir, github());
  expect(report.jobs).toHaveLength(1); expect(report.jobs[0]!.status).toBe('ready');
  expect(await readFile(join(dir, `${job}.publish`), 'utf8')).toBe(original);
  expect(await readFile(join(bin, 'sentinel.publish'), 'utf8')).toBe(original);
  expect((await readFleetRepublish(await fixture('x'.repeat(2 * 1024 * 1024 + 1)), github())).status).toBe('unknown');
});
it('republish degrades a failed PR lookup to pr_state unknown without failing the job or the report', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([ref()])).mockRejectedValueOnce(new Error('private transport detail'));
  const report = await readFleetRepublish(await fixture(), fetcher), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(report.jobs[0]).toMatchObject({ job, status: 'unknown', sha, head: `example:codex-bridge/${job}`, readyLine: null, pr_state: 'unknown' });
  expect(JSON.stringify(report)).not.toContain('private transport detail');
  expect(await cmdFleetRepublish(['--dry-run'], async () => report)).toBe(1);
  expect(String(log.mock.calls[0]![0])).toBe(`${job}: unknown (pr_state: unknown) — PR evidence is unknown; GitHub could not confirm a complete PR list.`);
});
