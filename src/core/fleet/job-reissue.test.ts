import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DROP_JOB_ID, DROP_JOB_MAX_FILE_BYTES } from './drop-job-writer.js';
import { nextReissueId, reissueJob } from './job-reissue.js';

let runsDir: string;
beforeEach(async () => { runsDir = await realpath(await mkdtemp(join(tmpdir(), 'reissue-'))); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
const id = 'RQ-PHX-EXAMPLE31';
it('strips prefix and suffix, skips collisions, and shortens long stems', () => {
  expect(nextReissueId(`${id}R9`, x => x === 'EXAMPLE31R1')).toBe('EXAMPLE31R2');
  expect(nextReissueId('A'.repeat(40), () => false)).toBe(`${'A'.repeat(38)}R1`);
  expect(nextReissueId('R12', () => false)).toMatch(DROP_JOB_ID);
});
it.each([true, false])('reissues a prompt (header=%s), preserves body and records R1 then R2', async header => {
  const body = 'Goal: recover the finished work.\nKeep this line.\n';
  await writeFile(join(runsDir, `${id}.prompt`), header ? `#job repo=phantom lane=devin tier=work\n\n${body}` : body);
  for (const newId of ['EXAMPLE31R1', 'EXAMPLE31R2']) {
    const result = await reissueJob(id, { runsDir, lane: 'codex-personal' });
    expect(result).toMatchObject({ outcome: 'written', id, newId });
    expect(result.file).toBe(join(runsDir, 'leader/drop/claude', `RQ-PHX-${newId}.md`));
    expect(await readFile(result.file!, 'utf8')).toBe(`#job repo=phantom lane=${header ? 'devin' : 'codex-personal'} tier=${header ? 'work' : 'mid'}\n\n${body}`);
  }
  const audit = (await readFile(join(runsDir, 'queue/job-reissues.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(audit.map(row => row.to)).toEqual(['EXAMPLE31R1', 'EXAMPLE31R2']);
  expect(audit[0]).toMatchObject({ from: id, lane: header ? 'devin' : 'codex-personal', tier: header ? 'work' : 'mid' });
});
it('reroutes a down Claude lane', async () => {
  await writeFile(join(runsDir, `${id}.prompt`), '#job repo=phantom lane=claude tier=frontier\n\nRecover work.\n');
  await writeFile(join(runsDir, 'claude-lane.state'), 'down: quota 2026-11-01T00:00:00Z');
  const result = await reissueJob(id, { runsDir });
  expect(await readFile(result.file!, 'utf8')).toContain('lane=codex-personal tier=frontier');
});
it('refuses missing, oversized and invalid prompts', async () => {
  expect((await reissueJob(id, { runsDir })).outcome).toBe('refused');
  await writeFile(join(runsDir, `${id}.prompt`), 'x'.repeat(DROP_JOB_MAX_FILE_BYTES + 1));
  expect(await reissueJob(id, { runsDir })).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('too large') });
  expect((await reissueJob('../escape', { runsDir })).outcome).toBe('refused');
});
