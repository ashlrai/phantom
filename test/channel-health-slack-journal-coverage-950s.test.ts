import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const sends = vi.hoisted(() => vi.fn());
vi.mock('../src/core/agents/slack-send-receipts.js', () => ({ readSlackSendReceipts: sends }));
import { readSlackJournal, slackBridgeDir, slackJournalPath, SLACK_JOURNAL_MAX_BYTES } from '../src/core/agents/slack-journal.js';
import { defaultChannelSources, readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const request = { at: '2026-11-13T17:30:00.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKELEADER', messageTs: '1700000000.000100', threadTs: '1700000000.000100', requestId: fakeRequestId('950s') };
const ignored = { at: '2026-11-13T17:59:00Z', decision: 'ignored' };
const padding = () => Array.from({ length: 4096 }, () => ignored);
const other: ChannelSource = { configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [] };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function journal(rows: object[], suffix = '') {
  const root = mkdtempSync(`${tmpdir()}/slack-950s-`);
  roots.push(root);
  mkdirSync(slackBridgeDir(root), { mode: 0o700 });
  const body = rows.map((row) => `${JSON.stringify(row)}\n`).join('') + suffix;
  expect(Buffer.byteLength(body)).toBeLessThan(SLACK_JOURNAL_MAX_BYTES);
  writeFileSync(slackJournalPath(root), body, { mode: 0o600 });
  return root;
}
async function health(root: string, answered = false) {
  sends.mockReturnValue({ state: 'ok', receipts: answered ? [{ key: replyKey(request.requestId),
    channel: request.channelId, thread: request.threadTs, state: 'sent', ts: '1700000000.000200' }] : [] });
  const slack = { ...defaultChannelSources(root).slack, configMissing: () => [], processAlive: () => true };
  return (await readChannelHealth({ now: () => now, host: 'fake-host', sources: { slack, imessage: other } })).channels[0]!;
}

it('reports valid projection omission separately from malformed storage', () => {
  const root = journal([request, ignored]);
  expect(readSlackJournal({ runsDir: root, limit: 1 })).toMatchObject({ state: 'ok', entries: [ignored], projectionOmitted: true });
  expect(readSlackJournal({ runsDir: root, limit: 2 })).toMatchObject({ state: 'ok', projectionOmitted: false });
  const damaged = journal([ignored], 'null\n');
  expect(readSlackJournal({ runsDir: damaged, limit: 1 })).toMatchObject({ state: 'degraded', entries: [ignored], projectionOmitted: false });
});
it('cannot certify idle health when newer ignored rows hide an overdue request', async () => {
  const root = journal([request, ...padding()]);
  expect(readSlackJournal({ runsDir: root, limit: 4096 })).toMatchObject({ state: 'ok', projectionOmitted: true });
  const result = await health(root);
  expect(result).toMatchObject({ state: 'UNKNOWN', unansweredCount: 0, proof: { requestCoverage: 'unproven' },
    missing: ['slack inbound journal projection incomplete'] });
  expect(JSON.stringify(result)).not.toContain(request.requestId);
  expect(JSON.stringify(result)).not.toContain(request.channelId);
});
it('retains visible overdue failure evidence when observations are omitted', async () => {
  expect(await health(journal([...padding(), request]))).toMatchObject({ state: 'DEGRADED', unansweredCount: 1,
    proof: { requestCoverage: 'unproven' }, missing: ['slack inbound journal projection incomplete'] });
});
it('retains a visible recent durable ingress failure with omitted observations', async () => {
  expect(await health(journal([...padding(), { ...request, at: ignored.at, bus: 'failed' }]))).toMatchObject({
    state: 'DEGRADED', proof: { requestCoverage: 'unproven', durableIngress: { failed: 1 } },
    missing: expect.arrayContaining(['slack inbound journal projection incomplete', 'slack durable ingress failed']) });
});
it('does not verify partial coverage even when every visible request is answered', async () => {
  expect(await health(journal([...padding(), request]), true)).toMatchObject({ state: 'UNKNOWN', unansweredCount: 0,
    proof: { requestCoverage: 'unproven', answeredCount: 1 } });
});
it('preserves complete empty and answered health', async () => {
  expect(await health(journal([]))).toMatchObject({ state: 'LIVE', proof: { requestCoverage: 'idle' }, missing: [] });
  expect(await health(journal([request]), true)).toMatchObject({ state: 'LIVE', unansweredCount: 0,
    proof: { requestCoverage: 'verified', answeredCount: 1 }, missing: [] });
});
