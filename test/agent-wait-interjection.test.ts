import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inboxFingerprint, runWaitInterjection } from '../examples/agents/wait-interjection.js';
import { parseInbox, type InboxEntry } from '../src/core/fleet/mason-inbox.js';

const filesystem = vi.hoisted(() => ({ open: vi.fn<(...args: unknown[]) => Promise<unknown>>(), appendFile: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(), ...filesystem,
}));

const first: InboxEntry = { at: '2026-01-02 00:13', source: 'terminal', priority: 'P0', text: 'first fake message' };
const healthy = (entries: InboxEntry[]) => ({ sourceState: 'healthy' as const, entries });
const argsFor = (entry: InboxEntry | undefined, ms = 500): string[] =>
  ['--after-fingerprint', inboxFingerprint(entry), '--timeout-ms', String(ms)];

function harness(snapshots: ReturnType<typeof healthy>[]) {
  let time = 0;
  let index = 0;
  const lines: string[] = [];
  const read = vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!);
  const wait = vi.fn(async (ms: number) => { time += ms; });
  return { read, wait, now: () => time, write: (line: string) => lines.push(line), lines };
}

describe('wait interjection workflow', () => {
  it('detects a different text in the same minute and returns the attributed entries', async () => {
    const next = { ...first, text: 'second fake message' };
    const io = harness([healthy([first]), healthy([next, first])]);
    expect(await runWaitInterjection(argsFor(first), io)).toBe(0);
    expect(io.read).toHaveBeenCalledTimes(2);
    expect(io.read).toHaveBeenCalledWith({ limit: 20 });
    expect(io.wait).toHaveBeenCalledWith(250, undefined);
    expect(JSON.parse(io.lines[0]!)).toEqual({ v: 1, sourceState: 'healthy', fingerprint: inboxFingerprint(next), entries: [next, first], status: 'changed' });
  });

  it('detects the same text from a different source', async () => {
    const next = { ...first, source: 'fake channel' };
    const io = harness([healthy([next])]);
    expect(await runWaitInterjection(argsFor(first), io)).toBe(0);
    expect(JSON.parse(io.lines[0]!).entries[0].source).toBe('fake channel');
    expect(io.wait).not.toHaveBeenCalled();
  });

  it('times out on an unchanged snapshot with finite injected waits and no writes', async () => {
    const frozen = Object.freeze({ ...first });
    const entries = Object.freeze([frozen]);
    const io = harness([healthy(entries as InboxEntry[])]);
    expect(await runWaitInterjection(argsFor(first, 501), io)).toBe(5);
    expect(io.wait.mock.calls.map(call => call[0])).toEqual([250, 250, 1]);
    expect(JSON.parse(io.lines[0]!).status).toBe('timeout');
    expect(entries).toEqual([first]);
    expect(io.lines).toHaveLength(1);
  });

  it('uses the canonical reader in read-only mode and never writes an acknowledgement', async () => {
    const content = Buffer.from('## 2026-01-02 00:13 ET (Mason, fake channel) PRIORITY P0\nfake message\n');
    const close = vi.fn(async () => {});
    filesystem.open.mockResolvedValueOnce({
      stat: async () => ({ size: content.length }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: content.copy(buffer, offset, position, position + length),
      }),
      close,
    });
    const lines: string[] = [];
    expect(await runWaitInterjection(['--once'], { write: line => lines.push(line) })).toBe(0);
    expect(filesystem.open).toHaveBeenCalledOnce();
    expect(filesystem.open.mock.calls[0]?.[1]).toBe('r');
    expect(filesystem.appendFile).not.toHaveBeenCalled();
    expect(filesystem.mkdir).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(lines[0]!).entries[0]).toMatchObject({ source: 'fake channel', text: 'fake message' });
  });

  it('uses unknown for a legacy source and snapshots empty healthy inboxes', async () => {
    const legacy = parseInbox('## old heading\nfake legacy message');
    const io = harness([healthy(legacy)]);
    expect(await runWaitInterjection(['--once'], io)).toBe(0);
    expect(JSON.parse(io.lines[0]!).entries[0].source).toBe('unknown');
    const empty = harness([healthy([])]);
    expect(await runWaitInterjection(['--once'], empty)).toBe(0);
    expect(JSON.parse(empty.lines[0]!).fingerprint).toBe(createHash('sha256').update('null').digest('hex'));
  });

  it('encodes all fields canonically without delimiter collisions', () => {
    const entry = { at: 'a', source: 'b', priority: 'c', text: 'd' };
    expect(inboxFingerprint(entry)).toBe(createHash('sha256').update(JSON.stringify(['a', 'b', 'c', 'd'])).digest('hex'));
    expect(inboxFingerprint(entry)).not.toBe(inboxFingerprint({ ...entry, at: 'a,b', source: '' }));
    expect(inboxFingerprint(entry)).not.toBe(inboxFingerprint({ ...entry, priority: 'd' }));
    expect(inboxFingerprint({ ...entry, source: '' })).toBe(inboxFingerprint({ ...entry, source: 'unknown' }));
  });

  it('scrubs untrusted display fields while fingerprinting the original entry', async () => {
    const entry = { ...first, text: 'password=fake-password-value', source: 'x'.repeat(300) };
    const io = harness([healthy([entry])]);
    expect(await runWaitInterjection(['--once'], io)).toBe(0);
    const result = JSON.parse(io.lines[0]!);
    expect(result.fingerprint).toBe(inboxFingerprint(entry));
    expect(result.entries[0].text).not.toContain('fake-password-value');
    expect(result.entries[0].source).toHaveLength(256);
  });

  it.each([['missing', 3], ['degraded', 4]] as const)('reports %s without claiming a change', async (sourceState, code) => {
    const lines: string[] = [];
    expect(await runWaitInterjection(argsFor(first), { read: async () => ({ sourceState, entries: [] }), write: line => lines.push(line) })).toBe(code);
    expect(JSON.parse(lines[0]!)).toEqual({ v: 1, status: 'unavailable', sourceState, entries: [] });
  });

  it('rejects invalid arguments before reading and masks unexpected errors', async () => {
    const io = harness([healthy([first])]);
    for (const args of [[], ['--once', '--once'], argsFor(first, 0), argsFor(first, 300001), ['--after-fingerprint', 'bad', '--timeout-ms', '1']]) {
      expect(await runWaitInterjection(args, io)).toBe(2);
    }
    expect(io.read).not.toHaveBeenCalled();
    const lines: string[] = [];
    expect(await runWaitInterjection(['--once'], { read: async () => { throw new Error('fake private detail'); }, write: line => lines.push(line) })).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ error: 'Unable to observe inbox.' });
  });

  it('stops on abort during a wait', async () => {
    const controller = new AbortController();
    const io = harness([healthy([first])]);
    expect(await runWaitInterjection(argsFor(first), { ...io, signal: controller.signal, wait: async () => { controller.abort(); throw new Error('abort'); } })).toBe(130);
    expect(JSON.parse(io.lines[0]!)).toEqual({ error: 'Interrupted.' });
    expect(io.read).toHaveBeenCalledTimes(1);
  });
});
