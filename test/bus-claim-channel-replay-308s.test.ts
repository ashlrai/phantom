import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusClaimedRun } from '../src/cli/fleet-bus-claimed-run.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

let base: string, root: string, snapshot: string, prompt: string, counter: string;
const envelope = (from: string): BusEnvelope => ({ id: 'canonical-308s', from, to: 'worker',
  priority: 'P1', ttl: 120_000, body: { kind: 'work', text: 'fake payload' } });
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
const count = () => { try { return readFileSync(counter, 'utf8').trim().split('\n').length; } catch { return 0; } };
const worker = () => [process.execPath, '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(counter)},'spawn\\n');process.stdin.resume();process.stdin.on('end',()=>console.log('ok'))`];
const file = (name: string, value: BusEnvelope) => {
  const path = join(base, name); writeFileSync(path, JSON.stringify(value)); return path;
};
const run = (requestFile: string, replyId: string, argv: string[]) => cmdFleetBusClaimedRun([
  '--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile, '--reply-id', replyId,
  '--owner', 'worker', '--lease-ms', '60000', '--root', root, ...argv,
], { stdout: sink(), stderr: sink() });
const messages = () => {
  const result = listBusInboxAfter(0, 50, { root });
  expect(result.status).toBe('ok');
  return result.status === 'ok' ? result.messages.map(m => m.envelope) : [];
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'claim-channel-308s-'));
  root = join(base, 'bus'); snapshot = join(base, 'snapshot.json');
  prompt = join(base, 'prompt.txt'); counter = join(base, 'counter');
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'FAKE', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'fake prompt');
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

it('fences a completed canonical request across differently attributed handoff files', async () => {
  const slack = envelope('slack'); const imessage = envelope('imessage');
  expect(appendBusInbox(slack, { root }).status).toBe('posted');
  // Inbox identity includes the entire envelope: a changed attribution cannot be reposted under this ID.
  expect(appendBusInbox(imessage, { root }).status).toBe('conflict');
  const first = file('slack.json', slack), replay = file('imessage.json', imessage);
  expect(await run(first, 'reply-slack', ['--', ...worker()])).toBe(0);
  expect(await run(replay, 'reply-imessage', ['--', ...worker()])).toBe(1);
  expect(count()).toBe(1);
  expect(inspectBusWorkClaims(root)).toMatchObject({ source: 'available', claims: [
    { id: slack.id, owner: 'worker', completedAt: expect.any(Number) },
  ] });
  const inbox = messages();
  expect(inbox.map(m => m.id)).toEqual([slack.id, 'reply-slack']);
  expect(inbox[1]?.body).toMatchObject({ inReplyTo: slack.id, kind: 'worker-exit', succeeded: true });
});

it('refuses a differently attributed contender while the canonical lease is held and requires argv', async () => {
  const slack = envelope('slack'); const imessage = envelope('imessage');
  expect(appendBusInbox(slack, { root }).status).toBe('posted');
  const request = file('imessage.json', imessage);
  expect(await run(request, 'reply-no-argv', [])).toBe(2);
  expect(inspectBusWorkClaims(root).source).toBe('missing');
  expect(mutateBusWorkClaim({ action: 'acquire', id: slack.id, owner: 'slack-worker', leaseMs: 60_000, root }).status).toBe('acquired');
  expect(await run(request, 'reply-contender', ['--', ...worker()])).toBe(1);
  expect(count()).toBe(0);
  expect(inspectBusWorkClaims(root)).toMatchObject({ source: 'available', claims: [
    { id: slack.id, owner: 'slack-worker', completedAt: null },
  ] });
  expect(messages().map(m => m.id)).toEqual([slack.id]);
});
