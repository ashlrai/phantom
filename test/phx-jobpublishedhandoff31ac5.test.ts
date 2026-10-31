import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const job = 'RQ-FAKE-PUBLISHED-HANDOFF';
const pr = 'https://github.com/example/project/pull/123';
const notes = '# Handoff\nThe worker verified the handoff; review PR 123.\n';
let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'published-handoff-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

async function artifact(suffix: string, content: string | Buffer, time: string) {
  const path = join(runsDir, `${job}.${suffix}`);
  await writeFile(path, content);
  const date = new Date(time);
  await utimes(path, date, date);
}

describe('published worker handoff', () => {
  it('lets a new agent recover the current published job and its notes despite an older archive', async () => {
    await artifact('log.gz', gzipSync('Previous attempt: abandoned PR 99\n'), '2026-10-30T22:00:00Z');
    await artifact('launch', `launched ${job} codex-cmp pid 4242 base abc1234\n`, '2026-10-30T23:00:00Z');
    await artifact('base', 'abc1234 codex-bridge/fake-handoff /fake/worktree\n', '2026-10-30T23:00:00Z');
    await artifact('base.meta', 'MODEL codex-cmp work fake-model-v1\n', '2026-10-30T23:00:00Z');
    await artifact('log', 'Worker completed the current handoff.\n', '2026-10-30T23:30:00Z');
    await artifact('publish', `RESULT PR ${pr}\nAUTO_MERGE on\nTEST isolated suite exit 0\nSENS=[]\n`, '2026-10-30T23:40:00Z');
    await artifact('notes.md', notes, '2026-10-30T23:41:00Z');

    const readers = {
      detail: (id: string) => getFleetJobDetail(id, { runsDir }),
      changes: getFleetJobChanges,
      text: (id: string, kind: 'notes' | 'prompt') => getFleetJobText(id, kind, { runsDir }),
    };
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await cmdFleetJobRead([job, '--json'], readers)).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    const detail = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(detail).toMatchObject({
      schema: 'fleet.job.v1', job, state: 'published', lane: 'codex-cmp', tier: 'work', model: 'fake-model-v1',
      baseSha: 'abc1234', branch: 'codex-bridge/fake-handoff',
      publish: { prUrl: pr, autoMerge: true, testLine: 'TEST isolated suite exit 0', sensitive: [] },
      notes: { hasNotes: true, hasBody: false, notesBytes: Buffer.byteLength(notes) },
      log: { source: 'live', tail: ['Worker completed the current handoff.'], truncated: false },
      sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
    });
    expect(JSON.stringify(detail)).not.toContain('Previous attempt');

    expect(await cmdFleetJobRead([job, '--notes', '--json'], readers)).toBe(0);
    expect(output).toHaveBeenCalledTimes(2);
    const handoff = JSON.parse(String(output.mock.calls[1]?.[0]));
    expect(handoff).toMatchObject({
      v: 1, job: detail.job, kind: 'notes', state: 'ok', bytes: Buffer.byteLength(notes), truncated: false, text: notes,
    });
    expect(stderr).not.toHaveBeenCalled();
  });
});
