import { describe, expect, it, vi } from 'vitest';
import { runPostWorkerEvidence, type PostWorkerEvidenceDependencies } from '../examples/agents/post-worker-evidence.js';
import { validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import type { FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';
import type { FleetJobChangesV1 } from '../src/core/fleet/runs-job-changes.js';

const args = ['--job', 'JOB-FAKE', '--to', 'fake-to', '--from', 'fake-from', '--id', 'fake-id', '--ttl-ms', '60000'];
const detail: FleetJobDetailV1 = {
  schema: 'fleet.job.v1', generatedAt: '2026-01-01T00:00:00.000Z', job: 'JOB-FAKE', state: 'published',
  lane: 'fake', tier: 'fake', model: 'fake', pid: 1, launchedAt: null, baseSha: 'fake-sha', branch: 'fake-private-branch', promptBytes: 123,
  publish: { prUrl: 'https://github.com/example/project/pull/42', autoMerge: true, testLine: 'fake-private-prompt', sensitive: ['fake-private-path'] },
  notes: { hasNotes: true, hasBody: true, notesBytes: 20 },
  log: { source: 'archived', bytes: 30, tail: ['fake-private-log'], truncated: false },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' },
};
const changes: FleetJobChangesV1 = {
  schema: 'fleet.job.changes.v1', generatedAt: '2026-01-01T00:00:00.000Z', job: 'JOB-FAKE', state: 'live', baseSha: 'fake-sha',
  files: [{ path: 'fake-private-path', status: 'modified', added: 4, removed: 2 }], totals: { files: 1, added: 4, removed: 2 }, truncated: false,
};

function harness(overrides: PostWorkerEvidenceDependencies = {}) {
  const output: string[] = [];
  const append = vi.fn<NonNullable<PostWorkerEvidenceDependencies['append']>>(() => ({ status: 'posted', id: 'fake-id', cursor: 7 }));
  const deps: PostWorkerEvidenceDependencies = {
    readDetail: async () => detail, readChanges: async () => changes, append,
    now: () => 100, write: text => output.push(text), ...overrides,
  };
  return { append, output, run: async (input = args) => {
    const code = await runPostWorkerEvidence(input, deps);
    return { code, result: JSON.parse(output.at(-1)!) };
  } };
}

describe('post worker evidence', () => {
  it('posts a validated compact association and returns the durable cursor', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ code: 0, result: { status: 'posted', id: 'fake-id', cursor: 7 } });
    expect(h.append).toHaveBeenCalledOnce();
    const [envelope, options] = h.append.mock.calls[0]!;
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(options?.now?.()).toBe(100);
    expect(envelope).toMatchObject({ body: { schema: 'fleet.job.evidence.v1', jobId: 'JOB-FAKE', state: 'published', prUrl: 'https://github.com/example/project/pull/42', sources: detail.sources, changes: { state: 'live', totals: { files: 1, added: 4, removed: 2 } } } });
    const sent = JSON.stringify(envelope);
    for (const value of ['fake-private-log', 'fake-private-prompt', 'fake-private-path', 'fake-private-branch', 'fake-sha']) expect(sent).not.toContain(value);
  });

  it('keeps missing, degraded, truncated and failed changes unknown', async () => {
    for (const readChanges of [
      async () => ({ ...changes, state: 'missing' as const }),
      async () => ({ ...changes, state: 'degraded' as const }),
      async () => ({ ...changes, truncated: true }),
      async (): Promise<FleetJobChangesV1> => { throw new Error('fake-private-error'); },
    ]) {
      const h = harness({ readChanges });
      expect((await h.run()).code).toBe(0);
      expect(h.append.mock.calls[0]![0]).toMatchObject({ body: { changes: { totals: null } } });
    }
  });

  it('validates before reads and again before append; does not forward unsafe URLs', async () => {
    const readDetail = vi.fn(async () => detail);
    const h = harness({ readDetail });
    expect((await h.run(args.map(value => value === 'fake-to' ? 'bad address' : value))).code).toBe(2);
    expect(readDetail).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    const invalidBody = harness({ readDetail: async () => ({ ...detail, sources: { ...detail.sources, log: undefined } } as unknown as FleetJobDetailV1) });
    expect((await invalidBody.run()).code).toBe(2);
    expect(invalidBody.append).not.toHaveBeenCalled();
    const unsafe = harness({ readDetail: async () => ({ ...detail, publish: { ...detail.publish!, prUrl: 'https://github.com/example/project/pull/42?fake-private-prompt' } }) });
    await unsafe.run();
    expect(unsafe.append.mock.calls[0]![0]).toMatchObject({ body: { prUrl: null } });
  });

  it('hands repeated IDs to transport for duplicate or conflict decisions', async () => {
    let saved: string | undefined;
    const append = vi.fn<NonNullable<PostWorkerEvidenceDependencies['append']>>((input) => {
      const checked = validateBusEnvelope(input);
      if (!checked.ok) return { status: 'invalid' };
      if (saved === undefined) { saved = checked.json; return { status: 'posted', id: checked.value.id, cursor: 1 }; }
      return saved === checked.json ? { status: 'duplicate', id: checked.value.id, cursor: 1 } : { status: 'conflict' };
    });
    const h = harness({ append });
    expect((await h.run()).result.status).toBe('posted');
    expect((await h.run()).result.status).toBe('duplicate');
    expect(await h.run(args.map(v => v === '60000' ? '60001' : v))).toEqual({ code: 5, result: { status: 'conflict' } });
    expect(append).toHaveBeenCalledTimes(3);
  });

  it('distinguishes full, retryable and other failures without another append', async () => {
    for (const [status, code] of [['full', 4], ['retryable', 3], ['conflict', 5], ['unavailable', 1]] as const) {
      const append = vi.fn<NonNullable<PostWorkerEvidenceDependencies['append']>>(() => ({ status }));
      const h = harness({ append });
      expect(await h.run()).toEqual({ code, result: { status } });
      expect(append).toHaveBeenCalledOnce();
    }
  });

  it('bounds reads and handles interruption before posting', async () => {
    const never = () => new Promise<FleetJobDetailV1>(() => {});
    const timed = harness({ readDetail: never, wait: async () => {} });
    expect(await timed.run()).toEqual({ code: 1, result: { error: 'evidence-unavailable' } });
    expect(timed.append).not.toHaveBeenCalled();
    const controller = new AbortController();
    const interrupted = harness({ readDetail: never, signal: controller.signal, wait: async (_ms, signal) => {
      controller.abort();
      if (signal.aborted) throw new Error('aborted');
    } });
    expect(await interrupted.run()).toEqual({ code: 130, result: { error: 'interrupted' } });
    expect(interrupted.append).not.toHaveBeenCalled();
  });

  it('rejects mismatched jobs, malformed options and reader failures without posting', async () => {
    const h = harness();
    for (const input of [[], [...args, '--job', 'JOB-OTHER'], args.slice(0, -1), args.map(v => v === 'JOB-FAKE' ? '../bad' : v), args.map(v => v === '60000' ? '0' : v), args.map(v => v === '60000' ? '2592000001' : v)]) {
      expect((await h.run(input)).code).toBe(2);
    }
    expect(h.append).not.toHaveBeenCalled();
    const mismatch = harness({ readChanges: async () => ({ ...changes, job: 'JOB-OTHER' }) });
    expect((await mismatch.run()).result.error).toBe('job-mismatch');
    expect(mismatch.append).not.toHaveBeenCalled();
    const failure = harness({ readDetail: async () => { throw new Error('fake-private-error'); } });
    expect(await failure.run()).toEqual({ code: 1, result: { error: 'evidence-unavailable' } });
    expect(failure.append).not.toHaveBeenCalled();
  });
});
