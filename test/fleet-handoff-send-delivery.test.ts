import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { estimateHandoffTokens, renderHandoff, type WorkerHandoff } from '../src/core/verse/handoff.js';

const handoff: WorkerHandoff = {
  id: 'task-1', task: 'Private fixture task', files: [{ path: 'src/fixture.ts' }],
  constraints: [{ rule: 'Keep the interface', reason: 'Existing callers depend on it' }],
  check: 'Never execute this check',
};
let dir: string, file: string, root: string, out: string[], err: string[];
const args = () => ['--file', file, '--id', 'delivery-1', '--from', 'planner', '--to', 'worker'];
const run = (...extra: string[]) => cmdFleetHandoffSend([...args(), ...extra], { root });
const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
const report = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-send-')));
  file = join(dir, 'input.json'); root = join(dir, 'bus'); out = []; err = [];
  write(handoff);
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { out.push(String(message)); });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => { err.push(String(message)); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('fleet handoff-send delivery', () => {
  it('previews validation, destination and estimates without creating a store', async () => {
    expect(await run('--json')).toBe(0);
    expect(report()).toMatchObject({ valid: true, status: 'preview', destination: 'worker',
      renderedChars: renderHandoff(handoff).length, estimatedTokens: estimateHandoffTokens(handoff),
      envelope: { id: 'delivery-1', from: 'planner', to: 'worker', priority: 'P3',
        body: { kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) } } });
    expect(existsSync(root)).toBe(false);
    out = [];
    expect(await run()).toBe(0);
    expect(out.join()).not.toContain(handoff.task);
    expect(existsSync(root)).toBe(false);
  });

  it('delivers the exact rendered prompt once, with metadata-only receipts and stable retry', async () => {
    expect(await run('--apply', '--json')).toBe(0);
    expect(report()).toEqual({ v: 1, status: 'posted', id: 'delivery-1', cursor: 1 });
    expect(out.join()).not.toContain(handoff.task);
    expect(await run('--apply', '--json')).toBe(0);
    expect(report()).toEqual({ v: 1, status: 'duplicate', id: 'delivery-1', cursor: 1 });
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('inbox unavailable');
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.envelope.body).toEqual({ kind: 'worker-handoff', taskId: handoff.id, prompt: renderHandoff(handoff) });
  });

  it('preserves conflicting ID and unavailable store refusals', async () => {
    expect(await run('--apply', '--json')).toBe(0);
    write({ ...handoff, task: 'Another private task' });
    expect(await run('--apply', '--json')).toBe(1);
    expect(report()).toEqual({ v: 1, status: 'conflict' });
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status === 'ok' && page.messages).toHaveLength(1);
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{');
    expect(await run('--apply', '--json')).toBe(1);
    expect(report()).toEqual({ v: 1, status: 'unavailable' });
  });

  it.each([
    { ...handoff, constraints: [{ rule: 'Keep it', reason: '' }] },
    { ...handoff, constraints: [{ rule: 'Keep it' }] },
    { ...handoff, task: 'x'.repeat(6001) },
    { ...handoff, files: [null] }, null, [],
  ])('rejects invalid or oversized handoff %# without posting', async input => {
    write(input);
    expect(await run('--apply', '--json')).toBe(1);
    expect(report()).toMatchObject({ valid: false });
    expect(out.join()).not.toContain(handoff.task);
    expect(existsSync(root)).toBe(false);
  });

  it('rejects malformed, missing, oversized and symlink input without posting', async () => {
    writeFileSync(file, '{');
    expect(await run('--apply')).toBe(1);
    writeFileSync(file, 'x'.repeat(64 * 1024 + 1));
    expect(await run('--apply')).toBe(1);
    rmSync(file);
    expect(await run('--apply')).toBe(1);
    const target = join(dir, 'target'); writeFileSync(target, JSON.stringify(handoff)); symlinkSync(target, file);
    expect(await run('--apply')).toBe(1);
    expect(existsSync(root)).toBe(false);
  });

  it.each([['--unknown'], ['--json', '--json'], ['--apply', '--apply'], ['--id', 'other']])(
    'rejects unknown and repeated flags %j', async (...extra) => {
      expect(await run(...extra)).toBe(2);
      expect(existsSync(root)).toBe(false);
    });

  it('sanitizes preview and human output while retaining the original prompt in the inbox', async () => {
    const unsafe = { ...handoff, task: 'Private \u001b[31m red \u202e text' };
    write(unsafe);
    expect(await run('--json')).toBe(0);
    expect(out.join()).not.toContain('\u001b');
    expect(out.join()).not.toContain('\u202e');
    expect(await run('--apply')).toBe(0);
    expect(out.at(-1)).not.toContain(unsafe.task);
    const page = listBusInboxAfter(0, 50, { root });
    expect(page.status === 'ok' && page.messages[0]?.envelope.body).toMatchObject({ prompt: renderHandoff(unsafe) });
  });
});
