import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const job = 'RQ-PHX-EXAMPLE1';
let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fleet-texts-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
it('reads notes and the brief', async () => {
  for (const kind of ['notes', 'prompt'] as const) {
    await writeFile(join(runsDir, `${job}.${kind === 'notes' ? 'notes.md' : 'prompt'}`), 'Finished the requested fix.');
    expect(await getFleetJobText(job, kind, { runsDir })).toEqual({
      v: 1, job, kind, state: 'ok', bytes: 27, truncated: false, text: 'Finished the requested fix.',
    });
  }
});
it('reports missing files without throwing', async () => {
  expect(await getFleetJobText(job, 'notes', { runsDir })).toMatchObject({ state: 'missing', bytes: null, text: '' });
});
it('bounds a 70 KB read and reports the full byte count', async () => {
  await writeFile(join(runsDir, `${job}.notes.md`), 'x '.repeat(35 * 1024));
  const result = await getFleetJobText(job, 'notes', { runsDir });
  expect(result.bytes).toBe(70 * 1024);
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text)).toBe(65536);
  expect((await getFleetJobText(job, 'notes', { runsDir, maxBytes: 8 })).text).toBe('x x x x ');
});
it('scrubs long secret-looking runs and credential assignments', async () => {
  await writeFile(join(runsDir, `${job}.notes.md`), `${'FAKE_'.repeat(10)}\ntoken=fake-value\nkey=fake value\nBearer fake-value\nSafe notes`);
  expect((await getFleetJobText(job, 'notes', { runsDir })).text).toBe('…\ntoken=…\nkey=…\nBearer …\nSafe notes');
});
it.each(['../x', 'RQ-PHX-EXAMPLE1/../y'])('rejects invalid id %s', async id => {
  await expect(getFleetJobText(id, 'notes', { runsDir })).rejects.toThrow('invalid fleet job id');
});
it('rejects relative runs directories', async () => {
  await expect(getFleetJobText(job, 'notes', { runsDir: 'relative' })).rejects.toThrow('absolute');
});
it('does not read symlinks or directories', async () => {
  const target = join(runsDir, 'target');
  await writeFile(target, 'Do not disclose');
  await symlink(target, join(runsDir, `${job}.notes.md`));
  await mkdir(join(runsDir, `${job}.prompt`));
  for (const kind of ['notes', 'prompt'] as const) {
    expect(await getFleetJobText(job, kind, { runsDir })).toMatchObject({ state: 'unreadable', text: '' });
  }
});
