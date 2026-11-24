import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { summarizeSkips } from '../src/core/fleet/skipped-jobs.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const PATH = '/api/verse/fleet/runs/skipped';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(ledger?: string) {
  const root = await mkdtemp(join(tmpdir(), 'webserver765-'));
  roots.push(root);
  if (ledger !== undefined) {
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics', 'jobs.jsonl'), ledger);
  }
  const api = createFleetRunsApi({ runsDir: root, now: () => NOW });
  return { root, call: async (method = 'GET') => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.url = PATH; req.method = method; req.headers = {};
    let status = 0, body: unknown;
    const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
    expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as VerseApiContext, req, res, PATH, method)).toBe(true);
    return { status, body };
  } };
}

it('serves the original grouped report from the selected runs directory without changing its ledger', async () => {
  const ledger = [1, 2].map(hours => JSON.stringify({ event: 'precheck_skip', job: 'RQ-EXAMPLE1', lane: 'test', repo: 'phantom', code: 13, ts: new Date(NOW - hours * 3_600_000).toISOString() })).join('\n');
  const { root, call } = await fixture(ledger);
  expect(await call()).toEqual({ status: 200, body: summarizeSkips(ledger, NOW) });
  expect(await readFile(join(root, 'metrics', 'jobs.jsonl'), 'utf8')).toBe(ledger);
});

it('distinguishes an unreadable ledger from a readable empty ledger', async () => {
  expect((await (await fixture()).call()).body).toMatchObject({ known: false, total: 0 });
  expect((await (await fixture('')).call()).body).toMatchObject({ known: true, total: 0 });
});

it('refuses every non-GET method without turning a read route into a mutation', async () => {
  const { call } = await fixture('');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    expect(await call(method)).toEqual({ status: 405, body: { error: 'method not allowed' } });
  }
});

it('retains the original jobs entry point and loads the fleet convention entry point', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobs(['skipped', '--help'])).toBe(0);
  expect(out).toHaveBeenCalledWith(expect.stringContaining('Usage: phm jobs skipped'));
  const { cmdFleetSkipped } = await FLEET_SUBCOMMAND_LOADERS.skipped!();
  expect(await (cmdFleetSkipped as (args: string[]) => Promise<number>)(['--help'])).toBe(0);
});
