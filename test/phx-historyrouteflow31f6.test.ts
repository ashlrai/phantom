import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  appendRunsSample,
  readRunsHistory,
  sampleIfDue,
  type RunsHistory,
  type RunsSample,
} from '../src/core/fleet/runs-history.js';
import { createRunsHistoryApi, VERSE_RUNS_HISTORY_PATH } from '../src/core/verse/runs-history-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const now = () => NOW;
const fixture = (at: string, running: number): RunsSample => ({
  at,
  lanes: [{ lane: 'fake-lane', running, target: 4, queued: 2, held: false }],
  workers: 3,
  leaders: 1,
  paused: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function request(handler: ReturnType<typeof createRunsHistoryApi>, hours: number) {
  const req = { url: `${VERSE_RUNS_HISTORY_PATH}?hours=${hours}` } as IncomingMessage;
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk: string) { body = chunk; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fake-token', allowDispatch: false } as VerseApiContext;
  const handled = await handler(ctx, req, res, VERSE_RUNS_HISTORY_PATH, 'GET');
  return { handled, status, history: JSON.parse(body) as RunsHistory };
}

it('serves stored runs through a failed launch sample and shares the recovered sample', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fake-runs-history-route-'));
  try {
    const file = join(root, 'fleet', 'runs-history.jsonl');
    const older = fixture('2026-10-30T00:00:00.000Z', 1); // 36 hours old
    const recent = fixture('2026-10-31T10:00:00.000Z', 2); // 2 hours old
    const recovered = fixture('2026-10-31T12:00:00.000Z', 3);
    await appendRunsSample(older, { file, now });
    await appendRunsSample(recent, { file, now });

    const started = deferred<void>();
    const release = deferred<RunsSample>();
    const collect = vi.fn()
      .mockRejectedValueOnce(new Error('fake sampling failure'))
      .mockImplementationOnce(() => { started.resolve(); return release.promise; });
    const sample = vi.fn(() => sampleIfDue({ file, now, read: collect }));
    const readHistory = vi.fn((hours: number) => readRunsHistory({ file, now, hours }));
    const handler = createRunsHistoryApi({ sample, readHistory });

    const failed = await request(handler, 48);
    expect(failed).toEqual({
      handled: true, status: 200,
      history: {
        v: 1, generatedAt: '2026-10-31T12:00:00.000Z',
        from: '2026-10-29T12:00:00.000Z', to: '2026-10-31T12:00:00.000Z',
        sourceState: 'healthy', dropped: 0, samples: [older, recent],
      },
    });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(readHistory).toHaveBeenNthCalledWith(1, 48);

    const first = request(handler, 48);
    await started.promise;
    const second = request(handler, 1);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
    release.resolve(recovered);
    const [wide, narrow] = await Promise.all([first, second]);
    expect(wide.handled).toBe(true);
    expect(wide.status).toBe(200);
    expect(wide.history).toMatchObject({
      from: '2026-10-29T12:00:00.000Z', sourceState: 'healthy', dropped: 0,
      samples: [older, recent, recovered],
    });
    expect(narrow.handled).toBe(true);
    expect(narrow.status).toBe(200);
    expect(narrow.history).toMatchObject({
      from: '2026-10-31T11:00:00.000Z', sourceState: 'healthy', dropped: 0,
      samples: [recovered],
    });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(readHistory.mock.calls.map(([hours]) => hours)).toEqual([48, 48, 1]);
    expect((await readRunsHistory({ file, now, hours: 48 })).samples).toEqual([older, recent, recovered]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
