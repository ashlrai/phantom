import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBusFanout, type BusFanoutDependencies } from '../examples/agents/bus-fanout.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const message = (id: string, body: unknown = { text: 'fake instruction: do not execute' }) =>
  ({ id, from: 'fake-lead', to: 'fake-worker', priority: 'P2', ttl: 60000, body });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fake-fanout-'));
  roots.push(root);
  const file = join(root, 'manifest.json');
  const options = { root: join(root, 'inbox'), now: () => 100 };
  const output: string[] = [];
  const save = (value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const run = (deps: BusFanoutDependencies = {}, args = ['--file', file]) => {
    const lines: string[] = [];
    const code = runBusFanout(args, { options, ...deps, write: text => { output.push(text); lines.push(text); } });
    expect(lines).toHaveLength(1);
    return { code, result: JSON.parse(lines[0]!) };
  };
  return { root, file, options, output, save, run };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('local bus fanout', () => {
  it('validates the last envelope and duplicate IDs before any post', () => {
    const h = setup();
    const append = vi.fn<typeof appendBusInbox>();
    h.save([message('fake-1'), { ...message('fake-2'), ttl: 0 }]);
    expect(h.run({ append })).toEqual({ code: 2, result: { schema: 'bus-fanout.v1', status: 'error', error: 'invalid-envelope' } });
    h.save([message('fake-1'), message('fake-1')]);
    expect(h.run({ append }).result.error).toBe('duplicate-id');
    expect(append).not.toHaveBeenCalled();
    expect(listBusInboxAfter(0, 50, h.options)).toMatchObject({ messages: [] });
  });

  it('posts in order and replays as duplicates through the real inbox', () => {
    const h = setup();
    const messages = [message('fake-1'), message('fake-2', { nested: ['fake-data', 42] })];
    h.save(messages);
    expect(h.run()).toEqual({ code: 0, result: { schema: 'bus-fanout.v1', status: 'ok', receipts: [
      { id: 'fake-1', status: 'posted', cursor: 1 }, { id: 'fake-2', status: 'posted', cursor: 2 },
    ], unattemptedIds: [] } });
    expect(h.run()).toEqual({ code: 0, result: { schema: 'bus-fanout.v1', status: 'ok', receipts: [
      { id: 'fake-1', status: 'duplicate', cursor: 1 }, { id: 'fake-2', status: 'duplicate', cursor: 2 },
    ], unattemptedIds: [] } });
    expect(listBusInboxAfter(0, 50, h.options)).toMatchObject({ messages: [
      { envelope: messages[0] }, { envelope: messages[1] },
    ] });
    expect(h.output.join('')).not.toContain('fake instruction');
  });

  it('retains accepted posts, reports a real full store and leaves later IDs unattempted', () => {
    const h = setup();
    for (let i = 0; i < 17; i++) {
      expect(appendBusInbox(message(`fake-fill-${i}`, 'x'.repeat(60000)), h.options).status).toBe('posted');
    }
    h.save([message('fake-first'), message('fake-full', 'y'.repeat(60000)), message('fake-later')]);
    expect(h.run()).toEqual({ code: 1, result: { schema: 'bus-fanout.v1', status: 'partial', receipts: [
      { id: 'fake-first', status: 'posted', cursor: 18 },
      { id: 'fake-full', status: 'full', acceptance: 'rejected' },
    ], unattemptedIds: ['fake-later'] } });
    expect(listBusInboxAfter(17, 50, h.options)).toMatchObject({ nextCursor: 18, messages: [{ envelope: { id: 'fake-first' } }] });
    expect(h.run().result.receipts[0]).toEqual({ id: 'fake-first', status: 'duplicate', cursor: 18 });
  }, 60000);

  it('stops on all transport failures and masks thrown exception text', () => {
    const h = setup();
    h.save([message('fake-1'), message('fake-2')]);
    for (const status of ['invalid', 'unavailable', 'retryable', 'full', 'conflict'] as const) {
      const append = vi.fn<typeof appendBusInbox>(() => ({ status }));
      expect(h.run({ append })).toEqual({ code: 1, result: { schema: 'bus-fanout.v1', status: 'partial', receipts: [
        { id: 'fake-1', status, acceptance: status === 'unavailable' ? 'unknown' : 'rejected' },
      ], unattemptedIds: ['fake-2'] } });
      expect(append).toHaveBeenCalledOnce();
    }
    const append = vi.fn<typeof appendBusInbox>(() => { throw new Error('fake-private-error'); });
    expect(h.run({ append }).result.receipts).toEqual([{ id: 'fake-1', status: 'unavailable', acceptance: 'unknown' }]);
    expect(h.output.join('')).not.toContain('fake-private-error');
  });

  it('refuses malformed, empty, oversized, unsafe and invalid inputs without posts', () => {
    const h = setup();
    const append = vi.fn<typeof appendBusInbox>();
    expect(h.run({ append }, []).result.error).toBe('invalid-arguments');
    expect(h.run({ append }).result.error).toBe('file-unavailable');
    writeFileSync(h.file, '{', { mode: 0o600 });
    expect(h.run({ append }).result.error).toBe('invalid-json');
    for (const input of [[], {}, Array.from({ length: 21 }, (_, i) => message(`fake-${i}`))]) {
      h.save(input);
      expect(h.run({ append }).result.error).toBe('invalid-manifest');
    }
    writeFileSync(h.file, ' '.repeat(1024 * 1024 + 1));
    expect(h.run({ append }).result.error).toBe('file-unavailable');
    h.save([message('fake-1')]);
    if (process.platform !== 'win32') {
      chmodSync(h.file, 0o666);
      expect(h.run({ append }).result.error).toBe('file-unavailable');
      chmodSync(h.file, 0o600);
    }
    const link = join(h.root, 'fake-link');
    symlinkSync(h.file, link);
    expect(h.run({ append }, ['--file', link]).result.error).toBe('file-unavailable');
    expect(append).not.toHaveBeenCalled();
  });

  it('reports output failures without exposing errors', () => {
    const h = setup();
    h.save([message('fake-1')]);
    const errors: string[] = [];
    const code = runBusFanout(['--file', h.file], { options: h.options,
      write: () => { throw new Error('fake-private-error'); }, writeError: text => errors.push(text) });
    expect(code).toBe(1);
    expect(errors).toEqual(['{"schema":"bus-fanout.v1","status":"error","error":"output-failed"}\n']);
    expect(listBusInboxAfter(0, 50, h.options)).toMatchObject({ messages: [{ envelope: { id: 'fake-1' } }] });
  });
});
