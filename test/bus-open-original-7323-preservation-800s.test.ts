import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';
import { cmdFleetWorkFeed } from '../src/cli/fleet-work-feed.js';
import { projectBusWorkFeedView, readBusWorkFeed } from '../src/core/agents/bus-work-feed-read.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

const root = mkdtempSync(join(tmpdir(), 'bus-original-7323-'));
const now = 1_800_000_000_000;
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('preserves open candidates and hold evidence across both feed CLIs', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  let cursor = 0;
  const append = (body: unknown) => expect(appendBusInbox({ id: `fake-msg-${++cursor}`, from: 'fake-agent',
    to: 'leaders', priority: 'P2', ttl: 1000, body }, { root, now: () => now }).status).toBe('posted');
  const post = (id: string, claimKeys: string[]) => append({ kind: 'work.post', jobId: id, title: id,
    repo: 'fake/repo', provider: 'devin', claimKeys });
  post('fake-open', ['queue:RQ-OPEN']);
  post('fake-held', ['queue:RQ-HELD']);
  post('fake-part', ['queue:RQ-PART-A', 'queue:RQ-PART-B']);
  post('fake-keyless', []);
  post('fake-done', ['queue:RQ-DONE']);
  append({ kind: 'work.status', jobId: 'fake-done', status: 'done' });
  post('fake-rescheduled', ['queue:RQ-RESCHEDULED']);
  append({ kind: 'work.status', jobId: 'fake-rescheduled', status: 'rescheduled' });
  for (const key of ['queue:RQ-HELD', 'queue:RQ-PART-A']) {
    expect(acquireCoordination({ root, origin: 'resource', key, owner: 'fake-holder', leaseMs: 60_000,
      leaseUntil: now + 60_000, sourceId: `work:${key}`, now }).status).toBe('acquired');
  }
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const both = async (args: string[]) => {
    const out: string[] = [];
    expect(await runAgentsBusUnified(['work', 'feed', '--root', root, '--json', ...args], t => out.push(t), () => {}, {})).toBe(0);
    log.mockClear();
    expect(await cmdFleetWorkFeed(['--root', root, '--json', ...args])).toBe(0);
    const unified = JSON.parse(out.join('\n'));
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(unified);
    return unified;
  };
  const complete = await both(['--open']);
  expect(complete.jobs.map((j: { id: string }) => j.id).sort()).toEqual(['fake-open', 'fake-part', 'fake-rescheduled']);
  expect(complete.claims).toMatchObject({ source: 'available', truncated: false,
    holds: [expect.objectContaining({ jobId: 'fake-part', claimKey: 'queue:RQ-PART-A' })] });
  expect((await both(['--open', '--status', 'rescheduled'])).jobs.map((j: { id: string }) => j.id)).toEqual(['fake-rescheduled']);
  expect((await both(['--open', '--status', 'done'])).jobs).toEqual([]);
  const read = readBusWorkFeed({ root, claims: true });
  if (read.status !== 'ok' || !read.claims) throw new Error('fixture feed unavailable');
  const truncated = projectBusWorkFeedView({ ...read, claims: { ...read.claims, truncated: true } }, { open: true });
  expect(truncated.status === 'ok' && truncated.jobs.map(j => j.id).sort()).toEqual(['fake-held', 'fake-open', 'fake-part', 'fake-rescheduled']);
  writeFileSync(join(root, 'coordination', 'claims.json'), 'invalid JSON');
  const unknown = await both(['--open']);
  expect(unknown.claims.source).toBe('unavailable');
  expect(unknown.jobs.map((j: { id: string }) => j.id).sort()).toEqual(['fake-held', 'fake-open', 'fake-part', 'fake-rescheduled']);
  expect(unknown.jobs.every((j: { claimable: unknown }) => j.claimable === null)).toBe(true);
  expect((await both(['--open', '--claimable'])).jobs).toEqual([]);
}, 60_000);
