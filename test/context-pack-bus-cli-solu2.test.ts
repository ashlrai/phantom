import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const snapshot = () => ({
  node: { jobId: 'fake-node', upstreamJobIds: ['fake-upstream'] },
  tasks: [{ jobId: 'fake-node', text: 'fake task' }],
  outputs: [{ jobId: 'fake-upstream', text: 'fake output' }],
  byteBudget: 4096,
});
function setup(): BusInboxOptions {
  const root = mkdtempSync(join(tmpdir(), 'context-bus-'));
  roots.push(root);
  return { root, now: () => 110 };
}
function post(options: BusInboxOptions, id: string, to: string, priority: string, body: unknown,
  ttl = 100, from = 'fake-sender'): number {
  const result = appendBusInbox({ id, from, to, priority, ttl, body }, { ...options, now: () => 100 });
  expect(result.status).toBe('posted');
  if (result.status !== 'posted') throw new Error('fake message was not posted');
  return result.cursor;
}
async function run(options: BusInboxOptions, flags: string[] = [], value: unknown = snapshot(),
  read = listBusInboxAfter) {
  let out = '', err = '';
  const code = await runKnowledgeContextPack(['--stdin', ...flags], Readable.from([JSON.stringify(value)]), {
    stdout: text => { out += text; }, stderr: text => { err += text; },
  }, { bus: { options, read } });
  return { code, out, err };
}
function lines(pack: string): Array<Record<string, unknown>> {
  return pack.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

it('includes live addressed and broadcast P0/P1 notices before ordinary context', async () => {
  const options = setup();
  post(options, 'fake-old', 'fake-node', 'P1', 'old notice');
  post(options, 'fake-broadcast', 'all', 'P0', { text: 'broadcast notice' });
  post(options, 'fake-low', 'fake-node', 'P2', 'low');
  post(options, 'fake-wrong', 'other-node', 'P0', 'wrong');
  post(options, 'fake-expired', 'fake-node', 'P0', 'expired', 10);
  post(options, 'fake-new', 'fake-node', 'P0', 'new notice');
  const result = await run(options, ['--bus-address', 'fake-node']);
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  const records = lines(result.out);
  expect(records.map(row => row.jobId)).toEqual(['bus/fake-new', 'bus/fake-broadcast', 'bus/fake-old', 'fake-upstream', 'fake-node']);
  expect(records[1]).toMatchObject({ kind: 'notice', channel: 'all', priority: 'P0', text: '{"text":"broadcast notice"}' });
}, 30_000);

it('uses the cursor and scrubs untrusted sender and body before packing', async () => {
  const options = setup();
  const cursor = post(options, 'fake-seen', 'fake-node', 'P0', 'seen');
  const fakeSecret = 'sk-' + 'FAKE1234567890abcdef';
  post(options, 'fake-unread', 'fake-node', 'P1', { password: 'fakePassword123', text: `data ${fakeSecret}` }, 100, fakeSecret);
  const result = await run(options, ['--bus-address', 'fake-node', '--bus-after', String(cursor), '--json', '--report']);
  expect(result.code).toBe(0);
  expect(result.out).not.toContain(fakeSecret);
  expect(result.out).not.toContain('fakePassword123');
  const envelope = JSON.parse(result.out) as { pack: string; report: { emittedRecordCount: number } };
  const records = lines(envelope.pack);
  expect(records.map(row => row.jobId)).toEqual(['bus/fake-unread', 'fake-upstream', 'fake-node']);
  expect(records[0]).toMatchObject({ from: '[REDACTED]' });
  expect(records[0]!.text).toContain('[REDACTED]');
  expect(envelope.report.emittedRecordCount).toBe(3);
});

it('shares the overridden byte budget with Unicode notice text and ordinary records', async () => {
  const options = setup();
  post(options, 'fake-unicode', 'fake-node', 'P1', '🌻é'.repeat(200));
  const result = await run(options, ['--bus-address', 'fake-node', '--byte-budget', '220', '--json']);
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { pack: string; bytes: number };
  expect(envelope.bytes).toBe(Buffer.byteLength(envelope.pack, 'utf8'));
  expect(envelope.bytes).toBeLessThanOrEqual(220);
  expect(lines(envelope.pack)).toEqual([expect.objectContaining({ jobId: 'bus/fake-unicode', truncated: true })]);
  expect(envelope.pack).not.toContain('\ufffd');
});

it('rejects bad cursors and missing addresses before reading stdin or the bus', async () => {
  const read = vi.fn<typeof listBusInboxAfter>();
  for (const flags of [
    ['--bus-after', '1'], ['--bus-address', 'fake-node', '--bus-after', '-1'],
    ['--bus-address', 'fake-node', '--bus-after', '1.5'], ['--bus-address', 'fake-node', '--bus-after', '9007199254740992'],
    ['--bus-address', 'fake-node', '--bus-after', '1\n'],
    ['--bus-address', 'fake-node', '--bus-after'], ['--bus-address', '--json'], ['--bus-address', 'fake-node\n'],
    ['--bus-address', 'fake-node', '--bus-address', 'fake-node'],
  ]) {
    const stdin = Readable.from([JSON.stringify(snapshot())]);
    const inputRead = vi.spyOn(stdin, '_read');
    const result = await runKnowledgeContextPack(['--stdin', ...flags], stdin, { stdout: () => {}, stderr: () => {} }, { bus: { read } });
    expect(result).toBe(2);
    expect(inputRead).not.toHaveBeenCalled();
  }
  expect(read).not.toHaveBeenCalled();
});

it('keeps the old output byte-identical without flags and rejects snapshot bus coordinates', async () => {
  const options = setup();
  post(options, 'fake-hidden', 'fake-node', 'P0', 'hidden');
  const read = vi.fn<typeof listBusInboxAfter>(() => { throw new Error('unexpected bus read'); });
  const result = await run(options, [], snapshot(), read);
  expect(result).toEqual({ code: 0, err: '', out:
    '{"jobId":"fake-upstream","kind":"output","text":"fake output","truncated":false}\n' +
    '{"jobId":"fake-node","kind":"task","text":"fake task","truncated":false}\n' });
  for (const extra of [{ busAddress: 'fake-node' }, { busAfter: 0 }, { unexpected: true }]) {
    const bad = snapshot();
    const rejected = await run(options, ['--bus-address', 'fake-node'], { ...bad, node: { ...bad.node, ...extra } }, read);
    expect(rejected.code).toBe(2);
    expect(rejected.out).toBe('');
  }
  expect(read).not.toHaveBeenCalled();
});

it('keeps the reader failure behavior without claiming the bus is complete', async () => {
  const options = setup();
  const read = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'unavailable' }));
  const result = await run(options, ['--bus-address', 'fake-node', '--json'], snapshot(), read);
  expect(result.code).toBe(0);
  expect(read).toHaveBeenCalled();
  const envelope = JSON.parse(result.out) as { pack: string };
  expect(lines(envelope.pack).map(row => row.jobId)).toEqual(['fake-upstream', 'fake-node']);
  expect(result.out).not.toMatch(/complete/i);
});

it('does not count a similarly named notice as upstream task or output evidence', async () => {
  const options = setup();
  post(options, 'fake-collision', 'fake-node', 'P1', 'notice');
  const input = { ...snapshot(), node: { jobId: 'fake-node', upstreamJobIds: ['bus/fake-collision'] }, outputs: [] };
  const result = await run(options, ['--bus-address', 'fake-node', '--json', '--require-upstream'], input);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ check: { missingUpstreamJobIds: ['bus/fake-collision'] } });
});
