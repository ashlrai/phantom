import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

const job = 'FAKE-RETRY-JOB';
const old = new Date('2026-01-01T00:00:00Z');
const launch = new Date('2026-01-01T00:01:00Z');
const live = new Date('2026-01-01T00:02:00Z');
const completed = new Date('2026-01-01T00:03:00Z');
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fake-job-retry-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function artifact(suffix: string, contents: string | Buffer, time: Date): Promise<void> {
  const path = join(root, `${job}.${suffix}`);
  await writeFile(path, contents);
  await utimes(path, time, time);
}

async function retry(): Promise<void> {
  await artifact('log.gz', gzipSync('old fake archive\n'), old);
  await artifact('publish', 'RESULT PR https://example.invalid/old\n', old);
  await artifact('launch', `launched ${job} fake-lane pid 123 base abc1234\n`, launch);
  await artifact('log', 'old partial line\ncurrent fake work\napi_key=fake-example-value\n', live);
}

describe('job detail retry artifacts', () => {
  it('shows a newer retry and its bounded, redacted live log over an older archive and publish', async () => {
    await retry();
    const detail = await getFleetJobDetail(job, { runsDir: root, maxTailLines: 2 });
    expect(detail.state).toBe('running');
    expect(detail.log).toMatchObject({ source: 'live', tail: ['current fake work', '[redacted line]'], truncated: true });
    expect(detail.sources).toMatchObject({ launch: 'healthy', log: 'healthy', publish: 'healthy' });
    expect(JSON.stringify(detail)).not.toContain('fake-example-value');
  });

  it('reports a later publish even while the live log and old archive remain', async () => {
    await retry();
    await artifact('publish', 'RESULT PR https://example.invalid/new\n', completed);
    const detail = await getFleetJobDetail(job, { runsDir: root });
    expect(detail.state).toBe('published');
    expect(detail.publish?.prUrl).toBe('https://example.invalid/new');
    expect(detail.log.source).toBe('live');
  });

  it('reports an archive without a current attempt', async () => {
    await artifact('log.gz', gzipSync('fake archived work\n'), old);
    const detail = await getFleetJobDetail(job, { runsDir: root });
    expect(detail.state).toBe('archived');
    expect(detail.log).toMatchObject({ source: 'archived', tail: ['fake archived work'] });
  });

  it('does not treat a stale live log as evidence of a new attempt', async () => {
    await retry();
    await utimes(join(root, `${job}.log`), old, old);
    const detail = await getFleetJobDetail(job, { runsDir: root });
    expect(detail.state).toBe('published');
  });

  it('does not let a late log write override a newer publish', async () => {
    await retry();
    await artifact('publish', 'RESULT PR https://example.invalid/new\n', completed);
    await utimes(join(root, `${job}.log`), new Date('2026-01-01T00:04:00Z'), new Date('2026-01-01T00:04:00Z'));
    expect((await getFleetJobDetail(job, { runsDir: root })).state).toBe('published');
  });

  it('keeps a newer archive authoritative without a publish', async () => {
    await artifact('launch', `launched ${job} fake-lane pid 123 base abc1234\n`, launch);
    await artifact('log', 'fake live work\n', live);
    await artifact('log.gz', gzipSync('fake archived work\n'), completed);
    expect((await getFleetJobDetail(job, { runsDir: root })).state).toBe('archived');
  });

  it('keeps an unrelated invalid source isolated from the current retry', async () => {
    await retry();
    await symlink(join(root, 'missing-fake-target'), join(root, `${job}.base`));
    const detail = await getFleetJobDetail(job, { runsDir: root });
    expect(detail.state).toBe('running');
    expect(detail.sources).toMatchObject({ base: 'degraded', launch: 'healthy', log: 'healthy' });
    expect(detail.log.tail).toContain('current fake work');
  });
});
