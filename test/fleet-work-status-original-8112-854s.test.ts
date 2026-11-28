import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkStatus } from '../src/cli/fleet-work-status.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

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
  expect(resolveFleetSubcommand('work-status')).toMatchObject({ exportName: 'cmdFleetWorkStatus' });
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
  expect(await read()).toMatchObject({ state: 'ASSIGNED', missing: expect.arrayContaining(['fresh running evidence']) });
  expect(postBusReply(id, 'fake-block', { blocked: { dependency: 'review PR 7' } }, { root, now: () => now }).outcome).toBe('posted');
  expect(await read()).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:fake-block' });
  expect(postBusReply(id, 'fake-verified', { verified: { pr: 7, head: 'a'.repeat(40) } }, { root, now: () => now }).outcome).toBe('posted');
  expect(await read()).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-verified' });
  expect(await read([id])).toBe(`VERIFIED · fake-worker · as of ${iso} · source bus-reply:fake-verified · missing: journal missing`);
});

it('scrubs untrusted owner in both formats and never emits fencing tokens', async () => {
  post();
  const fake = `ghp_${'FAKEONLY'.repeat(5)}`;
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: fake, leaseMs: 60_000, root });
  expect(claim.status).toBe('acquired');
  const json = JSON.stringify(await read());
  const line = await read([id]);
  expect(json).not.toContain(fake);
  expect(line).not.toContain(fake);
  expect(claim.token).toBeTruthy();
  expect(json).not.toContain(claim.token);
  expect(line).not.toContain(claim.token);
});

it('does not associate a journal alias with an unrelated claim', async () => {
  post();
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 60_000, root }).status).toBe('acquired');
  mkdirSync(join(runs, 'slack-bridge'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runs, 'slack-bridge/journal.jsonl'), JSON.stringify({ at: iso, eventId: 'fake-event',
    envelopeId: id, decision: 'ingested', bus: 'failed' }) + '\n', { mode: 0o600 });
  expect(await read(['fake-event', '--json'])).toMatchObject({ state: 'RECEIVED', asOf: iso });
  expect(await read(['fake-event', '--json'])).not.toHaveProperty('owner');
});

it('reports malformed stores without writing them', async () => {
  mkdirSync(join(root, 'bus-inbox'), { recursive: true });
  writeFileSync(join(root, 'bus-inbox/messages.json'), '{bad');
  mkdirSync(join(runs, 'slack-bridge'), { recursive: true });
  writeFileSync(join(runs, 'slack-bridge/journal.jsonl'), '{bad\n');
  expect(await read()).toMatchObject({ sources: { inbox: 'unavailable', journal: 'degraded' } });
});

it('does not create missing stores and refuses write-like flags', async () => {
  expect(await read()).toMatchObject({ state: 'RECEIVED', asOf: 'unknown' });
  const before = snapshot(directory);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkStatus(['--help'])).toBe(0);
  expect(log).toHaveBeenCalled();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const args of [[], [id, '--send'], [id, '--json', '--json'], ['\n']]) expect(await cmdFleetWorkStatus(args)).toBe(2);
  expect(snapshot(directory)).toEqual(before);
});
