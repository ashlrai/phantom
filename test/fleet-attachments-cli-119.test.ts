import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetAttachments } from '../src/cli/fleet-attachments.js';

it('prints JSON and table rows with absolute paths', async () => {
  const runs = mkdtempSync(join(tmpdir(), 'media-cli-'));
  const old = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runs;
  const name = '0123456789abcdef.png';
  const path = join(runs, 'inbox-attachments', name);
  mkdirSync(join(runs, 'inbox-attachments'));
  writeFileSync(path, Buffer.from([137,80,78,71,13,10,26,10]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetAttachments(['--json', '--limit', '1'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).items[0]).toMatchObject({ name, path, bytes: 8 });
    log.mockClear();
    expect(await cmdFleetAttachments([])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain(`${name}  image/png  8 B`);
    expect(log.mock.calls[0]?.[0]).toContain(path);
  } finally { log.mockRestore(); if (old === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = old; rmSync(runs, { recursive: true, force: true }); }
});
