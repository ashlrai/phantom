/**
 * fleet context-pack outcome fold: the pack's fleet.finished must count the
 * same resolved attempts `phm fleet outcomes` reports. dispatchd writes real
 * outcome memory to metrics/jobs.jsonl (launch/finish/reconciler rows) while
 * dispatch-events.log carries no stamped outcome lines in production, so a
 * dispatch-log-only fold reported finished: 0 over a ledger full of resolved
 * work. Missing ledger evidence degrades to the dispatch dialect and the
 * pack's sources.metrics health already reports the ledger as missing.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack } from '../src/core/fleet/context-pack.js';

let root: string;
const now = 1793577600000;
const options = () => ({ job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root, home: root, now: () => now });
const status = () => JSON.stringify({
  last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
  lanes: { claude: { running: 1, target: 2, queued: 0, held: false, held_reason: null } },
});
// Production-shaped dispatch-events.log: a four-field LAUNCH (skipped by the
// outcome fold) and a freeform event — no stamped outcome dialect exists here.
const EVENTS = '2026-11-01 00:00:00 LAUNCH JOB-LEDGER-1 phantom claude work\n' +
  '2026-11-01 00:05:00 FLEET_SHED level 0->1 (mem) mode=enforce\n';
const row = (value: object): string => JSON.stringify(value);
const LEDGER = [
  row({ event: 'launch', job: 'J-1', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T00:00:00+00:00' }),
  row({ event: 'finish', job: 'J-1', lane: 'devin', tokens_total: 1200, wall_s: 600, ts: '2026-11-01T00:20:00+00:00' }),
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-1', prUrl: 'https://github.com/ashlrai/phantom/pull/1', outcome: 'MERGED', mergedAt: '2026-11-01T00:30:00+00:00', ts: '2026-11-01T00:31:00+00:00' }),
  row({ event: 'launch', job: 'J-2', repo: 'phantom', lane: 'claude', tier: 'work', model: 'opus', ts: '2026-11-01T01:00:00+00:00' }),
  row({ event: 'finish', job: 'J-2', lane: 'claude', tokens_total: 800, wall_s: 300, ts: '2026-11-01T01:40:00+00:00' }),
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-2', prUrl: 'https://github.com/ashlrai/phantom/pull/2', outcome: 'CLOSED', closedAt: '2026-11-01T02:00:00+00:00', ts: '2026-11-01T02:01:00+00:00' }),
  // Still open: no finish and no reconciler verdict, so it never counts.
  row({ event: 'launch', job: 'J-3', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T03:00:00+00:00' }),
].join('\n') + '\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-outcomes-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue', 'status.json'), status());
  await writeFile(join(root, 'queue', 'dispatch-events.log'), EVENTS);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), LEDGER);
  // The pack requires readable bus storage; one posted row makes it available.
  expect(appendBusInbox({ id: 'seed', from: 'core', to: 'claude', priority: 'P2', ttl: 60000, body: { text: 'seed' } }, options()).status).toBe('posted');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

interface Pack { sections: { name: string; rows: Record<string, unknown>[] }[] }
const fleetRow = async (): Promise<Record<string, unknown>> => {
  const pack = JSON.parse(await buildContextPack(options())) as Pack;
  return pack.sections.find(section => section.name === 'fleet')!.rows[0]!;
};

it('counts resolved attempts from metrics/jobs.jsonl, the ledger the dispatch log never carried', async () => {
  const row = await fleetRow();
  expect(row['finished']).toBe(2);
  expect((row['sources'] as Record<string, unknown>)['metrics']).toBe('healthy');
});

it('still folds stamped dispatch-log outcomes and degrades honestly without the ledger', async () => {
  await writeFile(join(root, 'queue', 'dispatch-events.log'),
    '2026-11-01 23:50:00 LAUNCH JOB-D phantom claude opus code\n' +
    '2026-11-02 00:00:00 OUTCOME JOB-D merged usage=0.2\n');
  await rm(join(root, 'metrics', 'jobs.jsonl'));
  const row = await fleetRow();
  expect(row['finished']).toBe(1);
  expect((row['sources'] as Record<string, unknown>)['metrics']).toBe('missing');
});
