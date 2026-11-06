import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffPipe } from '../src/cli/fleet-handoff-pipe.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

const handoff: WorkerHandoff = {
  id: 'task-1', task: 'Inspect the fixture', files: [{ path: 'src/fixture.ts', lines: { from: 1, to: 3 } }],
  constraints: [{ rule: 'Keep the interface', reason: 'Other callers use it' }], check: 'Verify the fixture',
};
const content = JSON.stringify(handoff);
const args = ['--stdin', '--id', 'delivery-1', '--from', 'planner', '--to', 'worker'];
let dir: string, root: string, out: string[], err: string[];
const run = (input: Readable, extra: string[] = [], argv = args) =>
  cmdFleetHandoffPipe([...argv, ...extra], { stdin: input, root, tempRoot: dir });
const report = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;
const page = () => listBusInboxAfter(0, 50, { root });
const assertClean = () => expect(readdirSync(dir).filter(name => name.startsWith('ashlr-handoff-pipe-'))).toEqual([]);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-pipe-test-')));
  root = join(dir, 'bus'); out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { out.push(String(message)); });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => { err.push(String(message)); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('fleet handoff-pipe', () => {
  it('previews and applies the delegated envelope, then deduplicates a stable retry', async () => {
    expect(await run(Readable.from([content]), ['--json'])).toBe(0);
    expect(report()).toMatchObject({ valid: true, status: 'preview', destination: 'worker',
      envelope: { id: 'delivery-1', from: 'planner', to: 'worker', body: {
        kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff),
      } } });
    expect(existsSync(root)).toBe(false);
    assertClean();
    expect(await run(Readable.from([content]), ['--apply', '--json'])).toBe(0);
    expect(report()).toEqual({ v: 1, status: 'posted', id: 'delivery-1', cursor: 1 });
    expect(await run(Readable.from([content]), ['--apply', '--json'])).toBe(0);
    expect(report()).toEqual({ v: 1, status: 'duplicate', id: 'delivery-1', cursor: 1 });
    const result = page();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('inbox unavailable');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.envelope).toMatchObject({ id: 'delivery-1', from: 'planner', to: 'worker',
      body: { kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) } });
    assertClean();
  });

  it('preserves delegated validation, conflict exit codes, and sanitized output', async () => {
    expect(await run(Readable.from(['{ secret-marker']), ['--apply', '--json'])).toBe(1);
    expect(report()).toMatchObject({ valid: false });
    expect(out.join()).not.toContain('secret-marker');
    expect(existsSync(root)).toBe(false);
    expect(await run(Readable.from([content]), ['--apply', '--json'])).toBe(0);
    expect(await run(Readable.from([JSON.stringify({ ...handoff, task: 'Changed' })]), ['--apply', '--json'])).toBe(1);
    expect(report()).toEqual({ v: 1, status: 'conflict' });
    const result = page();
    expect(result.status === 'ok' && result.messages).toHaveLength(1);
    const unsafe = { ...handoff, task: 'fixture\u001b[31m\u202e' };
    expect(await run(Readable.from([JSON.stringify(unsafe)]), ['--json'])).toBe(0);
    expect(out.at(-1)).not.toContain('\u001b');
    expect(out.at(-1)).not.toContain('\u202e');
    assertClean();
  });

  it.each([
    Buffer.alloc(64 * 1024 + 1, 65), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82]),
    Buffer.from(JSON.stringify({ ...handoff, constraints: [{ rule: 'Keep it', reason: '' }] })),
  ])('rejects oversized, invalid UTF-8, or invalid handoffs without writing', async bytes => {
    expect(await run(Readable.from([bytes]), ['--apply', '--json'])).toBe(1);
    expect(report()).toMatchObject({ valid: false });
    expect(existsSync(root)).toBe(false);
    assertClean();
  });

  it('accepts the exact byte limit and multibyte UTF-8 split across chunks', async () => {
    const body = Buffer.from(JSON.stringify({ ...handoff, task: 'Inspect café' }));
    const bytes = Buffer.concat([body, Buffer.alloc(64 * 1024 - body.length, 32)]);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    expect(await run(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), ['--apply'])).toBe(0);
    const result = page();
    expect(result.status === 'ok' && result.messages).toHaveLength(1);
    assertClean();
  });

  it.each([
    [...args, '--stdin'], [...args, '--id', 'again'], [...args, '--unknown'], [...args, '--apply', '--apply'],
    ['--id', 'x', '--from', 'a', '--to', 'b'], ['--stdin', '--id', 'x', '--from', 'a'],
    [...args, '--input-timeout-ms', '0'], [...args, '--input-timeout-ms', '60001'],
    [...args, '--input-timeout-ms', '1.5'], [...args, '--input-timeout-ms', '1', '--input-timeout-ms', '2'],
  ])('rejects invalid arguments before reading', async (...argv) => {
    const input = new PassThrough();
    expect(await run(input, [], argv)).toBe(2);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.readableFlowing).toBeNull();
    expect(existsSync(root)).toBe(false);
    input.destroy();
  });

  it('rejects a TTY, a closed stream, and a stream error without writes', async () => {
    const tty = new PassThrough() as PassThrough & { isTTY: boolean };
    tty.isTTY = true;
    expect(await run(tty, ['--apply'])).toBe(1);
    expect(tty.listenerCount('data')).toBe(0);
    tty.destroy();
    const closed = new PassThrough();
    const closing = run(closed, ['--apply']);
    closed.destroy();
    expect(await closing).toBe(1);
    const broken = new PassThrough();
    const failing = run(broken, ['--apply']);
    broken.emit('error', new Error('private stream error'));
    expect(await failing).toBe(1);
    expect(err.join()).not.toContain('private stream error');
    expect(existsSync(root)).toBe(false);
    assertClean();
  });

  it('times out without EOF and removes listeners without destroying the stream', async () => {
    const input = new PassThrough();
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    const pending = run(input, ['--apply', '--input-timeout-ms', '20']);
    input.write(content);
    expect(await pending).toBe(1);
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('close')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(existsSync(root)).toBe(false);
    assertClean();
    input.destroy();
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('stops promptly on %s and cleans up', async (signal, code) => {
    const input = new PassThrough();
    const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
    const pending = run(input, ['--apply']);
    input.write(content);
    process.emit(signal);
    expect(await pending).toBe(code);
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(existsSync(root)).toBe(false);
    assertClean();
    input.destroy();
  });
});
