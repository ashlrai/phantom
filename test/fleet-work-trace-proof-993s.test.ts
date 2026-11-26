import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

let root: string, now: number;
const id = 'fake-request-993';
const post = (request = id) => expect(appendBusInbox({ id: request, from: 'fake-sender', to: 'fake-lane',
  priority: 'P1', ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
const reply = (request: string, replyId: string, body: unknown) => {
  now += 1000;
  expect(postBusReply(request, replyId, body, { root, now: () => now }).outcome).toBe('posted');
  return new Date(now).toISOString();
};
const trace = async (request = id, json = true) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkTrace(['--id', request, '--root', root, ...(json ? ['--json'] : [])])).toBe(0);
  const output = log.mock.calls.map(args => String(args[0])).join('\n');
  log.mockRestore();
  return output;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-proof-993-'));
  chmodSync(root, 0o700);
  now = Date.now() - 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('work trace proof from durable replies', () => {
  it('reports the exact blocker and its recorded source and time', async () => {
    const at = reply(id, 'fake-blocked', { blocked: { dependency: 'fake review\nsecond line' } });
    now += 10_000;
    const result = JSON.parse(await trace());
    expect(result).toMatchObject({ state: 'BLOCKED', proof: { dependency: 'fake review\nsecond line', source: 'bus-reply:fake-blocked', at } });
    const text = await trace(id, false);
    expect(text).toContain('dependency: fake review second line');
    expect(text).toContain(`at: ${at}`);
  });
  it('retains all verification fields in JSON and labelled text', async () => {
    const at = reply(id, 'fake-verified', { verified: { pr: 42, head: 'fakehead', tests: 'suite\npassed', artifact: 'fake.txt' } });
    now += 10_000;
    expect(JSON.parse(await trace())).toMatchObject({ state: 'VERIFIED', proof: { pr: 42, head: 'fakehead', tests: 'suite\npassed', artifact: 'fake.txt', source: 'bus-reply:fake-verified', at } });
    const text = await trace(id, false);
    for (const line of ['pr: 42', 'head: fakehead', 'tests: suite passed', 'artifact: fake.txt', 'source: bus-reply:fake-verified', `at: ${at}`]) expect(text).toContain(line);
  });
  it('does not invent proof for received or assigned work or borrow another request', async () => {
    post('fake-other');
    reply('fake-other', 'fake-other-reply', { verified: { tests: 'other proof' } });
    expect(JSON.parse(await trace())).toMatchObject({ state: 'RECEIVED' });
    expect(JSON.parse(await trace())).not.toHaveProperty('proof');
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    now += 600_001;
    const assigned = JSON.parse(await trace());
    expect(assigned.state).toBe('ASSIGNED');
    expect(assigned).not.toHaveProperty('proof');
  });
  it('does not expose future verification as accepted proof', async () => {
    reply(id, 'fake-future', { verified: { tests: 'future proof' } });
    now -= 600_000;
    const result = JSON.parse(await trace());
    expect(result.state).toBe('RECEIVED');
    expect(result).not.toHaveProperty('proof');
  });
});
