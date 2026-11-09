import { mkdtemp, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { fleetEvents } from '../src/core/fleet/events.js';

let queueDir: string;
const line = (job: string): string => JSON.stringify({ job, event: 'dispatch', ts: '2026-10-29', pool: 'codex' }) + '\n';
const collect = async (cursor?: string) => Array.fromAsync(fleetEvents({ queueDir, cursor }));
beforeEach(async () => { queueDir = await mkdtemp(join(tmpdir(), 'fleet-events-')); });
afterEach(async () => { await rm(queueDir, { recursive: true, force: true }); });

describe('standalone fleet event journals', () => {
  it('routes the CLI to NDJSON without fleet state and refuses invalid options', async () => {
    await writeFile(join(queueDir, 'jobs.jsonl'), line('cli'));
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(await cmdFleet(['events', '--json', '--queue-dir', queueDir])).toBe(0);
      expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ job: 'cli', source: 'jobs.jsonl' });
      expect(await cmdFleet(['events'])).toBe(2);
      expect(await cmdFleet(['events', '--json', '--cursor'])).toBe(2);
      expect(await cmdFleet(['events', '--json', '--cursor', 'invalid', '--queue-dir', queueDir])).toBe(1);
    } finally { output.mockRestore(); errors.mockRestore(); }
  });
  it('normalizes both sources with stable ids and resumes across sources', async () => {
    await writeFile(join(queueDir, 'dispatch-events.log'), line('a') + line('b'));
    await writeFile(join(queueDir, 'jobs.jsonl'), line('c'));
    const events = await collect();
    expect(events.map(e => e.job)).toEqual(['a', 'b', 'c']);
    expect(events[0]).toMatchObject({ v: 1, source: 'dispatch-events.log', at: '2026-10-29', type: 'dispatch', pool: 'codex' });
    expect(await collect(events[0]!.cursor)).toEqual(events.slice(1));
    expect(await collect(events[2]!.cursor)).toEqual([]);
    expect((await collect()).map(e => e.id)).toEqual(events.map(e => e.id));
  });

  it('tails missing files and buffers incomplete UTF-8 lines until newline', async () => {
    const controller = new AbortController();
    const stream = fleetEvents({ queueDir, follow: true, signal: controller.signal, pollMs: 1 });
    const pending = stream.next();
    await writeFile(join(queueDir, 'jobs.jsonl'), line('first'));
    const first = await pending;
    expect(first.value?.job).toBe('first');
    const text = Buffer.from(line('café'));
    const split = text.indexOf(Buffer.from('é')) + 1;
    await appendFile(join(queueDir, 'jobs.jsonl'), text.subarray(0, split));
    const next = stream.next();
    await appendFile(join(queueDir, 'jobs.jsonl'), text.subarray(split));
    expect((await next).value?.job).toBe('café');
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it('recovers a truncated log, including a replacement longer than the old offset', async () => {
    const path = join(queueDir, 'jobs.jsonl');
    await writeFile(path, line('old'));
    const [old] = await collect();
    await writeFile(path, line('new') + line('extra'));
    expect((await collect(old!.cursor)).map(e => e.job)).toEqual(['new', 'extra']);
    await writeFile(path, '{}\n');
    expect((await collect(old!.cursor)).map(e => e.type)).toEqual(['unknown']);
    await rename(path, path + '.old');
    await writeFile(path, line('rotated'));
    expect((await collect(old!.cursor)).map(e => e.job)).toEqual(['rotated']);
  });

  it('skips malformed complete rows and retains partial rows on resume', async () => {
    const path = join(queueDir, 'jobs.jsonl');
    await writeFile(path, line('a') + 'bad\nnull\n[]\n' + line('b').trimEnd());
    const events = await collect();
    expect(events.map(e => e.job)).toEqual(['a']);
    await appendFile(path, '\n');
    expect((await collect(events[0]!.cursor)).map(e => e.job)).toEqual(['b']);
    await expect(collect('invalid')).rejects.toThrow('Invalid fleet events cursor');
  });
});
