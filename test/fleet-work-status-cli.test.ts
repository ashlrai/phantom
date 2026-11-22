import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkStatus } from '../src/cli/fleet-work-status.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { readSlackWorkStatus, slackWorkStatusLine } from '../src/core/agents/slack-status.js';

let directory: string, root: string, runs: string;
const now = Date.parse('2026-11-21T12:00:00.000Z');
const iso = new Date(now).toISOString();
const id = 'fake-work-status';
function snapshot(path: string): unknown {
  return readdirSync(path).sort().map(name => {
    const file = join(path, name), stat = statSync(file);
    return [name, stat.mtimeMs, stat.isDirectory() ? snapshot(file) : readFileSync(file, 'utf8')];
  });
}
function post(channel: 'slack' | 'imessage' = 'slack') {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-worker', priority: 'P1', ttl: 10_000_000,
    channel, channel_ref: channel === 'slack' ? 'slack:T0FAKE:C0FAKE:1700000000.000100' : 'fake-imessage-thread',
    sender: { agent_id: 'fake-requester', vendor: 'fake', human: true, team: true }, external: false,
    body: { text: 'routed, running, verified' } }, { root, now: () => now }).status).toBe('posted');
}
async function read(args: string[] = [id, '--json']) {
  const before = snapshot(directory);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkStatus(args)).toBe(0);
  const output = String(log.mock.calls.at(-1)![0]);
  expect(snapshot(directory)).toEqual(before);
  return args.includes('--json') ? JSON.parse(output) : output;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fleet-work-status-'));
  runs = join(directory, 'runs'); root = join(directory, 'ashlr', 'fleet');
  vi.stubEnv('ASHLR_HOME', join(directory, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', runs);
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it('registers the verb and reads exact ingress journal identities without assigning work', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['work-status']!()).cmdFleetWorkStatus).toBe(cmdFleetWorkStatus);
  mkdirSync(join(runs, 'slack-bridge'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runs, 'slack-bridge/journal.jsonl'), JSON.stringify({ at: iso, eventId: id,
    decision: 'ingested', bus: 'failed' }) + '\n', { mode: 0o600 });
  expect(await read()).toMatchObject({ state: 'RECEIVED', asOf: iso, source: 'slack-bridge/journal.jsonl', sources: { inbox: 'missing', claims: 'missing', journal: 'ok' } });
  expect(await read(['different', '--json'])).toMatchObject({ state: 'RECEIVED', asOf: 'unknown', missing: expect.arrayContaining(['ingress receipt']) });
});

it.each(['slack', 'imessage'] as const)('reads %s bus claims and PR/head replies without modifying stores', async channel => {
  post(channel);
  expect(await read()).toMatchObject({ state: 'RECEIVED', source: 'bus-inbox/messages.json' });
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 60_000, root }).status).toBe('acquired');
  expect(await read()).toMatchObject({ state: 'RUNNING', owner: 'fake-worker', asOf: iso });
  vi.mocked(Date.now).mockReturnValue(now + 32 * 60_000);
  expect(await read()).toMatchObject({ state: 'ASSIGNED', missing: ['fresh running evidence'] });
  expect(postBusReply(id, 'fake-block', { blocked: { dependency: 'review PR 7' } }, { root, now: () => now }).outcome).toBe('posted');
  expect(await read()).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:fake-block' });
  expect(postBusReply(id, 'fake-verified', { verified: { pr: 7, head: 'a'.repeat(40) } }, { root, now: () => now }).outcome).toBe('posted');
  expect(await read()).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-verified' });
  expect(await read([id])).toBe(`VERIFIED · fake-worker · as of ${iso} · source bus-reply:fake-verified`);
});

it('uses the item evidence clock and missing proof in the Slack reply', () => {
  post();
  const work = readSlackWorkStatus({ runsDir: runs, busRoot: root, now: () => new Date(now) });
  expect(slackWorkStatusLine(work, { inReplyTo: id }))
    .toBe(`RECEIVED · owner unknown · as of ${iso} · source receivedAt · missing: named owner, durable claim receipt · owner unknown; claim unknown`);
  expect(slackWorkStatusLine(work, { inReplyTo: id, in_reply_to: 'different' })).toMatch(/^UNKNOWN;/);
});

it('scrubs JSON owner values and refuses tests-only verification', async () => {
  post();
  const fake = `ghp_${'FAKEONLY'.repeat(5)}`;
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: fake, leaseMs: 60_000, root }).status).toBe('acquired');
  expect(postBusReply(id, 'fake-tests-only', { verified: { tests: 'all passed' } }, { root, now: () => now }).outcome).toBe('posted');
  expect(await read()).toMatchObject({ state: 'RUNNING', owner: '[REDACTED]' });
  expect(await read([id])).not.toContain(fake);
});

it('does not create missing stores and refuses write-like flags', async () => {
  expect(await read()).toMatchObject({ state: 'RECEIVED', asOf: 'unknown' });
  const before = snapshot(directory);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const args of [[], [id, '--send'], [id, '--json', '--json'], ['\n']]) expect(await cmdFleetWorkStatus(args)).toBe(2);
  expect(snapshot(directory)).toEqual(before);
});
