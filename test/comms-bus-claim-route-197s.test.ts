import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-claim-route-')); roots.push(root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const last = (): any => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return { root, log, last };
};
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function postTask(root: string, envelope: Record<string, unknown>): string {
  const file = join(root, `fake-${String(envelope.id)}.json`);
  writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 });
  return file;
}

it('claims legacy work and a protocol task through cmdCommsBus, fences the lease and completes once', async () => {
  const { root, last } = setup();
  const options = { root };
  // Legacy {kind:'work'} envelope addressed to a plain routing label.
  const legacy = postTask(root, { id: 'legacy-1', from: 'fake-sender', to: 'worker-a', priority: 'P2', ttl: 600_000, body: { kind: 'work', text: 'fake work' } });
  expect(await cmdCommsBus(['post', '--file', legacy], options)).toBe(0);
  expect(last()).toEqual({ status: 'posted', id: 'legacy-1', cursor: 1 });

  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000'], options)).toBe(0);
  const acquired = last();
  expect(acquired.status).toBe('acquired');
  expect(acquired.receipt.envelope.id).toBe('legacy-1');
  expect(acquired.token).toMatch(/^[a-f0-9]{64}$/);

  // A live lease answers conflict to every other owner.
  expect(await cmdCommsBus(['claim', 'acquire', '--id', 'legacy-1', '--owner', 'worker-b', '--lease-ms', '60000'], options)).toBe(1);
  expect(last().status).toBe('conflict');
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-b', '--lease-ms', '60000'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty' });

  // Only the fencing token completes the claim.
  expect(await cmdCommsBus(['claim', 'complete', '--id', 'legacy-1', '--token', 'f'.repeat(64)], options)).toBe(1);
  expect(last().status).toBe('mismatched-token');
  expect(await cmdCommsBus(['claim', 'complete', '--id', 'legacy-1', '--token', acquired.token], options)).toBe(0);
  expect(last().status).toBe('completed');

  // Completed work cannot be reclaimed by acquire or next.
  expect(await cmdCommsBus(['claim', 'acquire', '--id', 'legacy-1', '--owner', 'worker-c', '--lease-ms', '60000'], options)).toBe(0);
  expect(last().status).toBe('completed');
  expect(last().token).toBeUndefined();
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-c', '--lease-ms', '60000'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty' });
});

it('claims a protocol task envelope addressed to a topic', async () => {
  const { root, last } = setup();
  const options = { root };
  const task = postTask(root, {
    id: 'protocol-1', from: 'fake-sender', to: 'fleet.tasks', priority: 'P1', ttl: 600_000,
    body: { protocol: { version: 1, kind: 'task', topic: 'fleet.tasks', payload_ref: 'fake-ref' }, note: 'fake task' },
  });
  expect(await cmdCommsBus(['post', '--file', task], options)).toBe(0);
  expect(await cmdCommsBus(['next', '--to', 'fleet.tasks', '--owner', 'worker-a', '--lease-ms', '60000'], options)).toBe(0);
  const acquired = last();
  expect(acquired.status).toBe('acquired');
  expect(acquired.receipt.envelope.id).toBe('protocol-1');
  expect(acquired.receipt.envelope.body.protocol.kind).toBe('task');
  expect(await cmdCommsBus(['claim', 'release', '--id', 'protocol-1', '--token', acquired.token], options)).toBe(0);
  expect(last().status).toBe('released');
  // A released lease is acquirable again by another owner.
  expect(await cmdCommsBus(['claim', 'acquire', '--id', 'protocol-1', '--owner', 'worker-b', '--lease-ms', '60000'], options)).toBe(0);
  expect(last().status).toBe('acquired');
});

it('returns the established invalid code for bad claim arguments', async () => {
  const { root, last } = setup();
  const options = { root };
  const invalid: string[][] = [
    ['next'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', 'abc'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '0'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '3600001'],
    ['next', '--to', 'worker-a', '--to', 'worker-b', '--owner', 'worker-a', '--lease-ms', '1000'],
    ['claim'],
    ['claim', 'bogus', '--id', 'x'],
    ['claim', 'acquire', '--id', 'x', '--owner', 'o'],
    ['claim', 'renew', '--id', 'x'],
    ['claim', 'complete', '--id', 'x', '--token', 'not-a-token'],
  ];
  for (const args of invalid) {
    expect(await cmdCommsBus(args, options), args.join(' ')).toBe(2);
    expect(last(), args.join(' ')).toEqual({ status: 'invalid' });
  }
  // Well-formed but unknown ids report missing, not invalid.
  expect(await cmdCommsBus(['claim', 'acquire', '--id', 'no-such', '--owner', 'o', '--lease-ms', '1000'], options)).toBe(1);
  expect(last().status).toBe('missing');
});

it('help documents next and claim without revealing tokens', async () => {
  const { root, log } = setup();
  const options = { root };
  expect(await cmdCommsBus(['next', '--help'], options)).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('phm comms bus next --to');
  expect(help).toContain('phm comms bus claim acquire');
  expect(help).toContain('phm comms bus claim renew|release|complete');
  expect(help).toContain('--token <claim-token>');
  expect(help).not.toMatch(/[a-f0-9]{64}/);
  expect(help).toContain('never log it');
});
