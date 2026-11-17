import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackEvidence } from '../src/cli/fleet-slack-evidence.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';

const thread = '1731000000.000100';
const now = () => new Date('2024-11-07T18:00:00.000Z');
const request = { at: '2024-11-07T12:00:00.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE0001', threadTs: thread, messageTs: '1731000010.000100', authorId: 'UFAKE', text: 'private text',
  requestId: fakeRequestId('441s') };
const storeKey = replyKey(request.requestId);
const sent = { channel: request.channelId, thread, state: 'sent', ts: '1731000050.000100',
  digest: 'synthetic-digest', clientId: 'synthetic-client' };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(journal?: string, messages?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'slack-441s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  if (journal !== undefined) writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal.endsWith('\n') || journal.length === 0 ? journal : `${journal}\n`, { mode: 0o600 });
  if (messages !== undefined) writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { root, runsDir, stateRoot, now };
}

it.each([
  ['posted and sent', JSON.stringify(request), { [storeKey]: sent }, thread, 0, 'ok', 'ok', 'answered'],
  ['missing', undefined, undefined, thread, 1, 'missing', 'missing', undefined],
  ['degraded journal', JSON.stringify(request) + '\ninvalid', { [storeKey]: sent }, thread, 1, 'degraded', 'ok', 'answered'],
  ['degraded sends', JSON.stringify(request), { [storeKey]: sent, bad: {} }, thread, 1, 'ok', 'degraded', 'answered'],
  ['failed ingress', JSON.stringify({ ...request, bus: 'failed' }), { [storeKey]: sent }, thread, 1, 'ok', 'ok', 'bus-failed'],
  ['legacy ingress', JSON.stringify({ ...request, bus: undefined }), { [storeKey]: sent }, thread, 1, 'ok', 'ok', 'uncertain'],
  ['no match', JSON.stringify(request), { [storeKey]: sent }, '1731002000.000100', 1, 'ok', 'ok', undefined],
] as const)('%s', async (_name, journal, messages, requested, code, journalState, sendsState, outcome) => {
  const deps = fixture(journal, messages);
  const before = journal === undefined ? undefined : readFileSync(join(deps.runsDir, 'slack-bridge', 'journal.jsonl'), 'utf8');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(['--thread', requested, '--json'], deps)).toBe(code);
  expect(log).toHaveBeenCalledTimes(1);
  const output = String(log.mock.calls[0]![0]);
  const bundle = JSON.parse(output);
  const trace = readSlackRequestTrace({ ...deps, thread: requested });
  expect(bundle).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: requested, ...trace });
  expect(bundle.sources).toEqual({ journal: journalState, sends: sendsState });
  expect(bundle.rows.map((row: { outcome: string }) => row.outcome)).toEqual(outcome ? [outcome] : []);
  expect(bundle.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
  for (const forbidden of ['UFAKE', 'private text', storeKey, request.requestId, 'synthetic-digest', 'synthetic-client', deps.root, 'ASSIGNED', 'RUNNING', 'VERIFIED']) expect(output).not.toContain(forbidden);
  if (before !== undefined) expect(readFileSync(join(deps.runsDir, 'slack-bridge', 'journal.jsonl'), 'utf8')).toBe(before);
});

it.each([[], ['--json'], ['--thread'], ['--thread', 'invalid', '--json'], ['--thread', thread],
  ['--thread', thread, '--json', '--unknown'], ['--thread', thread, '--thread', thread, '--json'],
  ['--thread', thread, '--json', '--json']])('rejects invalid arguments %j', async (...args) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackEvidence(args, fixture())).toBe(2);
  expect(log).toHaveBeenCalledOnce();
});
