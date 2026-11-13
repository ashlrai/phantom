import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsagePace } from '../src/core/usage/pace.js';

describe('bounded usage pace reads', () => {
  it('accepts small and exactly bounded JSON and rejects oversized, malformed and missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pace-'));
    const path = join(dir, 'status.json');
    const unknown = await readUsagePace(join(dir, 'missing'));
    try {
      const valid = JSON.stringify({ schema: 'dispatchd.status.v1', last_tick: new Date().toISOString() });
      await writeFile(path, valid);
      expect((await readUsagePace(path)).asOf).not.toBeNull();
      await writeFile(path, valid + ' '.repeat(1024 * 1024 - Buffer.byteLength(valid)));
      expect((await readUsagePace(path)).asOf).not.toBeNull();
      await writeFile(path, valid + ' '.repeat(1024 * 1024 - Buffer.byteLength(valid)) + ' ');
      expect(await readUsagePace(path)).toEqual(unknown);
      await writeFile(path, valid + ' '.repeat(1024 * 1024 - Buffer.byteLength(valid) - 1) + 'é');
      expect(await readUsagePace(path)).toEqual(unknown);
      await writeFile(path, '{');
      expect(await readUsagePace(path)).toEqual(unknown);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('bounds reads and closes the handle when reading fails', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockRejectedValue(new Error('synthetic'));
    const openFile = vi.fn().mockResolvedValue({ read, close });
    {
      await readUsagePace('/synthetic', openFile as never);
      expect(read.mock.calls[0][2]).toBe(1024 * 1024 + 1);
      expect(close).toHaveBeenCalledOnce();
    }
  });
});
