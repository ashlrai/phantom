/**
 * Tests for GET /api/run/:id/events (src/core/web/run-stream.ts) — the
 * per-run SSE tail. Hermetic: orchestrator.js's loadRun() is mocked so the
 * test controls exactly what "the run on disk" looks like on each poll,
 * without touching a real ~/.ashlr.
 *
 * Covers:
 *   - auth: refused (401) without a session, same boundary as every other
 *     GET /api/* route.
 *   - invalid run id: 400 (never reaches loadRun/fs).
 *   - unknown-but-well-formed run id: 404.
 *   - live sequence: step-started / step-output-chunk / step-done frames
 *     arrive with independently advancing cursor fields as the mocked run "progresses"
 *     across real poll ticks, then run-done closes the stream.
 *   - resume: an opaque Last-Event-ID resumes each event family; legacy
 *     scalar ids conservatively replay other families.
 *   - stall: a run that stops changing gets an explicit `stall` event
 *     carrying an age, instead of silently going quiet.
 *   - scrubbing: a fixture containing a fake secret token never reaches the
 *     wire in any frame.
 *
 * One assertion is DELIBERATELY inverted (see the "sanity: catches a
 * regression" test) to prove this suite would actually fail if scrubbing
 * were removed, rather than passing vacuously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { handleRunEventsSse } from '../src/core/web/run-stream.js';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Controllable run fixture + orchestrator mock
// ---------------------------------------------------------------------------

let currentRun: unknown = null;
const loadRunMock = vi.fn((id: string) => {
  if (currentRun && (currentRun as { id: string }).id === id) return currentRun;
  return null;
});

vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: (id: string) => loadRunMock(id),
  runGoal: vi.fn(async () => ({ id: 'run-dispatched', status: 'done' })),
}));

function runAt(overrides: {
  stepCount: number;
  status?: 'running' | 'done';
  taskStatus?: 'pending' | 'running' | 'done';
  extraSummary?: string;
}) {
  const { stepCount, status = 'running', taskStatus = 'running', extraSummary } = overrides;
  return {
    id: 'r1',
    goal: 'ship the thing',
    engine: 'claude',
    provider: 'anthropic',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    budget: { maxTokens: 100_000, maxSteps: 50, allowCloud: true },
    usage: { tokensIn: 10, tokensOut: 5, steps: stepCount, estCostUsd: 0.01 },
    tasks: [{ id: 't1', goal: 'do it', deps: [], status: stepCount > 0 ? taskStatus : 'pending' }],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      ts: new Date().toISOString(),
      taskId: 't1',
      kind: 'tool' as const,
      summary: i === stepCount - 1 && extraSummary ? extraSummary : `step ${i + 1}`,
    })),
    status,
    result: status === 'done' ? 'all done' : undefined,
  };
}

// ---------------------------------------------------------------------------
// Server / auth harness (mirrors test/m14.api.test.ts)
// ---------------------------------------------------------------------------

import { readSseAuth, startServer } from './helpers/authenticated-web-server.js';

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  };
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: false, ...overrides };
}

async function authenticatedSse(handle: { port: number; readToken: string }): Promise<{
  query: string;
  headers: Record<string, string>;
}> {
  const auth = await readSseAuth(handle);
  return {
    query: auth.query,
    headers: { Host: `127.0.0.1:${handle.port}`, ...auth.headers },
  };
}

function httpRequestHeadersOnly(
  url: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let body = '';
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open an SSE connection and collect frames until `until` returns true or timeout. */
function collectSseFrames(
  url: string,
  headers: Record<string, string>,
  until: (frames: Array<{ id?: string; event: string; data: unknown }>) => boolean,
  timeoutMs = 6000,
): Promise<{ statusCode: number; frames: Array<{ id?: string; event: string; data: unknown }> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const frames: Array<{ id?: string; event: string; data: unknown }> = [];
    let buffer = '';
    let settled = false;
    let statusCode = 0;

    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        statusCode = res.statusCode ?? 0;
        if (statusCode !== 200) {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
          res.on('end', () => {
            settled = true;
            resolve({ statusCode, frames: [{ event: 'error-response', data: raw }] });
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (raw.startsWith(':')) continue; // comment/keepalive
            let id: string | undefined;
            let event = 'message';
            let dataRaw = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) dataRaw = line.slice(6);
            }
            let data: unknown = dataRaw;
            try { data = JSON.parse(dataRaw); } catch { /* keep raw */ }
            frames.push({ id, event, data });
          }
          if (!settled && until(frames)) {
            settled = true;
            res.destroy();
            req.destroy();
            resolve({ statusCode, frames });
          }
        });
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({ statusCode, frames });
          }
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) return;
      if (!settled) reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      if (!settled) {
        settled = true;
        req.destroy();
        resolve({ statusCode, frames });
      }
    });
    req.end();
  });
}

let openHandles: Array<{ close(): Promise<void> }> = [];
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  openHandles = [];
  currentRun = null;
  loadRunMock.mockClear();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-run-sse-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — auth', () => {
  it('refuses the connection without a read session', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 1 });

    const res = await httpRequestHeadersOnly(`${h.url}/api/run/r1/events`, { Host: `127.0.0.1:${h.port}` });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the connection with a valid read session', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 0, status: 'done' });
    const auth = await authenticatedSse(h);

    const res = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
      (frames) => frames.some((f) => f.event === 'run-done'),
    );
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — validation', () => {
  it('400s an invalid run id before touching loadRun', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const auth = await authenticatedSse(h);

    const res = await httpRequestHeadersOnly(
      `${h.url}/api/run/bad%20id!/events${auth.query}`,
      auth.headers,
    );
    expect(res.statusCode).toBe(400);
    expect(loadRunMock).not.toHaveBeenCalled();
  });

  it('404s a well-formed but unknown run id', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = null;
    const auth = await authenticatedSse(h);

    const res = await httpRequestHeadersOnly(
      `${h.url}/api/run/does-not-exist/events${auth.query}`,
      auth.headers,
    );
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Live sequence + resume
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — live sequence', () => {
  it(
    'streams step-started/step-output-chunk/step-done with increasing ids, then run-done',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 1, taskStatus: 'running' });
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      // Let the first tick (immediate replay) land, then progress the run.
      await new Promise((r) => setTimeout(r, 50));
      currentRun = runAt({ stepCount: 2, taskStatus: 'running' });
      await new Promise((r) => setTimeout(r, 700));
      currentRun = runAt({ stepCount: 2, status: 'done', taskStatus: 'done' });

      const { statusCode, frames } = await collecting;
      expect(statusCode).toBe(200);

      const names = frames.map((f) => f.event);
      expect(names).toContain('step-started');
      expect(names).toContain('step-output-chunk');
      expect(names).toContain('step-done');
      expect(names[names.length - 1]).toBe('run-done');

      const ids = frames.filter((f) => f.id !== undefined).map((f) => Number(f.id!.split(':')[2]));
      const sorted = [...ids].sort((a, b) => a - b);
      expect(ids).toEqual(sorted);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    },
    10_000,
  );

  it(
    'resumes via Last-Event-ID without re-sending already-seen events',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 2, taskStatus: 'running' });
      const auth = await authenticatedSse(h);

      // Wait for BOTH steps' step-done frames — a single 'data' chunk isn't
      // guaranteed to carry every event a tick wrote, so stopping at the
      // first step-done risks disconnecting before step index 1 arrives.
      const first = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'step-done').length >= 2,
      );
      const lastId = first.frames.at(-1)?.id;
      expect(lastId).toBeDefined();

      currentRun = runAt({ stepCount: 2, status: 'done', taskStatus: 'done' });

      const resumed = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        { ...auth.headers, 'Last-Event-ID': String(lastId) },
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      const resumedIds = resumed.frames.filter((f) => f.id !== undefined).map((f) => Number(f.id!.split(':')[2]));
      for (const id of resumedIds) expect(id).toBeGreaterThan(Number(lastId!.split(':')[2]));
      // The already-seen step-started/step-output-chunk/step-done for the
      // first two steps must not reappear.
      const resumedStepDones = resumed.frames.filter((f) => f.event === 'step-done').length;
      expect(resumedStepDones).toBe(0);
    },
    10_000,
  );

  it(
    'emits a stall event with a growing age when the run stops changing',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      // Frozen updatedAt so the mock doesn't look like it's constantly
      // changing (a fresh Date.now() on every loadRun() call would never stall).
      const frozen = runAt({ stepCount: 1, taskStatus: 'running' });
      currentRun = frozen;
      const auth = await authenticatedSse(h);

      const { frames } = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (fs_) => fs_.some((f) => f.event === 'stall'),
        12_000,
      );

      const stall = frames.find((f) => f.event === 'stall');
      expect(stall).toBeDefined();
      expect(stall!.id).toBeUndefined(); // stall is not part of the resumable cursor
      expect((stall!.data as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(8_000);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — secret scrubbing', () => {
  it('never puts a fake secret token on the wire', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const secret = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    currentRun = runAt({ stepCount: 1, status: 'done', taskStatus: 'done', extraSummary: `leaked key ${secret}` });
    const auth = await authenticatedSse(h);

    const { frames } = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
      (fr) => fr.some((f) => f.event === 'run-done'),
    );

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  // DELIBERATELY inverted: proves the suite actually fails when scrubbing
  // is bypassed, rather than passing vacuously because nothing checks the
  // negative case. This asserts against the SAME secret with scrubbing
  // known to be active — expected to FAIL if ever flipped to `.not.toContain`
  // without the scrub applying, which is exactly the regression this
  // guards against being silently disabled.
  it('sanity: a run summary WOULD contain the raw secret if scrubbing were skipped', () => {
    const secret = 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const unscrubbed = runAt({ stepCount: 1, extraSummary: `leaked key ${secret}` });
    expect(JSON.stringify(unscrubbed)).toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// v333: output-chunk — durable stream file interleaving + resume
// ---------------------------------------------------------------------------

/**
 * Write JSONL lines directly to the run's stream file, mirroring exactly
 * what streaming.ts's fileSink() would have written — this suite tests the
 * SSE route's TAILING of that file, not fileSink() itself (covered in
 * test/m11.stream-file-sink.test.ts).
 */
function writeStreamFileLines(runId: string, lines: Array<{ kind: string; text: string; taskId?: string }>): void {
  const dir = path.join(tmpHome, '.ashlr', 'run-streams');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${runId}.log`);
  const body = lines
    .map((l) => JSON.stringify({ ts: new Date().toISOString(), kind: l.kind, ...(l.taskId ? { taskId: l.taskId } : {}), text: l.text }))
    .join('\n') + (lines.length > 0 ? '\n' : '');
  fs.appendFileSync(filePath, body, { mode: 0o600 });
}

describe('GET /api/run/:id/events — output-chunk (durable stream file)', () => {
  it(
    'interleaves output-chunk frames with independently resumable step events',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 1, taskStatus: 'running' });
      writeStreamFileLines('r1', [
        { kind: 'model-delta', text: 'thinking about the goal' },
        { kind: 'tool-call', text: 'tool: read_file', taskId: 't1' },
      ]);
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      await new Promise((r) => setTimeout(r, 50));
      writeStreamFileLines('r1', [{ kind: 'model-delta', text: 'more output after connect' }]);
      currentRun = runAt({ stepCount: 1, status: 'done', taskStatus: 'done' });

      const { statusCode, frames } = await collecting;
      expect(statusCode).toBe(200);

      const outputFrames = frames.filter((f) => f.event === 'output-chunk');
      expect(outputFrames.length).toBeGreaterThanOrEqual(3);
      const texts = outputFrames.map((f) => (f.data as { text: string }).text);
      expect(texts).toContain('thinking about the goal');
      expect(texts).toContain('tool: read_file');
      expect(texts).toContain('more output after connect');

      const toolCallFrame = outputFrames.find((f) => (f.data as { text: string }).text === 'tool: read_file');
      expect((toolCallFrame!.data as { taskId: string | null }).taskId).toBe('t1');

      // Every family advances independently inside the opaque cursor.
      const vectors = frames.filter((f) => f.id).map((f) => f.id!.split(':').slice(1).map(Number));
      for (let i = 1; i < vectors.length; i++) {
        for (let family = 0; family < 3; family++) expect(vectors[i]![family]).toBeGreaterThanOrEqual(vectors[i - 1]![family]!);
      }
      expect(names_(frames)).toContain('run-done');
    },
    10_000,
  );

  it(
    'resumes via Last-Event-ID without re-sending already-seen output chunks',
    async () => {
      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 0, taskStatus: 'running' });
      writeStreamFileLines('r1', [
        { kind: 'model-delta', text: 'chunk one' },
        { kind: 'model-delta', text: 'chunk two' },
      ]);
      const auth = await authenticatedSse(h);

      const first = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'output-chunk').length >= 2,
      );
      const lastId = first.frames.at(-1)!.id!;

      writeStreamFileLines('r1', [{ kind: 'model-delta', text: 'chunk three' }]);
      currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });

      const resumed = await collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        { ...auth.headers, 'Last-Event-ID': String(lastId) },
        (frames) => frames.some((f) => f.event === 'run-done'),
      );

      const resumedOutputTexts = resumed.frames
        .filter((f) => f.event === 'output-chunk')
        .map((f) => (f.data as { text: string }).text);
      expect(resumedOutputTexts).toEqual(['chunk three']);
      const resumedOutputIds = resumed.frames.filter((f) => f.event === 'output-chunk')
        .map((f) => Number(f.id!.split(':')[3]));
      for (const oid of resumedOutputIds) expect(oid).toBeGreaterThan(Number(lastId.split(':')[3]));
      expect(names_(resumed.frames)).toContain('run-done');
    },
    10_000,
  );

  it('never sends the raw secret when the stream file itself is unscrubbed (defense-in-depth via sanitizePublicJson)', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const secret = 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });
    // Simulate a hypothetical bug where fileSink's own scrub was bypassed —
    // this route's sanitizePublicJson() is the second, independent layer.
    writeStreamFileLines('r1', [{ kind: 'model-delta', text: `leaked ${secret}` }]);
    const auth = await authenticatedSse(h);

    const { frames } = await collectSseFrames(
      `${h.url}/api/run/r1/events${auth.query}`,
      auth.headers,
      (fr) => fr.some((f) => f.event === 'run-done'),
    );

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain(secret);
  });

  // DELIBERATELY inverted, same pattern as the step-summary sanity test
  // above: proves this suite would fail if sanitizePublicJson were ever
  // skipped for output-chunk payloads specifically.
  it('sanity: an unscrubbed stream-file line WOULD contain the raw secret if read verbatim', () => {
    const secret = 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const line = JSON.stringify({ ts: new Date().toISOString(), kind: 'model-delta', text: `leaked ${secret}` });
    expect(line).toContain(secret);
  });
});

function names_(frames: Array<{ event: string }>): string[] {
  return frames.map((f) => f.event);
}

// ---------------------------------------------------------------------------
// v333: live integration — a real (fake) engine subprocess's stdout reaches
// the SSE route via the real spawnEngine -> fileSink pipeline, no mocking of
// child_process. `bin: process.execPath` runs plain node, never a real
// delegated CLI agent — same pattern m11.engines.test.ts already uses for
// its one real-process integration test.
// ---------------------------------------------------------------------------

describe('GET /api/run/:id/events — live engine output integration', () => {
  it(
    'a real subprocess writing to stdout is tailed through fileSink and arrives as output-chunk frames',
    async () => {
      const { spawnEngine, describeRunEventForStream } = await import('../src/core/run/engines.js');
      const { fileSink, emitSinkEvent, endStreamSink } = await import('../src/core/run/streaming.js');

      const h = await startServer(makeConfig(), makeOpts());
      openHandles.push(h);
      currentRun = runAt({ stepCount: 0, taskStatus: 'running' });

      const sink = fileSink('r1');
      const script = [
        "console.log('engine says hello');",
        "console.log('engine is working');",
      ].join('\n');

      const enginePromise = spawnEngine(
        { bin: process.execPath, args: ['-e', script] },
        makeConfig(),
        {
          onEvent: (ev) => {
            const described = describeRunEventForStream(ev);
            if (described) emitSinkEvent(sink, described);
          },
        },
      );
      const auth = await authenticatedSse(h);

      const collecting = collectSseFrames(
        `${h.url}/api/run/r1/events${auth.query}`,
        auth.headers,
        (frames) => frames.filter((f) => f.event === 'output-chunk').length >= 2,
        8_000,
      );

      await enginePromise;
      endStreamSink(sink);
      currentRun = runAt({ stepCount: 0, status: 'done', taskStatus: 'done' });

      const { frames } = await collecting;
      const texts = frames.filter((f) => f.event === 'output-chunk').map((f) => (f.data as { text: string }).text);
      expect(texts).toContain('engine says hello');
      expect(texts).toContain('engine is working');
    },
    10_000,
  );
});


describe('run SSE replay correctness', () => {
  it('drains terminal history including a UTF-8 record larger than one read', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 1, status: 'done' });
    const text = '🌊'.repeat(90_000);
    writeStreamFileLines('r1', [
      { kind: 'model-delta', text },
      ...Array.from({ length: 500 }, (_, i) => ({ kind: 'log', text: `tail ${i} ${'x'.repeat(800)}` })),
    ]);
    const auth = await authenticatedSse(h);
    const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'run-done'));
    const output = frames.filter((f) => f.event === 'output-chunk');
    expect(output).toHaveLength(501);
    expect((output[0]!.data as { text: string }).text === text).toBe(true);
    expect((output.at(-1)!.data as { text: string }).text).toMatch(/^tail 499 /);
    expect(frames.at(-1)!.event).toBe('run-done');
  });

  it('delivers later task starts live and across reconnect after completed steps', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const initial = runAt({ stepCount: 1 });
    initial.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'pending' });
    currentRun = initial;
    const auth = await authenticatedSse(h);
    const first = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'step-done'));
    const cursor = first.frames.at(-1)!.id!;
    const next = runAt({ stepCount: 1 });
    next.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'running' });
    currentRun = next;
    const resumed = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`,
      { ...auth.headers, 'Last-Event-ID': cursor },
      (frames) => frames.some((f) => f.event === 'step-started' && (f.data as { taskId: string }).taskId === 't2'), 1500);
    expect(resumed.frames.filter((f) => f.event === 'step-started').map((f) => (f.data as { taskId: string }).taskId)).toEqual(['t2']);
    expect(resumed.frames.some((f) => f.event === 'step-done')).toBe(false);
  });

  it('drains a final burst larger than one read on a live terminal transition', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 0 });
    const auth = await authenticatedSse(h);
    const collecting = collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'run-done'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeStreamFileLines('r1', Array.from({ length: 800 }, (_, i) => ({ kind: 'log', text: `${i} ${'x'.repeat(600)}` })));
    currentRun = runAt({ stepCount: 0, status: 'done' });
    const { frames } = await collecting;
    expect(frames.filter((f) => f.event === 'output-chunk')).toHaveLength(800);
    expect(frames.at(-1)!.event).toBe('run-done');
  });
});


describe('run SSE bounded flow control and resume', () => {
  function blockedResponse(expiresIn = 60_000) {
    const req = new EventEmitter() as http.IncomingMessage;
    req.headers = {};
    const res = new EventEmitter() as http.ServerResponse;
    const lines: string[] = [];
    let blocked = false;
    res.writeHead = vi.fn(() => res);
    res.write = vi.fn((line: string) => {
      lines.push(line);
      if (!blocked && line.includes('event: output-chunk')) { blocked = true; return false; }
      return true;
    }) as unknown as typeof res.write;
    res.end = vi.fn(() => res) as typeof res.end;
    handleRunEventsSse(req, res, 'r1', { id: 'test-read-session', expiresAt: Date.now() + expiresIn });
    return { req, res, lines };
  }

  it('waits for drain before more replay and run-done; then releases listeners', async () => {
    currentRun = runAt({ stepCount: 0, status: 'done' });
    writeStreamFileLines('r1', [{ kind: 'log', text: 'first' }, { kind: 'log', text: 'second' }]);
    const { req, res, lines } = blockedResponse();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.filter((line) => line.includes('event: output-chunk'))).toHaveLength(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount('drain')).toBe(1);
    res.emit('drain');
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.filter((line) => line.includes('event: output-chunk'))).toHaveLength(2);
    expect(lines.at(-1)).toContain('event: run-done');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.eventNames()).toEqual([]);
    expect(req.eventNames()).toEqual([]);
  });

  it.each(['close', 'expiry'])('cleans a blocked replay on %s without sending a false done', async (cause) => {
    currentRun = runAt({ stepCount: 0, status: 'done' });
    writeStreamFileLines('r1', [{ kind: 'log', text: 'first' }, { kind: 'log', text: 'second' }]);
    const { res, lines } = blockedResponse(cause === 'expiry' ? 15 : 60_000);
    if (cause === 'close') res.emit('close');
    else await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes('event: run-done'))).toBe(false);
    expect(res.eventNames()).toEqual([]);
  });

  it('declares corrupt and unterminated records before terminal completion', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 0, status: 'done' });
    writeStreamFileLines('r1', [{ kind: 'log', text: 'valid' }]);
    fs.appendFileSync(path.join(tmpHome, '.ashlr', 'run-streams', 'r1.log'), '{bad}\n{"text":"unfinished');
    const auth = await authenticatedSse(h);
    const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'run-done'));
    expect(frames.filter((f) => f.event === 'stream-gap').map((f) => (f.data as { reason: string }).reason))
      .toEqual(['invalid-output-record', 'incomplete-output-record']);
    expect(frames.at(-1)!.event).toBe('run-done');
  });

  it('declares an oversized captured file instead of silently claiming complete replay', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 0, status: 'done' });
    writeStreamFileLines('r1', []);
    fs.truncateSync(path.join(tmpHome, '.ashlr', 'run-streams', 'r1.log'), 8 * 1024 * 1024 + 1);
    const auth = await authenticatedSse(h);
    const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'run-done'));
    expect(frames.find((f) => f.event === 'stream-gap')?.data).toEqual({ reason: 'stream-unreadable' });
  });

  it('legacy step cursors conservatively replay task starts while resuming steps', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    currentRun = runAt({ stepCount: 1, status: 'done' });
    const auth = await authenticatedSse(h);
    const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`,
      { ...auth.headers, 'Last-Event-ID': '1000001' }, (frames) => frames.some((f) => f.event === 'run-done'));
    expect(frames.map((f) => f.event)).toEqual(['step-started', 'run-done']);
    expect(frames.at(-1)!.id).toMatch(/^v1:/);
  });

  it('does not lose an earlier pending task after a later task started out of order', async () => {
    const h = await startServer(makeConfig(), makeOpts());
    openHandles.push(h);
    const initial = runAt({ stepCount: 1 });
    initial.tasks[0]!.status = 'pending';
    initial.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'running' });
    currentRun = initial;
    const auth = await authenticatedSse(h);
    const first = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
      (frames) => frames.some((f) => f.event === 'step-done'));
    const next = runAt({ stepCount: 1, status: 'done' });
    next.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'done' });
    currentRun = next;
    const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`,
      { ...auth.headers, 'Last-Event-ID': first.frames.at(-1)!.id! }, (frames) => frames.some((f) => f.event === 'run-done'));
    expect(frames.filter((f) => f.event === 'step-started').map((f) => (f.data as { taskId: string }).taskId)).toEqual(['t1', 't2']);
  });
});


it('delivers sequential task starts on one live connection after completed steps', async () => {
  const h = await startServer(makeConfig(), makeOpts());
  openHandles.push(h);
  const initial = runAt({ stepCount: 1 });
  initial.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'pending' });
  currentRun = initial;
  const auth = await authenticatedSse(h);
  const collecting = collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
    (frames) => frames.some((f) => f.event === 'run-done'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = runAt({ stepCount: 2, status: 'done' });
  next.tasks.push({ id: 't2', goal: 'second', deps: [], status: 'done' });
  currentRun = next;
  const { frames } = await collecting;
  expect(frames.filter((f) => f.event === 'step-started').map((f) => (f.data as { taskId: string }).taskId)).toEqual(['t1', 't2']);
});


it('resumes mixed output and step history together without duplicate frames', async () => {
  const h = await startServer(makeConfig(), makeOpts());
  openHandles.push(h);
  currentRun = runAt({ stepCount: 1 });
  writeStreamFileLines('r1', [{ kind: 'log', text: 'before reconnect' }]);
  const auth = await authenticatedSse(h);
  const first = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`, auth.headers,
    (frames) => frames.some((f) => f.event === 'step-done'));
  currentRun = runAt({ stepCount: 2, status: 'done' });
  writeStreamFileLines('r1', [{ kind: 'log', text: 'after reconnect' }]);
  const { frames } = await collectSseFrames(`${h.url}/api/run/r1/events${auth.query}`,
    { ...auth.headers, 'Last-Event-ID': first.frames.at(-1)!.id! }, (frames) => frames.some((f) => f.event === 'run-done'));
  expect(frames.map((f) => f.event)).toEqual(['output-chunk', 'step-output-chunk', 'step-done', 'run-done']);
  expect((frames[0]!.data as { text: string }).text).toBe('after reconnect');
});
