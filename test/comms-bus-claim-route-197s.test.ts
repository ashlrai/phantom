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
  // legacy-1 is the one claimable receipt on worker-a and worker-a's lease holds it.
  expect(last()).toEqual({ status: 'empty', candidates: 1, held: 1 });

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
  // legacy-1 is completed but still a live candidate; nothing answers conflict.
  expect(last()).toEqual({ status: 'empty', candidates: 1, held: 0 });
});

it('filters next by contains, since and priority', async () => {
  const { root, last } = setup();
  const options = { root };
  const task = (id: string, priority: string, text: string): string => postTask(root, {
    id, from: 'fake-sender', to: 'worker-a', priority, ttl: 600_000,
    body: { kind: 'work', text },
  });
  expect(await cmdCommsBus(['post', '--file', task('flt-old', 'P0', 'deploy alpha')], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('flt-chore', 'P3', 'unrelated chore')], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('flt-alpha', 'P1', 'ship ALPHA build')], options)).toBe(0);

  // --priority keeps only the exact band.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--priority', 'P1'], options)).toBe(0);
  expect(last().receipt.envelope.id).toBe('flt-alpha');

  // --contains matches the scrubbed one-line summary case-insensitively; with
  // --priority P0 only the older alpha receipt qualifies.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--contains', 'alpha', '--priority', 'P0'], options)).toBe(0);
  expect(last().receipt.envelope.id).toBe('flt-old');

  // --since past every receipt's arrival empties the filtered scan honestly —
  // unfiltered, the two live leases would read as held candidates instead.
  const future = String(Date.now() + 3_600_000);
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--since', future], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty', candidates: 0, held: 0 });

  // --before is the exclusive receivedAt ceiling: a cutoff before every
  // receipt's arrival empties the same filtered scan.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--before', '1'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty', candidates: 0, held: 0 });

  // Malformed filters are invalid, never a widened claim.
  for (const args of [
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--priority', 'P9'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--since', 'bogus'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--before', 'bogus'],
    ['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--contains', '   '],
  ]) {
    expect(await cmdCommsBus(args, options), args.join(' ')).toBe(2);
    expect(last(), args.join(' ')).toEqual({ status: 'invalid' });
  }
});

it('filters next by the group-address topic', async () => {
  const { root, last } = setup();
  const options = { root };
  const task = (id: string, to: string, priority: string): string => postTask(root, {
    id, from: 'fake-sender', to, priority, ttl: 600_000,
    body: { kind: 'work', text: id },
  });
  expect(await cmdCommsBus(['post', '--file', task('tp-eng-deploy', 'group:eng:deploy', 'P0')], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('tp-eng-general', 'group:eng:general', 'P1')], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('tp-ops-deploy', 'group:ops:deploy', 'P2')], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('tp-direct', 'group:eng:deploy', 'P3')], options)).toBe(0);

  // --topic keeps only well-formed group:<room>:<topic> addresses carrying
  // that exact topic — here the literal claim address names one room's
  // deploy topic, so its two deploy receipts claim in priority order while
  // the general post stays out.
  expect(await cmdCommsBus(['next', '--to', 'group:eng:deploy', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'deploy'], options)).toBe(0);
  expect(last()).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'tp-eng-deploy' } } });
  expect(await cmdCommsBus(['next', '--to', 'group:eng:deploy', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'deploy'], options)).toBe(0);
  expect(last()).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'tp-direct' } } });
  // Both deploy receipts are held by worker-a's live leases; the general
  // post never enters the filtered scan.
  expect(await cmdCommsBus(['next', '--to', 'group:eng:deploy', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'deploy'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty', candidates: 2, held: 2 });
  // The room's other topic claims its own receipt under its own address.
  expect(await cmdCommsBus(['next', '--to', 'group:eng:general', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'general'], options)).toBe(0);
  expect(last()).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'tp-eng-general' } } });
  // A well-formed topic nothing addresses is an honest empty match; a
  // malformed one is invalid, never a widened claim.
  expect(await cmdCommsBus(['next', '--to', 'group:eng:deploy', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'absent'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty', candidates: 0, held: 0 });
  expect(await cmdCommsBus(['next', '--to', 'group:eng:deploy', '--owner', 'worker-a', '--lease-ms', '60000', '--topic', 'Bad Name'], options)).toBe(2);
  expect(last()).toEqual({ status: 'invalid' });
});

it('claims the named envelope under --id and keeps the addressed-to rules', async () => {
  const { root, last } = setup();
  const options = { root };
  const task = (id: string, to: string, priority: string, body: unknown): string => postTask(root, {
    id, from: 'fake-sender', to, priority, ttl: 600_000, body,
  });
  expect(await cmdCommsBus(['post', '--file', task('id-target', 'worker-a', 'P3', { kind: 'work' })], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('id-decoy', 'worker-a', 'P0', { kind: 'work' })], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('id-foreign', 'worker-b', 'P0', { kind: 'work' })], options)).toBe(0);
  expect(await cmdCommsBus(['post', '--file', task('id-note', 'worker-a', 'P0', { kind: 'note' })], options)).toBe(0);

  // --id claims the named P3 receipt even though a P0 claimable receipt exists.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--id', 'id-target'], options)).toBe(0);
  expect(last()).toMatchObject({ status: 'acquired', receipt: { envelope: { id: 'id-target' } } });
  // The held named receipt reports held work, not a dry well.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--id', 'id-target'], options)).toBe(0);
  expect(last()).toEqual({ status: 'empty', candidates: 1, held: 1 });
  // Foreign, non-work and absent ids are honest empty matches.
  for (const id of ['id-foreign', 'id-note', 'id-missing']) {
    expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--id', id], options), id).toBe(0);
    expect(last(), id).toEqual({ status: 'empty', candidates: 0, held: 0 });
  }
  // A malformed id is invalid, never a widened claim.
  expect(await cmdCommsBus(['next', '--to', 'worker-a', '--owner', 'worker-a', '--lease-ms', '60000', '--id', 'has space'], options)).toBe(2);
  expect(last()).toEqual({ status: 'invalid' });
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
