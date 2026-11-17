import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackEvidence } from '../src/cli/fleet-slack-evidence.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const thread = '1731000000.000100';
const now = () => new Date('2024-11-07T18:00:00.000Z');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const rid = (index: number) => fakeRequestId(`443s:${index}`);

function fixture(times: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'slack-443s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true });
  mkdirSync(stateRoot);
  const entries = times.map((at, i) => ({ at, decision: 'ingested', bus: 'posted', channelId: 'C0FAKE0001',
    threadTs: thread, messageTs: `17310000${10 + i}.000100`, requestId: rid(i), authorId: 'UFAKE', text: 'private text' }));
  const messages = Object.fromEntries(times.map((_, i) => [replyKey(rid(i)), { channel: 'C0FAKE0001', thread,
    state: 'sent', ts: `17310023${90 + i}.000100`, digest: 'fake-digest', clientId: 'fake-client' }]));
  const journal = entries.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal.length === 0 ? journal : `${journal}\n`);
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }));
  return { root, runsDir, stateRoot, now };
}

it.each([
  ['recent', ['2024-11-07T17:59:30.000Z'], 0, 'fresh'],
  ['old', ['2024-11-07T12:00:00.000Z'], 1, 'stale'],
  ['mixed', ['2024-11-07T12:00:00.000Z', '2024-11-07T17:59:30.000Z'], 1, 'stale'],
  ['future', ['2024-11-07T18:00:01.000Z'], 1, 'stale'],
  ['absent', [], 1, 'unknown'],
] as const)('%s persisted observations', async (_name, times, code, verdict) => {
  const deps = fixture([...times]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(['--thread', thread, '--max-age-seconds', '60', '--json'], deps)).toBe(code);
  const output = String(log.mock.calls[0]![0]);
  const bundle = JSON.parse(output);
  expect(bundle.sources).toEqual({ journal: 'ok', sends: 'ok' });
  expect(bundle.freshness).toMatchObject({ maxAgeSeconds: 60, verdict });
  expect(bundle.asOf).toBe(now().toISOString());
  expect(bundle.rows.map((row: { at: string }) => row.at)).toEqual([...times].sort());
  expect(bundle.rows.map((row: { outcome: string }) => row.outcome)).toEqual([...times].sort().map((at) =>
    Date.parse(at) <= now().getTime() ? 'answered' : 'unanswered'));
  for (const forbidden of ['UFAKE', 'private text', 'fake-digest', 'fake-client', deps.root, ...times.map((_, i) => rid(i))]) {
    expect(output).not.toContain(forbidden);
  }
});

it.each([undefined, 'abc', '1.5', '0', '-1', '9007199254740992'])('rejects age %s before reading', async (age) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = ['--thread', thread, '--json', '--max-age-seconds', ...(age === undefined ? [] : [age])];
  expect(await cmdFleetSlackEvidence(args, { now: () => { throw new Error('read attempted'); } })).toBe(2);
  expect(log).toHaveBeenCalledOnce();
});

it('preserves the no-option invocation for old answered evidence', async () => {
  const deps = fixture(['2024-11-07T12:00:00.000Z']);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackEvidence(['--thread', thread, '--json'], deps);
  const bundle = JSON.parse(String(log.mock.calls[0]![0]));
  expect(code).toBe(0);
  expect(bundle.rows.map((row: { outcome: string }) => row.outcome)).toEqual(['answered']);
  expect(bundle.freshness).toBeUndefined();
});
