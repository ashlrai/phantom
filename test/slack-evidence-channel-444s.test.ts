import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { cmdFleetSlackEvidence } from '../src/cli/fleet-slack-evidence.js';

const thread = '1731000000.000100';
const channelA = 'C0FAKE0001';
const channelB = 'C0FAKE0002';
const now = () => new Date('2024-11-07T18:00:00.000Z');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const rid = (channelId: string, ts: string) => fakeRequestId(`444s:${channelId}:${ts}`);
const entry = (channelId: string, at: string, messageTs: string, bus?: string) => ({
  at, decision: 'ingested', ...(bus === undefined ? {} : { bus }), channelId, threadTs: thread, messageTs, requestId: rid(channelId, messageTs),
});
const sent = (channel: string, ts: string) => ({ channel, thread, state: 'sent', ts });

function fixture(journal: string, messages: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'slack-444s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { root, runsDir, stateRoot, now };
}

function snapshot(root: string) {
  return readdirSync(root, { recursive: true }).map(String).sort().map((path) => {
    const full = join(root, path); const stat = statSync(full);
    return [path, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(full, 'hex') : null];
  });
}

it('scopes shared-thread rows by channel and recomputes counts and freshness', async () => {
  const rows = [
    entry(channelA, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'posted'),
    entry(channelB, '2024-11-07T12:00:00.000Z', '1731000020.000100', 'posted'),
  ];
  const deps = fixture(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    [replyKey(rid(channelA, '1731000010.000100'))]: sent(channelA, '1731002390.000100'),
  });
  const before = snapshot(deps.root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const call = async (extra: string[]) => {
    const code = await cmdFleetSlackEvidence(['--thread', thread, ...extra, '--json'], deps);
    return { code, bundle: JSON.parse(String(log.mock.calls.at(-1)![0])) };
  };

  const fresh = await call(['--channel', channelA, '--max-age-seconds', '60']);
  expect(fresh.code).toBe(0);
  expect(fresh.bundle.rows).toHaveLength(1);
  expect(fresh.bundle.rows[0]).toMatchObject({ channelId: channelA, outcome: 'answered', ingress: 'posted' });
  expect(fresh.bundle.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(fresh.bundle.freshness).toMatchObject({ verdict: 'fresh', maxAgeSeconds: 60 });

  const stale = await call(['--channel', channelB, '--max-age-seconds', '60']);
  expect(stale.code).toBe(1);
  expect(stale.bundle.rows).toHaveLength(1);
  expect(stale.bundle.rows[0]).toMatchObject({ channelId: channelB, outcome: 'unanswered' });
  expect(stale.bundle.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
  expect(stale.bundle.freshness.verdict).toBe('stale');

  const all = await call(['--max-age-seconds', '60']);
  expect(all.code).toBe(1);
  expect(all.bundle.rows.map((row: { channelId: string }) => row.channelId)).toEqual([channelB, channelA]);
  expect(all.bundle.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 0, unanswered: 1 });
  expect(all.bundle.freshness.verdict).toBe('stale');
  expect(snapshot(deps.root)).toEqual(before);
});

it('returns empty unknown freshness for an absent channel', async () => {
  const deps = fixture(`${JSON.stringify(entry(channelA, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'posted'))}\n`, {
    [replyKey(rid(channelA, '1731000010.000100'))]: sent(channelA, '1731002390.000100'),
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(['--thread', thread, '--channel', 'C0FAKE9999', '--max-age-seconds', '60', '--json'], deps)).toBe(1);
  const bundle = JSON.parse(String(log.mock.calls[0]![0]));
  expect(bundle.rows).toEqual([]);
  expect(bundle.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(bundle.freshness).toMatchObject({ verdict: 'unknown', maxAgeSeconds: 60 });
  expect(bundle.sources).toEqual({ journal: 'ok', sends: 'ok' });
});

it.each([
  ['duplicate', ['--thread', thread, '--channel', channelA, '--channel', channelB, '--json']],
  ['invalid', ['--thread', thread, '--channel', 'bad-channel', '--json']],
  ['missing', ['--thread', thread, '--channel', '--json']],
])('rejects %s channel input before reads', async (_name, args) => {
  const deps = fixture('', {});
  deps.now = () => { throw new Error('read attempted'); };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(args, deps)).toBe(2);
  expect(log).toHaveBeenCalledOnce();
  expect(String(log.mock.calls[0]![0])).not.toContain('bad-channel');
});

it('keeps degraded sources degraded after channel filtering', async () => {
  const deps = fixture(`${JSON.stringify(entry(channelA, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'posted'))}\ninvalid\n`, {
    [replyKey(rid(channelA, '1731000010.000100'))]: sent(channelA, '1731002390.000100'), bad: {},
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(['--thread', thread, '--channel', channelA, '--max-age-seconds', '60', '--json'], deps)).toBe(1);
  const bundle = JSON.parse(String(log.mock.calls[0]![0]));
  expect(bundle.sources).toEqual({ journal: 'degraded', sends: 'degraded' });
  expect(bundle.rows).toHaveLength(1);
  expect(bundle.rows[0]).toMatchObject({ channelId: channelA, outcome: 'answered' });
  expect(bundle.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(bundle.freshness.verdict).toBe('fresh');
});

it('preserves bus-failed and unknown-ingress exit failures', async () => {
  const rows = [
    entry(channelA, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'failed'),
    entry(channelA, '2024-11-07T17:59:31.000Z', '1731000020.000100'),
  ];
  const deps = fixture(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
    [replyKey(rid(channelA, '1731000010.000100'))]: sent(channelA, '1731002390.000100'),
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(['--thread', thread, '--channel', channelA, '--max-age-seconds', '60', '--json'], deps)).toBe(1);
  const bundle = JSON.parse(String(log.mock.calls[0]![0]));
  expect(bundle.rows.map((row: { ingress: string; outcome: string }) => ({ ingress: row.ingress, outcome: row.outcome }))).toEqual([
    { ingress: 'failed', outcome: 'bus-failed' }, { ingress: 'unknown', outcome: 'unanswered' },
  ]);
  expect(bundle.counts).toEqual({ total: 2, answered: 0, uncertain: 0, busFailed: 1, unanswered: 1 });
  expect(bundle.freshness.verdict).toBe('fresh');
});
