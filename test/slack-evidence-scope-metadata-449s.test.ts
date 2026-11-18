import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const thread = '1731000000.000100';
const channelA = 'C0FAKE0001';
const channelB = 'C0FAKE0002';
const channelEmpty = 'C0FAKE9999';
const now = () => new Date('2024-11-07T18:00:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const rid = (channelId: string, messageTs: string) => fakeRequestId(`449s:${channelId}:${messageTs}`);
const entry = (channelId: string, at: string, messageTs: string, bus?: string) => ({
  at, decision: 'ingested', ...(bus === undefined ? {} : { bus }), channelId, threadTs: thread, messageTs,
  requestId: rid(channelId, messageTs),
});
const sent = (channel: string, ts: string) => ({ channel, thread, state: 'sent', ts });

function fixture(journal: string, messages: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'slack-449s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { runsDir, stateRoot, now };
}

const journal = [
  entry(channelA, '2024-11-07T17:59:30.000Z', '1731000010.000100', 'posted'),
  entry(channelB, '2024-11-07T12:00:00.000Z', '1731000020.000100', 'posted'),
].map((row) => JSON.stringify(row)).join('\n') + '\n';
const messages = { [replyKey(rid(channelA, '1731000010.000100'))]: sent(channelA, '1731002390.000100') };

it('keeps distinct channels on the same thread root distinguishable', () => {
  const deps = fixture(journal, messages);
  const a = readSlackEvidenceBundle(thread, { ...deps, channelId: channelA });
  const b = readSlackEvidenceBundle(thread, { ...deps, channelId: channelB });
  expect(a.collectionScope).toEqual({ thread, channelId: channelA });
  expect(b.collectionScope).toEqual({ thread, channelId: channelB });
  expect(a.rows.map((row) => row.channelId)).toEqual([channelA]);
  expect(b.rows.map((row) => row.channelId)).toEqual([channelB]);
  expect(a.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(b.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
});

it('retains collection scope on an empty scoped read', () => {
  const deps = fixture(journal, messages);
  const bundle = readSlackEvidenceBundle(thread, { ...deps, channelId: channelEmpty, maxAgeSeconds: 60 });
  expect(bundle.rows).toEqual([]);
  expect(bundle.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(bundle.freshness).toMatchObject({ verdict: 'unknown', maxAgeSeconds: 60 });
  expect(bundle.collectionScope).toEqual({ thread, channelId: channelEmpty });
  expect(bundle.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
});

it('does not invent a channel on an unscoped read', () => {
  const deps = fixture(journal, messages);
  const bundle = readSlackEvidenceBundle(thread, deps);
  expect(bundle.rows).toHaveLength(2);
  expect(bundle.collectionScope).toEqual({ thread });
  expect(bundle.collectionScope).not.toHaveProperty('channelId');
});

it('rejects malformed thread and channel before any disk read', () => {
  const deps = fixture(journal, messages);
  const nowThrows = () => { throw new Error('read attempted'); };
  for (const bad of ['not-a-ts', '../etc/passwd', '1731000000', '', '1731000000.000100.extra']) {
    expect(() => readSlackEvidenceBundle(bad, { ...deps, now: nowThrows })).toThrow('slack-thread-invalid');
  }
  for (const bad of ['bad-channel', 'c0fake0001', 'C', '', 'C0FAKE0001/../x']) {
    expect(() => readSlackEvidenceBundle(thread, { ...deps, channelId: bad, now: nowThrows })).toThrow('slack-channel-invalid');
  }
  try {
    readSlackEvidenceBundle('bad thread', deps);
    expect.unreachable();
  } catch (error) {
    expect(String(error)).not.toContain(deps.runsDir);
    expect(String(error)).not.toContain('bad thread');
  }
});
