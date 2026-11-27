import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string, now: number;
const id = 'fake-request';
function post(name: string, body: Record<string, unknown>, at = now) {
  expect(appendBusInbox({ id: name, from: 'fake-host', to: 'fake-lane', priority: 'P1',
    ttl: 10_000_000, body }, { root, now: () => at }).status).toBe('posted');
}
async function run(json: boolean) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetWorkTrace(['--id', id, '--root', root, ...(json ? ['--json'] : [])])).toBe(0);
  expect(log).toHaveBeenCalledOnce();
  const output = String(log.mock.calls[0]![0]);
  log.mockRestore();
  return output;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-result-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post(id, { kind: 'work', text: 'private-body-marker' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports the validated blocker with its evidence timestamp and existing claim details', async () => {
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-worker', leaseMs: 600_000, root });
  now += 1000;
  post('fake-reply', { kind: 'work', inReplyTo: id, blocked: { dependency: 'PR 123' } });
  const json = await run(true), text = await run(false);
  expect(JSON.parse(json)).toMatchObject({ state: 'BLOCKED', asOf: new Date(now).toISOString(),
    source: 'bus-reply:fake-reply', owner: 'fake-worker', inbox: 'found', claims: 'available',
    result: { kind: 'blocked', dependency: 'PR 123' } });
  expect(text).toContain('result={"kind":"blocked","dependency":"PR 123"}');
  expect(text).toContain('owner=fake-worker claimReceipt=bus-claim:');
  expect(text).not.toContain(claim.token!);
});

it('reports every verified proof field and uses null for absent fields', async () => {
  post('fake-reply', { kind: 'work', inReplyTo: id, verified: { pr: 123, head: 'abc123', tests: 'passed', artifact: 'report' } });
  expect(JSON.parse(await run(true)).result).toEqual({ kind: 'verified', pr: 123, head: 'abc123', tests: 'passed', artifact: 'report' });
  expect(await run(false)).toContain('result={"kind":"verified","pr":123,"head":"abc123","tests":"passed","artifact":"report"}');
  post('fake-reply-2', { kind: 'work', inReplyTo: id, verified: { tests: 'ok' } });
  expect(JSON.parse(await run(true)).result).toEqual({ kind: 'verified', pr: null, head: null, tests: 'ok', artifact: null });
});

it('does not expose malformed or future result evidence in a non-result state', async () => {
  post('fake-bad', { kind: 'work', inReplyTo: id, blocked: { dependency: 'unknown' }, verified: { pr: 123 } });
  post('fake-future', { kind: 'work', inReplyTo: id, verified: { tests: 'future-proof-marker' } }, now + 600_000);
  for (const output of [await run(true), await run(false)]) {
    expect(output).toContain('RECEIVED');
    expect(output).not.toContain('future-proof-marker');
    expect(output).not.toContain('result');
    expect(output).not.toContain('private-body-marker');
  }
});

it('scrubs secret-shaped proof and keeps output on one physical line', async () => {
  const secret = 'ghp_' + 'a'.repeat(36);
  post('fake-reply', { kind: 'work', inReplyTo: id, verified: { tests: `passed\n${secret}`, artifact: 'line one\nline two' } });
  for (const output of [await run(true), await run(false)]) {
    expect(output).not.toContain(secret);
    expect(output.split(/\r?\n/)).toHaveLength(1);
    expect(output).toContain('line one line two');
  }
});
