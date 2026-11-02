import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFleetJobDetail, type FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';

const job = 'RQ-FAKE-UPGRADE-ARCHIVE';
const sha = 'abc1234def5678';
const branch = 'fake/upgrade-archive';
const worktree = '/fake/private-worktree/upgrade-sentinel';
const prompt = 'FAKE-PROMPT-BODY-DO-NOT-RETURN';
const prUrl = 'https://example.invalid/fake/phantom/pull/330';
const launchTime = new Date('2026-01-01T00:00:00Z');
const logTime = new Date('2026-01-01T00:01:00Z');
const publishTime = new Date('2026-01-01T00:02:00Z');
const archiveTime = new Date('2026-01-01T00:03:00Z');
let runs: string;

beforeEach(async () => {
  runs = await mkdtemp(join(tmpdir(), 'fake-upgrade-archive-'));
  await artifact('launch', `launched ${job} fake-lane pid 330 base ${sha}\n`, launchTime);
  await artifact('base', `${sha} ${branch} ${worktree}\n`, launchTime);
  await artifact('base.meta', 'MODEL fake-lane work fake-model\n', launchTime);
  await artifact('prompt', prompt, launchTime);
});

afterEach(async () => { await rm(runs, { recursive: true, force: true }); });

async function artifact(suffix: string, content: string | Buffer, time: Date): Promise<void> {
  const path = join(runs, `${job}.${suffix}`);
  await writeFile(path, content);
  await utimes(path, time, time);
}

async function publish(): Promise<void> {
  await artifact('publish', `RESULT PR ${prUrl}\nAUTO_MERGE on\nTEST fake check exit 0\nSENS=[]\n`, publishTime);
}

async function archiveLiveLog(): Promise<Buffer> {
  const livePath = join(runs, `${job}.log`);
  const archive = gzipSync(await readFile(livePath));
  await artifact('log.gz', archive, archiveTime);
  await rm(livePath);
  return archive;
}

function expectPrivateFixtureAbsent(detail: FleetJobDetailV1): void {
  const serialized = JSON.stringify(detail);
  expect(serialized).not.toContain(prompt);
  expect(serialized).not.toContain(worktree);
  expect(serialized).not.toContain('fake-log-secret-value');
}

describe('upgrade job log archive filesystem lifecycle', () => {
  it('keeps published job evidence and a bounded scrubbed tail when the live log becomes gzip', async () => {
    const lines = Array.from({ length: 125 }, (_, index) => `fake work line ${index}`);
    // The last line is intentionally unfinished, as it can be while a worker is writing.
    const content = [...lines, 'api_key=fake-log-secret-value', 'last partial line'].join('\n');
    await artifact('log', content, logTime);
    const options = { runsDir: runs, now: () => new Date('2026-01-01T00:04:00Z') };
    const running = await getFleetJobDetail(job, options);
    expect(running).toMatchObject({
      schema: 'fleet.job.v1', job, state: 'running', lane: 'fake-lane', tier: 'work',
      model: 'fake-model', pid: 330, baseSha: sha, branch, promptBytes: Buffer.byteLength(prompt),
      publish: null, sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'missing', log: 'healthy' },
    });
    const expectedTail = [...lines, '[redacted line]', 'last partial line'].slice(-120);
    expect(running.log).toEqual({ source: 'live', bytes: Buffer.byteLength(content), tail: expectedTail, truncated: true });
    expectPrivateFixtureAbsent(running);

    await publish();
    const published = await getFleetJobDetail(job, options);
    expect(published.state).toBe('published');
    expect(published.publish).toEqual({ prUrl, autoMerge: true, testLine: 'TEST fake check exit 0', sensitive: [] });
    expect(published.sources).toEqual({ launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' });
    expect(published.log).toEqual(running.log);
    expectPrivateFixtureAbsent(published);

    const archive = await archiveLiveLog();
    const archived = await getFleetJobDetail(job, options);
    expect(archived).toEqual({
      ...published,
      log: { source: 'archived', bytes: archive.length, tail: expectedTail, truncated: true },
    });
    expectPrivateFixtureAbsent(archived);
  });

  it('keeps an empty gzip archive healthy and inspectable after publish', async () => {
    await artifact('log', '', logTime);
    await publish();
    const live = await getFleetJobDetail(job, { runsDir: runs });
    expect(live.log).toEqual({ source: 'live', bytes: 0, tail: [], truncated: false });
    expect(live.sources.log).toBe('healthy');

    const archive = await archiveLiveLog();
    const archived = await getFleetJobDetail(job, { runsDir: runs });
    expect(archived).toMatchObject({
      job, state: 'published', lane: 'fake-lane', baseSha: sha, branch,
      publish: { prUrl },
      sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
      log: { source: 'archived', bytes: archive.length, tail: [], truncated: false },
    });
    expectPrivateFixtureAbsent(archived);
  });
});
