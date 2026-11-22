/**
 * fleet context-pack merges section: `phm fleet context-pack build` must show
 * the merge evidence the fleet actually records. dispatchd writes merge
 * verdicts to metrics/jobs.jsonl (reconciler terminal rows plus the
 * merged/outcome dialects) while dispatch-events.log carries no stamped
 * outcome lines in production, so an events-log-only scan rendered the
 * section empty over a ledger full of landed work. The fold reads the same
 * bounded jobs-ledger tail the finished count uses, through the shared
 * jobs-ledger dialect; a missing ledger degrades to stamped event lines and
 * sources.metrics already reports the ledger's health.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack } from '../src/core/fleet/context-pack.js';

let root: string;
const now = 1793577600000;
const options = (merges?: number) => ({ job: 'JOB-1', lane: 'claude', root: join(root, 'bus'), runsDir: root, home: root, now: () => now, merges });
const status = () => JSON.stringify({
  last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
  lanes: { claude: { running: 1, target: 2, queued: 0, held: false, held_reason: null } },
});
const EVENTS = '2026-11-01 00:00:00 LAUNCH JOB-LEDGER-1 phantom claude work\n' +
  '2026-11-01 00:05:00 FLEET_SHED level 0->1 (mem) mode=enforce\n';
const row = (value: object): string => JSON.stringify(value);
const LEDGER = [
  // Newest merge first in the section: J-NEW merged after J-OLD.
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-OLD', prUrl: 'https://github.com/ashlrai/phantom/pull/11', outcome: 'MERGED', mergedAt: '2026-11-01T00:30:00+00:00', ts: '2026-11-01T00:31:00+00:00', repo: 'ashlrai/phantom', lane: 'devin' }),
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-NEW', prUrl: 'https://github.com/ashlrai/phantom/pull/12', outcome: 'MERGED', mergedAt: '2026-11-01T02:30:00+00:00', ts: '2026-11-01T02:31:00+00:00', repo: 'ashlrai/phantom', lane: 'claude' }),
  // Closed is a verdict but never a merge; open claims and launches are not merges either.
  row({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-CLOSED', prUrl: 'https://github.com/ashlrai/phantom/pull/13', outcome: 'CLOSED', closedAt: '2026-11-01T03:00:00+00:00', ts: '2026-11-01T03:01:00+00:00' }),
  row({ event: 'publish', jobId: 'J-OPEN', prUrl: 'https://github.com/ashlrai/phantom/pull/14', outcome: 'OPEN', ts: '2026-11-01T03:30:00+00:00' }),
  row({ event: 'launch', job: 'J-LIVE', repo: 'ashlrai/phantom', lane: 'devin', tier: 'work', ts: '2026-11-01T04:00:00+00:00' }),
  // The other ledger dialects that resolve MERGED.
  row({ event: 'outcome', state: 'MERGED', job: 'J-DIALECT', pr: 'https://github.com/ashlrai/phantom/pull/15', ts: '2026-11-01T05:00:00+00:00' }),
  row({ merged: true, jobId: 'J-FLAG', prUrl: 'https://github.com/ashlrai/phantom/pull/16', timestamp: '2026-11-01T06:00:00+00:00' }),
  // Unattributable (no job, no PR) and unstamped verdicts stay out.
  row({ merged: true, ts: '2026-11-01T07:00:00+00:00' }),
  row({ event: 'outcome', state: 'MERGED', job: 'J-NOSTAMP' }),
  'not json at all',
].join('\n') + '\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-merges-'));
  await mkdir(join(root, 'queue'));
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'queue', 'status.json'), status());
  await writeFile(join(root, 'queue', 'dispatch-events.log'), EVENTS);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), LEDGER);
  expect(appendBusInbox({ id: 'seed', from: 'core', to: 'claude', priority: 'P2', ttl: 60000, body: { text: 'seed' } }, options()).status).toBe('posted');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

interface Pack { sections: { name: string; rows: Record<string, unknown>[] }[] }
const mergesSection = async (merges?: number): Promise<Record<string, unknown>[]> => {
  const pack = JSON.parse(await buildContextPack(options(merges))) as Pack;
  return pack.sections.find(section => section.name === 'merges')!.rows;
};

it('surfaces jobs-ledger MERGED verdicts newest-first with job, PR, repo, lane and stamp', async () => {
  const rows = await mergesSection();
  expect(rows.map(row => row['job'])).toEqual(['J-FLAG', 'J-DIALECT', 'J-NEW', 'J-OLD']);
  const newest = rows[2]!;
  expect(newest['pr']).toBe('https://github.com/ashlrai/phantom/pull/12');
  expect(newest['repo']).toBe('ashlrai/phantom');
  expect(newest['lane']).toBe('claude');
  expect(newest['at']).toBe('2026-11-01T02:30:00.000Z');
  expect(newest['source']).toBe(join(root, 'metrics', 'jobs.jsonl'));
});

it('keeps one row per job when the ledger repeats a merge verdict', async () => {
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), LEDGER + row({
    event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-NEW',
    prUrl: 'https://github.com/ashlrai/phantom/pull/12', outcome: 'MERGED',
    mergedAt: '2026-11-01T02:45:00+00:00', ts: '2026-11-01T02:46:00+00:00',
  }) + '\n');
  const rows = await mergesSection();
  expect(rows.filter(entry => entry['job'] === 'J-NEW')).toHaveLength(1);
  expect(rows.map(entry => entry['job'])).toEqual(['J-FLAG', 'J-DIALECT', 'J-NEW', 'J-OLD']);
});

it('honors the merges budget across the section', async () => {
  expect((await mergesSection(2)).map(row => row['job'])).toEqual(['J-FLAG', 'J-DIALECT']);
  expect(await mergesSection(0)).toEqual([]);
});

it('still surfaces stamped event-log merge lines and degrades honestly without the ledger', async () => {
  await writeFile(join(root, 'queue', 'dispatch-events.log'),
    '2026-11-01 23:50:00 LAUNCH JOB-D phantom claude opus code\n' +
    '2026-11-02 00:00:00 OUTCOME JOB-D merged usage=0.2\n');
  await rm(join(root, 'metrics', 'jobs.jsonl'));
  const rows = await mergesSection();
  expect(rows).toHaveLength(1);
  expect(rows[0]!['source']).toBe(join(root, 'queue', 'dispatch-events.log'));
  expect(String(rows[0]!['text'])).toContain('OUTCOME JOB-D merged');
});
