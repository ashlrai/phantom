import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import type { FleetJobTextV1 } from '../src/core/fleet/runs-job-texts.js';

const job = 'RQ-FAKE-DAYONE-JOIN';
const pr = 'https://github.com/example/project/pull/456';
const promptText = 'Implement the fake day-one handoff and verify the join.\n';
const logLine = 'Worker finished the day-one join run.\n';
const notesText = '# Handoff\nWorker verified the join; review PR 456.\n';
const NOW = '2026-10-31T23:46:00.000Z';

let home: string;
let runsDir: string;
let output: string[];
let stdoutText: string;
let stderrText: string;

const artifactPath = (suffix: string) => join(runsDir, `${job}.${suffix}`);

async function artifact(suffix: string, content: string | Buffer, time: string) {
  const path = artifactPath(suffix);
  await writeFile(path, content);
  const date = new Date(time);
  await utimes(path, date, date);
}

/** Canonical per-job artifacts for one completed (published) attempt; notes not yet shipped. */
async function completedJob() {
  await artifact('log.gz', gzipSync('Previous attempt: abandoned PR 99\n'), '2026-10-30T22:00:00Z');
  await artifact('launch', `launched ${job} codex-cmp pid 4242 base abc1234\n`, '2026-10-30T23:00:00Z');
  await artifact('base', `abc1234 codex-bridge/fake-dayone ${join(home, 'worktree')}\n`, '2026-10-30T23:00:00Z');
  await artifact('base.meta', 'MODEL codex-cmp work fake-model-v1\n', '2026-10-30T23:00:00Z');
  await artifact('prompt', promptText, '2026-10-30T23:05:00Z');
  await artifact('log', logLine, '2026-10-30T23:30:00Z');
  await artifact('publish', `RESULT PR ${pr}\nAUTO_MERGE on\nTEST isolated suite exit 0\nSENS=[]\n`, '2026-10-30T23:40:00Z');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-job-dayone-'));
  runsDir = join(home, '.ashlr-runs');
  await mkdir(runsDir);
  vi.stubEnv('HOME', home);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  output = [];
  stdoutText = '';
  stderrText = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdoutText += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderrText += String(chunk); return true; });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('day-one completed-job read join', () => {
  it('joins detail, prompt and notes reads for one published job through the shipped readers', async () => {
    await completedJob();

    // Job detail through the shipped handler default readers -> <stubbed HOME>/.ashlr-runs.
    expect(await cmdFleetJobRead([job, '--json'])).toBe(0);
    const detail = JSON.parse(output[0]!) as FleetJobDetailV1;
    expect(detail).toMatchObject({
      schema: 'fleet.job.v1', job, state: 'published',
      lane: 'codex-cmp', tier: 'work', model: 'fake-model-v1', pid: 4242,
      launchedAt: '2026-10-30T23:00:00.000Z',
      baseSha: 'abc1234', branch: 'codex-bridge/fake-dayone',
      promptBytes: Buffer.byteLength(promptText),
      publish: { prUrl: pr, autoMerge: true, testLine: 'TEST isolated suite exit 0', sensitive: [] },
      notes: { hasNotes: false, hasBody: false, notesBytes: null },
      log: { source: 'live', tail: ['Worker finished the day-one join run.'], truncated: false },
      sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
      generatedAt: NOW,
    });
    // The handler output is exactly the real reader projection — nothing synthesized.
    expect(detail).toEqual(await getFleetJobDetail(job));
    expect(output[0]).not.toContain(home);
    expect(output[0]).not.toContain('Previous attempt');
    expect(stderrText).toBe('');

    // --prompt identifies the same job and returns the scrubbed artifact text.
    expect(await cmdFleetJobRead([job, '--prompt', '--json'])).toBe(0);
    const prompt = JSON.parse(output[1]!) as FleetJobTextV1;
    expect(prompt).toEqual({
      v: 1, job: detail.job, kind: 'prompt', state: 'ok', source: null,
      bytes: Buffer.byteLength(promptText), truncated: false, text: promptText,
    });

    // With neither notes.md nor body.md on disk, --notes reports missing — never success.
    expect(await cmdFleetJobRead([job, '--notes', '--json'])).toBe(1);
    const missing = JSON.parse(output[2]!) as FleetJobTextV1;
    expect(missing).toEqual({
      v: 1, job: detail.job, kind: 'notes', state: 'missing', source: null,
      bytes: null, truncated: false, text: '',
    });

    // A later published notes artifact is picked up by a fresh invocation.
    await artifact('notes.md', notesText, '2026-10-31T00:05:00Z');
    expect(await cmdFleetJobRead([job, '--notes', '--json'])).toBe(0);
    const notes = JSON.parse(output[3]!) as FleetJobTextV1;
    expect(notes).toEqual({
      v: 1, job: detail.job, kind: 'notes', state: 'ok', source: 'notes',
      bytes: Buffer.byteLength(notesText), truncated: false, text: notesText,
    });
    expect(await readFile(artifactPath('notes.md'), 'utf8')).toBe(notesText);

    // A new detail invocation joins the landed notes artifact; the job stays published.
    expect(await cmdFleetJobRead([job, '--json'])).toBe(0);
    const rejoined = JSON.parse(output[4]!) as FleetJobDetailV1;
    expect(rejoined).toMatchObject({
      job: detail.job, state: 'published',
      notes: { hasNotes: true, hasBody: false, notesBytes: Buffer.byteLength(notesText) },
      generatedAt: NOW,
    });

    // The publish evidence gate agrees the handoff is complete.
    expect(await cmdFleetJobRead([job, '--require-published', '--json'])).toBe(0);
    const checked = JSON.parse(output[5]!) as FleetJobDetailV1 & { check: Record<string, unknown> };
    expect(checked.job).toBe(detail.job);
    expect(checked.check).toEqual({ kind: 'published_handoff_evidence', ok: true, hasPrUrl: true, hasTestLine: true });

    expect(prompt.job).toBe(detail.job);
    expect(missing.job).toBe(detail.job);
    expect(notes.job).toBe(detail.job);
    expect(stderrText).toBe('');
  });

  it('keeps the human text modes aligned with the same artifacts and exit contract', async () => {
    await completedJob();

    expect(await cmdFleetJobRead([job])).toBe(0);
    expect(output.join('\n')).toContain(`Fleet job ${job}: published`);
    expect(output.join('\n')).toContain('publish=healthy');
    output = [];

    expect(await cmdFleetJobRead([job, '--prompt'])).toBe(0);
    expect(stdoutText).toBe(promptText);
    expect(stderrText).toBe('prompt: ok; truncated: no\n');
    stdoutText = '';
    stderrText = '';

    expect(await cmdFleetJobRead([job, '--notes'])).toBe(1);
    expect(stdoutText).toBe('');
    expect(stderrText).toBe('notes: missing; truncated: no\n');
    stderrText = '';

    await artifact('notes.md', notesText, '2026-10-31T00:05:00Z');
    expect(await cmdFleetJobRead([job, '--notes'])).toBe(0);
    expect(stdoutText).toBe(notesText);
    expect(stderrText).toBe('notes: ok; truncated: no\n');
  });
});
