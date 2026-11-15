import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRunEvents } from '../src/cli/fleet-run-events.js';

let dir = '';
afterEach(async () => { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });
const event = (seq: number, kind: string, parent: string | null, branch = 'main', data: object = {}) =>
  ({ schema: 'run.event.v1', seq, id: `e${seq}`, job: 'job-1', at: '2026-11-05T00:00:00Z', branch, parent, kind, data });

describe('retained run event reader', () => {
  it('reads original records, replays branches and preserves all artifacts', async () => {
    dir = await mkdtemp(join(tmpdir(), 'event-reader-'));
    const file = join(dir, 'job-1.events.jsonl');
    const records = [event(1, 'launch', null), event(2, 'checkpoint', 'e1', 'main', { ref: 'cp-1' }),
      event(3, 'finish', 'e2', 'main', { status: 'ok' }), event(4, 'head', 'e3', 'main', { event: 'e1', branch: 'side' }),
      event(5, 'note', 'e1', 'side'), event(6, 'head', 'e5', 'side', { event: 'e3' })];
    const content = records.map(e => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(file, content);
    const before = await readdir(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const call = async (...args: string[]) => {
      log.mockClear();
      const code = await cmdFleetRunEvents([...args, '--runs-dir', dir, '--json']);
      return { code, body: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
    };
    expect((await call('replay', 'job-1')).body).toMatchObject({ phase: 'finished', path: ['e1', 'e2', 'e3'], checkpoint: { ref: 'cp-1' }, deferred: false });
    expect((await call('replay', 'job-1', '--at', 'e5')).body).toMatchObject({ phase: 'running', path: ['e1', 'e5'], head: { branch: 'side' } });
    expect((await call('head', 'job-1')).body).toMatchObject({ id: 'e3', branch: 'main' });
    expect((await call('branches', 'job-1')).body.branches).toEqual([{ name: 'main', tip: 'e4', depth: 4 }, { name: 'side', tip: 'e6', depth: 2 }]);
    expect((await call('list', 'job-1')).body.events).toEqual(records);
    expect((await call('replay', 'missing')).body).toMatchObject({ phase: 'empty', path: [], deferred: false });
    await writeFile(file, content + '{"schema":');
    expect((await call('replay', 'job-1')).body).toMatchObject({ deferred: true, phase: 'finished' });
    const torn = await readFile(file, 'utf8');
    expect(await readdir(dir)).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe(torn);
    await writeFile(file, JSON.stringify(event(1, 'launch', 'e9')) + '\n');
    expect(await call('replay', 'job-1')).toMatchObject({ code: 1, body: { code: 'invalid-log' } });
    expect(await call('replay', '../bad')).toMatchObject({ code: 1, body: { code: 'invalid-job' } });
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(event(1, 'launch', 'e9')) + '\n');
    expect(await readdir(dir)).toEqual(before);
  });
});
