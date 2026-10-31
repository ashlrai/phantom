/** Upgrade contract: a job method may exist only when its exact route is remote-allowed. */
import { describe, expect, it } from 'vitest';
import type { FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import type { FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';
import { createRemoteFleetFeed } from '../src/core/web/remote-fleet-feed.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

const detail: FleetJobDetailV1 = {
  schema: 'fleet.job.v1', generatedAt: '2026-01-01T00:00:00.000Z', job: 'job-123',
  state: 'unknown', lane: null, tier: null, model: null, pid: null, launchedAt: null,
  baseSha: null, branch: null, promptBytes: null, publish: null,
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'missing', bytes: null, tail: [], truncated: false },
  sources: { launch: 'missing', base: 'degraded', meta: 'healthy', publish: 'missing', log: 'degraded' },
};
const changes: FleetJobChangesV1 = {
  schema: 'fleet.job.changes.v1', generatedAt: '2026-01-01T00:00:00.000Z', job: 'job-123',
  state: 'degraded', baseSha: null, comparisonBase: 'HEAD', files: [],
  totals: { files: 0, added: 0, removed: 0 }, truncated: true,
};

type JobMethod = (id: string) => Promise<FleetJobDetailV1 | FleetJobChangesV1>;
type UpgradeMethods = { job?: JobMethod; jobChanges?: JobMethod };
const routes = [
  { name: 'job', path: '/api/fleet/job', response: detail },
  { name: 'jobChanges', path: '/api/fleet/job/changes', response: changes },
] as const;

function fixture(response: FleetJobDetailV1 | FleetJobChangesV1, failure?: Error) {
  const calls: unknown[][] = [];
  const feed = createRemoteFleetFeed({
    async get<T>(...args: [string]): Promise<T> {
      calls.push(args);
      if (failure) throw failure;
      return response as T;
    },
    async mutate<T>(): Promise<T> { throw new Error('unexpected mutation'); },
  }) as ReturnType<typeof createRemoteFleetFeed> & UpgradeMethods;
  return { feed, calls };
}

describe.each(routes)('remote fleet $name upgrade contract', ({ name, path, response }) => {
  const target = (id: string) => `${path}?id=${encodeURIComponent(id)}`;

  function allowedMethod(feed: UpgradeMethods): JobMethod | undefined {
    const decision = classifyRemoteRoute('GET', target('job-123'));
    expect(['read', 'deny']).toContain(decision.kind);
    if (decision.kind === 'deny') {
      expect(feed[name]).toBeUndefined();
      return undefined;
    }
    expect(feed[name]).toEqual(expect.any(Function));
    return feed[name];
  }

  it('uses the exact allowed route and preserves the projection and source health', async () => {
    const { feed, calls } = fixture(response);
    const read = allowedMethod(feed);
    if (!read) return;
    for (const id of ['job-123', 'A._-9', 'x'.repeat(80)]) {
      expect(classifyRemoteRoute('GET', target(id)).kind).toBe('read');
      expect(await read(id)).toBe(response);
    }
    // A GET receives only the URL: no credentials, headers, device IDs or bodies.
    expect(calls).toEqual(['job-123', 'A._-9', 'x'.repeat(80)].map((id) => [target(id)]));
  });

  it('rejects invalid IDs before contacting the transport', async () => {
    const { feed, calls } = fixture(response);
    const read = allowedMethod(feed);
    if (!read) return;
    for (const id of ['', 'ab', '-abc', '.abc', 'a/b', '../abc', 'abc?x=1', 'abc&x=1',
      'abc\n', 'abc\r\n', 'abc\0', 'éabc', 'x'.repeat(81), null, undefined, 123]) {
      await expect(Promise.resolve().then(() => read(id as string))).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('propagates transport failures without retry or mutation', async () => {
    const failure = new Error('fake transport failure');
    const { feed, calls } = fixture(response, failure);
    const read = allowedMethod(feed);
    if (!read) return;
    await expect(read('job-123')).rejects.toBe(failure);
    expect(calls).toEqual([[target('job-123')]]);
  });
});
