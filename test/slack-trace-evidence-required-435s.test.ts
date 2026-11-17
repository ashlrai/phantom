import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';

const roots: string[] = [];
const thread = '1731000000.000100';
const reply = '1731000050.000100';
const now = () => new Date('2024-11-07T18:00:00.000Z');
const request = { at: '2024-11-07T12:00:00.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE0001', threadTs: thread, messageTs: '1731000010.000100', requestId: fakeRequestId('435s:1') };
const key = replyKey(request.requestId);
const sent = { channel: request.channelId, thread, state: 'sent', ts: reply };
const stored = { [key]: sent };
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(journal?: string, messages?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'slack-evidence-435s-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  if (journal !== undefined) writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), journal, { mode: 0o600 });
  if (messages !== undefined) writeFileSync(join(stateRoot, 'messages.json'),
    JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return { root, runsDir, stateRoot, now };
}

// Include directories, bytes, modes and mtimes: reads must neither create nor alter evidence.
function snapshot(root: string) {
  return ['', ...readdirSync(root, { recursive: true }).map(String).sort()].map((path) => {
    const full = join(root, path);
    const stat = statSync(full);
    return [path, stat.mode, stat.mtimeMs, stat.isFile() ? readFileSync(full, 'hex') : null];
  });
}

const ingested = JSON.stringify(request) + '\n';
it.each([
  ['answered', ingested, stored, [], 0, 'ok', 'ok', 'answered'],
  ['answered filtered thread', ingested, stored, ['--thread', thread], 0, 'ok', 'ok', 'answered'],
  ['both missing', undefined, undefined, [], 1, 'missing', 'missing', undefined],
  ['journal missing', undefined, stored, [], 1, 'missing', 'ok', undefined],
  ['sends missing', ingested, undefined, [], 1, 'ok', 'missing', 'unanswered'],
  ['empty stores', '', {}, [], 1, 'ok', 'ok', undefined],
  ['ignored only', `${JSON.stringify({ ...request, decision: 'ignored' })}\n`, stored, [], 1, 'ok', 'ok', undefined],
  ['unmatched thread', ingested, stored, ['--thread', '1731002000.000100'], 1, 'ok', 'ok', undefined],
  ['degraded journal with answered row', ingested + 'invalid\n', stored, [], 1, 'degraded', 'ok', 'answered'],
  ['degraded sends with answered row', ingested, { ...stored, invalid: {} }, [], 1, 'ok', 'degraded', 'answered'],
  ['unanswered', ingested, {}, [], 1, 'ok', 'ok', 'unanswered'],
  // The degraded probe: a store row under a non-hex key is invalid, so the whole store is degraded.
  ['invalid store key', ingested, { sent }, [], 1, 'ok', 'degraded', 'unanswered'],
  ['uncertain', ingested, { [key]: { ...sent, state: 'attempted' } }, [], 1, 'ok', 'ok', 'uncertain'],
  ['bus failed', `${JSON.stringify({ ...request, bus: 'failed' })}\n`, {}, [], 1, 'ok', 'ok', 'bus-failed'],
] as const)('%s requires durable matching evidence', async (_name, journal, messages, args, code, journalState, sendsState, outcome) => {
  const deps = fixture(journal, messages);
  const before = snapshot(deps.root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackTrace([...args, '--json'], deps)).toBe(code);
  expect(log).toHaveBeenCalledTimes(1);
  const trace = JSON.parse(String(log.mock.calls[0]![0]));
  expect(Object.keys(trace).sort()).toEqual(['asOf', 'collectionScope', 'counts', 'rows', 'scope', 'sources']);
  expect(trace.asOf).toBe(now().toISOString());
  expect(trace.sources).toEqual({ journal: journalState, sends: sendsState });
  expect(trace.rows.map((row: { outcome: string }) => row.outcome)).toEqual(outcome ? [outcome] : []);
  expect(trace.counts.total).toBe(outcome ? 1 : 0);
  expect(snapshot(deps.root)).toEqual(before);
});

it('requires every request to be answered', async () => {
  const deps = fixture(ingested + JSON.stringify({ ...request, messageTs: '1731000020.000100', requestId: fakeRequestId('435s:2') }), stored);
  const before = snapshot(deps.root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackTrace(['--json'], deps)).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0])).counts).toEqual({
    total: 2, answered: 1, uncertain: 0, busFailed: 0, unanswered: 1,
  });
  expect(snapshot(deps.root)).toEqual(before);
});

it('explains absent evidence in human output without claiming work', async () => {
  const deps = fixture();
  const before = snapshot(deps.root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetSlackTrace([], deps)).toBe(1);
  expect(log.mock.calls.map(([line]) => line)).toEqual([
    `slack trace as of ${now().toISOString()} (journal=missing sends=missing) scope: channel=all thread=all; Bounded local persisted journal and send evidence only; does not prove current runtime reachability.`,
    'No matching request evidence; verification unsuccessful.',
  ]);
  expect(snapshot(deps.root)).toEqual(before);
});

it.each([['--help'], ['-h'], ['--thread'], ['--thread', 'invalid'], ['--unknown']])(
  'preserves help and usage handling: %j', async (...args) => {
    const deps = fixture();
    const before = snapshot(deps.root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetSlackTrace(args, deps)).toBe(args[0] === '--help' || args[0] === '-h' ? 0 : 2);
    expect(snapshot(deps.root)).toEqual(before);
  });
