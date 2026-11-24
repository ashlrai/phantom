import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { queueJournalPath, readQueueVisits, recordQueueVisit } from '../src/core/queue/journal.js';
vi.mock('node:fs/promises', () => ({ appendFile: vi.fn(), mkdir: vi.fn(), readFile: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const visit = { id: '1', station: 'work', pool: 'codex', arrivedAt: 0 };
it('resolves the journal from the current absolute ASHLR_HOME on every call', async () => {
  for (const root of ['/tmp/queue-home-one', '/tmp/queue-home-two']) {
    vi.stubEnv('ASHLR_HOME', root);
    const path = join(root, 'queue', 'visits.jsonl');
    expect(queueJournalPath()).toBe(path);
    await recordQueueVisit(visit);
    expect(appendFile).toHaveBeenLastCalledWith(path, JSON.stringify(visit) + '\n', { mode: 0o600 });
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(visit) + '\n');
    expect(await readQueueVisits()).toEqual([visit]);
    expect(readFile).toHaveBeenLastCalledWith(path, 'utf8');
  }
});
it.each([undefined, '', ' ', 'relative/path'])('falls back to the home directory for ASHLR_HOME=%j', (root) => {
  vi.stubEnv('ASHLR_HOME', root);
  expect(queueJournalPath()).toBe(join(homedir(), '.ashlr', 'queue', 'visits.jsonl'));
});
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
