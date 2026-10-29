import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readQueueVisits, recordQueueVisit } from '../src/core/queue/journal.js';
vi.mock('node:fs/promises', () => ({ appendFile: vi.fn(), mkdir: vi.fn(), readFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const visit = { id: '1', station: 'work', pool: 'codex', arrivedAt: 0 };
it('records only validated metadata with private creation permissions', async () => {
  await recordQueueVisit({ ...visit, prompt: 'excluded' } as typeof visit, '/tmp/queue/visits.jsonl');
  expect(mkdir).toHaveBeenCalledWith('/tmp/queue', { recursive: true });
  expect(appendFile).toHaveBeenCalledWith('/tmp/queue/visits.jsonl', JSON.stringify(visit) + '\n', { mode: 0o600 });
  await expect(recordQueueVisit({ ...visit, arrivedAt: NaN })).rejects.toThrow('Invalid queue visit');
  expect(appendFile).toHaveBeenCalledTimes(1);
});
it('reads snapshots, treats a missing journal as empty and refuses corrupt data', async () => {
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(visit) + '\n');
  expect(await readQueueVisits()).toEqual([visit]);
  vi.mocked(readFile).mockRejectedValueOnce({ code: 'ENOENT' });
  expect(await readQueueVisits()).toEqual([]);
  for (const line of ['{', '{}']) {
    vi.mocked(readFile).mockResolvedValueOnce(line);
    await expect(readQueueVisits()).rejects.toThrow('Invalid queue journal line 1');
  }
  vi.mocked(readFile).mockRejectedValueOnce(new Error('private path'));
  await expect(readQueueVisits()).rejects.toThrow('Cannot read queue journal');
});
