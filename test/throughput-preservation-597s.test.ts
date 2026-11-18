import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetYield } from '../src/cli/fleet-yield.js';

it('distinguishes missing metrics from a measured empty ledger without writing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'throughput-586s-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const missing = join(dir, 'missing.jsonl');
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '');
    expect(await cmdFleetYield(['--metrics', missing, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ known: false, launches: 0 });
    expect(await cmdFleetYield(['--metrics', empty, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ known: true, launches: 0 });
    expect(await readdir(dir)).toEqual(['empty.jsonl']);
    expect(await readFile(empty, 'utf8')).toBe('');
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
