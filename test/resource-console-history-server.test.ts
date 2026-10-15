/** Real scoped HTTP, durable supervisor and loopback-only completion fixture. */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput } from '../src/core/resources/console-types.js';
import { startResourceConsoleServer, type ResourceConsoleServerHandle, type ResourceConsoleServerOptions } from '../src/core/web/resource-console-server.js';

let directory: string;
const handles: ResourceConsoleServerHandle[] = [];
const endpoints: Array<ReturnType<typeof createServer>> = [];
beforeEach(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-history-http-'))); });
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const endpoint of endpoints.splice(0)) {
    endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const historyPath = (id = 'task-a') => `/api/resources/tasks/${id}/history`;
const readHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.readToken });
const controlHeaders = (handle: ResourceConsoleServerHandle) => ({ 'x-ashlr-token': handle.controlToken!, origin: handle.url });
function http(handle: ResourceConsoleServerHandle, path: string, options: {
  method?: string; headers?: Record<string, string>; body?: unknown;
} = {}): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({ hostname: '127.0.0.1', port: handle.port, path, method: options.method ?? 'GET', agent: false,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...options.headers } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new Error('Fixture response exceeds bound')); else chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!,
        text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    req.on('error', reject); req.setTimeout(12_000, () => req.destroy(new Error('Fixture HTTP timeout'))); req.end(body);
  });
}


// Failure-only observation: these bounds do not extend the held assertion deadline.
const DIAGNOSTIC_MS = 250;
const DIAGNOSTIC_BYTES = 32_768;
const DIAGNOSTIC_PREFIX = '[history-dispatch-diagnostic-v1] ';
type DiagnosticCode = 'observed' | 'deadline' | 'http-refused' | 'body-overflow' | 'parse-refused' | 'unavailable' | 'malformed-snapshot';
type DiagnosticRead = { code: DiagnosticCode; snapshot?: unknown };
type DiagnosticRequest = (options: RequestOptions, response: (value: IncomingMessage) => void) => ClientRequest;
function readDispatchDiagnostic(handle: ResourceConsoleServerHandle, factory: DiagnosticRequest = request): Promise<DiagnosticRead> {
  return new Promise((resolve) => {
    let settled = false; let req: ClientRequest | undefined; let res: IncomingMessage | undefined;
    let bytes = 0; const chunks: Buffer[] = [];
    const destroy = (value: ClientRequest | IncomingMessage | undefined) => { try { value?.destroy(); } catch { /* Diagnostic cleanup cannot replace the assertion. */ } };
    const finish = (result: DiagnosticRead, cancel = true) => {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks.length = 0; resolve(result);
      // Settle before destroy: a mock or native stream can synchronously emit late events.
      if (cancel) { destroy(req); destroy(res); }
    };
    const timer = setTimeout(() => finish({ code: 'deadline' }), DIAGNOSTIC_MS);
    try {
      req = factory({ hostname: '127.0.0.1', port: handle.port, path: '/api/resources', method: 'GET',
        agent: false, headers: readHeaders(handle) }, (response) => {
        // Keep an error consumer even for a response arriving after cancellation.
        response.on('error', () => finish({ code: 'unavailable' }));
        if (settled) { destroy(response); return; }
        res = response;
        response.on('aborted', () => finish({ code: 'unavailable' }));
        response.on('close', () => finish({ code: 'unavailable' }));
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { finish({ code: 'unavailable' }); return; }
          if (chunk.length > DIAGNOSTIC_BYTES - bytes) { finish({ code: 'body-overflow' }); return; }
          bytes += chunk.length; chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          try { finish({ code: 'observed', snapshot: JSON.parse(Buffer.concat(chunks).toString('utf8')) }, false); }
          catch { finish({ code: 'parse-refused' }); }
        });
        if (response.statusCode !== 200) finish({ code: 'http-refused' });
      });
      req.on('error', () => finish({ code: 'unavailable' }));
      req.on('close', () => finish({ code: 'unavailable' }));
      if (settled) destroy(req); else req.end();
    } catch { finish({ code: 'unavailable' }); }
  });
}
const DIAGNOSTIC_REASONS = new Set([
  'dispatch-requested', 'no-eligible-capacity', 'host-execution-stopped', 'project-not-enabled',
  'project-directory-unavailable', 'pool-evolution-reenrollment-required', 'task-identity-conflict',
  'dispatch-settlement-unavailable', 'settlement-unavailable', 'existing-receipt-unresolved',
  'previous-dispatch-unresolved', 'queued-task-cancelled', 'cancellation-requested', 'task-reserved',
  'worker-completed', 'worker-transport-failed', 'worker-cancelled', 'worker-timed-out',
  'worker-invalid-configuration', 'worker-tool-calls-not-allowed', 'worker-output-token-limit',
  'worker-output-missing', 'worker-dispatch-precondition-failed',
]);
const DIAGNOSTIC_ERRORS = new Set([
  'supervisor-ownership-lost', 'supervisor-commissioning-custody-unavailable', 'supervisor-persistence-unavailable',
  'supervisor-settlement-unavailable', 'supervisor-admission-constraint-unavailable', 'supervisor-observations-unavailable',
  'supervisor-evidence-unavailable', 'supervisor-termination-unconfirmed', 'supervisor-release-uncertain',
]);
const DIAGNOSTIC_STATES = new Set(['queued', 'dispatching', 'settled', 'cancelled', 'unresolved']);
const DIAGNOSTIC_OUTCOMES = new Set(['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain']);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ownData = (value: Record<string, unknown>, key: string): unknown => {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field?.enumerable && 'value' in field ? field.value : undefined;
};
const count = (value: unknown, max: number): number | null => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const closed = (value: unknown, vocabulary: ReadonlySet<string>, nullable = true): string => value === null && nullable
  ? 'none' : typeof value === 'string' && vocabulary.has(value) ? value : 'unknown';
function projectDispatchDiagnostic(read: DiagnosticRead, target: string, fixtureCounts: { requests: unknown; held: unknown }) {
  const supervisor = { present: 'unknown', paused: null as boolean | null, closing: null as boolean | null,
    error: 'unknown', active: null as number | null, queued: null as number | null, jobs: null as number | null };
  const selectedJob = { present: 'unknown', state: 'unknown', reason: 'unknown', outcome: 'unknown' };
  let diagnostic = read.code;
  if (read.code === 'observed') {
    if (!plain(read.snapshot)) diagnostic = 'malformed-snapshot';
    else {
      const source = ownData(read.snapshot, 'supervisor');
      if (source === null) supervisor.present = 'no';
      else if (plain(source)) {
        supervisor.present = 'yes';
        const paused = ownData(source, 'paused'); const closing = ownData(source, 'closing');
        supervisor.paused = typeof paused === 'boolean' ? paused : null;
        supervisor.closing = typeof closing === 'boolean' ? closing : null;
        supervisor.error = closed(ownData(source, 'error'), DIAGNOSTIC_ERRORS);
        supervisor.active = count(ownData(source, 'activeCount'), 16);
        supervisor.queued = count(ownData(source, 'queuedCount'), 64);
        const jobs = ownData(source, 'jobs');
        if (Array.isArray(jobs) && Object.getPrototypeOf(jobs) === Array.prototype && jobs.length <= 256) {
          let valid = true; let matches = 0; let selected: Record<string, unknown> | undefined;
          for (let i = 0; i < jobs.length; i++) {
            const item = Object.getOwnPropertyDescriptor(jobs, String(i));
            const job: unknown = item?.enumerable && 'value' in item ? item.value : undefined;
            if (!plain(job) || typeof ownData(job, 'id') !== 'string') { valid = false; break; }
            if (ownData(job, 'id') === target) { matches++; selected = job; }
          }
          if (valid) {
            supervisor.jobs = jobs.length;
            if (matches === 0) selectedJob.present = 'no';
            else if (matches === 1 && selected) {
              selectedJob.present = 'yes';
              selectedJob.state = closed(ownData(selected, 'state'), DIAGNOSTIC_STATES, false);
              selectedJob.reason = closed(ownData(selected, 'reason'), DIAGNOSTIC_REASONS);
              selectedJob.outcome = closed(ownData(selected, 'outcome'), DIAGNOSTIC_OUTCOMES);
            }
          }
        }
      }
    }
  }
  return { schemaVersion: 1, kind: 'history-dispatch-failure', diagnostic, supervisor, selectedJob,
    fixture: { requests: count(fixtureCounts.requests, 256), held: count(fixtureCounts.held, 256) } };
}
function dispatchDiagnosticLine(read: DiagnosticRead, target: string, counts: { requests: unknown; held: unknown }): string {
  try {
    const line = DIAGNOSTIC_PREFIX + JSON.stringify(projectDispatchDiagnostic(read, target, counts)) + '\n';
    if (Buffer.byteLength(line) <= 2048) return line;
  } catch { /* Descriptor/proxy failure: omit the input entirely. */ }
  return DIAGNOSTIC_PREFIX + '{"schemaVersion":1,"kind":"history-dispatch-failure","diagnostic":"unavailable"}\n';
}
async function withDispatchFailureDiagnostic(assertion: () => Promise<unknown>, collect: () => Promise<string>,
  emit: (line: string) => void = (line) => { process.stderr.write(line); }): Promise<void> {
  try { await assertion(); }
  catch (original) {
    let line: string;
    try { line = await collect(); }
    catch { line = dispatchDiagnosticLine({ code: 'unavailable' }, '', { requests: null, held: null }); }
    try { emit(line); } catch { /* The original failure always wins, including emitter failure. */ }
    throw original;
  }
}

async function fixture() {
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
  const requests: unknown[] = []; const held: ServerResponse[] = [];
  const endpoint = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); held.push(res); });
  });
  endpoints.push(endpoint); await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const options: ResourceConsoleServerOptions = { root: join(directory, 'ledger'), poolFile: join(directory, 'pool.json'),
    bindingsFile: join(directory, 'bindings.json'), observationsFile: join(directory, 'observations.json'), execute: true, workspace };
  save(options.poolFile, { schemaVersion: 1, id: 'history-http', workers: [{ id: 'local', provider: 'local', model: 'inert-history-fixture',
    maxConcurrent: 1, reservePercent: 0, maxTasksPerWindow: 100, taskWindowMs: 1000, priority: 1 }] });
  save(options.bindingsFile, [{ workerId: 'local', capacityKey: 'fixture-only', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` }]);
  save(options.observationsFile, [{ workerId: 'local', observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), health: 'ready', windows: [], retryAfter: null }]);
  const start = async (patch: Partial<ResourceConsoleServerOptions> = {}) => {
    const handle = await startResourceConsoleServer({ ...options, ...patch }); handles.push(handle); return handle;
  };
  const task = (patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({ id: 'task-a',
    prompt: 'PRIVATE_HISTORY_PROMPT with explicit attached text', allowedWorkerIds: ['local'], mode: 'read-only',
    timeoutMs: 20_000, maxOutputTokens: 100, ...patch });
  const finish = (index = 0, text = 'PRIVATE_HISTORY_OUTPUT') => held[index]!.end(JSON.stringify({
    choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  return { options, requests, held, start, task, finish };
}
const submit = (handle: ResourceConsoleServerHandle, task: unknown) => http(handle, '/api/resources/tasks', {
  method: 'POST', headers: controlHeaders(handle), body: task });
const remove = (handle: ResourceConsoleServerHandle, id = 'task-a', body: unknown = {}) => http(handle, `${historyPath(id)}/delete`, {
  method: 'POST', headers: controlHeaders(handle), body });
async function snapshot(handle: ResourceConsoleServerHandle): Promise<ResourceConsoleSnapshot> {
  const response = await http(handle, '/api/resources', { headers: readHeaders(handle) });
  expect(response.status).toBe(200); return JSON.parse(response.text);
}
async function settle(handle: ResourceConsoleServerHandle) {
  await vi.waitFor(async () => expect((await snapshot(handle)).supervisor?.jobs[0]?.state).toBe('settled'), { timeout: 10_000, interval: 50 });
}

describe('resource console retained history HTTP boundary', () => {
  it('advertises support only for execution consoles and keeps read-only history inert', async () => {
    const f = await fixture(); const handle = await f.start({ execute: false, workspace: undefined });
    expect(handle.scope.historySupported).toBeUndefined();
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: readHeaders(handle), body: {} })).status).toBe(403);
    expect(existsSync(f.options.root)).toBe(false); expect(f.requests).toEqual([]);
  });

  it('separates read-session proof from deletion control and rejects unknown task IDs', async () => {
    const f = await fixture(); const handle = await f.start(); expect(handle.scope.historySupported).toBe(true);
    expect((await http(handle, historyPath())).status).toBe(401);
    expect((await http(handle, historyPath(), { headers: controlHeaders(handle) })).status).toBe(401);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    const client = randomBytes(32).toString('hex');
    const session = await http(handle, '/api/session', { method: 'POST', headers: { ...readHeaders(handle), 'x-ashlr-read-client': client } });
    expect(session.status).toBe(204); const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
    const headers = { cookie, 'x-ashlr-read-client': client };
    expect((await http(handle, historyPath(), { headers })).status).toBe(404);
    expect((await http(handle, historyPath(), { headers: { ...headers, 'x-ashlr-read-client': '0'.repeat(64) } })).status).toBe(401);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers, body: {} })).status).toBe(401);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: readHeaders(handle), body: {} })).status).toBe(401);
    expect((await remove(handle)).status).toBe(404); expect(f.requests).toEqual([]);
  });

  it('rejects query scope, unexpected methods, origins and deletion payload fields', async () => {
    const f = await fixture(); const handle = await f.start();
    for (const suffix of ['?root=/tmp', '?client=secret', '?id=other']) {
      expect((await http(handle, `${historyPath()}${suffix}`, { headers: readHeaders(handle) })).status).toBe(400);
      expect((await http(handle, `${historyPath()}/delete${suffix}`, { method: 'POST', headers: controlHeaders(handle), body: {} })).status).toBe(400);
    }
    expect((await http(handle, historyPath(), { method: 'POST', headers: controlHeaders(handle), body: {} })).status).toBe(404);
    expect((await http(handle, historyPath(), { method: 'DELETE', headers: readHeaders(handle), body: {} })).status).toBe(405);
    expect((await http(handle, `${historyPath()}/delete`, { method: 'POST', headers: { ...controlHeaders(handle), origin: 'https://example.invalid' }, body: {} })).status).toBe(403);
    for (const body of [{ root: '/tmp' }, { id: 'task-a' }, { confirm: true }, [], null]) expect((await remove(handle, 'task-a', body)).status).toBe(400);
    expect((await submit(handle, { ...f.task({ retainHistory: true }), cwd: '/tmp' })).status).toBe(400);
    expect(f.requests).toEqual([]);
  });

  it.each([null, 'true', 1, {}, []])('rejects non-boolean retention consent %j before queueing', async (retainHistory) => {
    const f = await fixture(); const handle = await f.start();
    expect((await submit(handle, { ...f.task(), retainHistory })).status).toBe(400);
    expect((await snapshot(handle)).supervisor?.jobs).toEqual([]); expect(f.requests).toEqual([]);
  });

  it('retains exactly opted-in text across restart, deletes it without ledger loss, and never resurrects a retry', async () => {
    const f = await fixture(); const first = await f.start(); const task = f.task({ retainHistory: true });
    const queued = await submit(first, task); expect(queued.status).toBe(202); expect(queued.text).not.toContain(task.prompt);
    await withDispatchFailureDiagnostic(() => vi.waitFor(() => expect(f.held).toHaveLength(1)),
      async () => dispatchDiagnosticLine(await readDispatchDiagnostic(first), task.id,
        { requests: f.requests.length, held: f.held.length })); f.finish(); await settle(first);
    const read = await http(first, historyPath(), { headers: readHeaders(first) }); expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store'); expect(read.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(read.text)).toEqual({ id: task.id, prompt: task.prompt,
      output: { text: 'PRIVATE_HISTORY_OUTPUT', truncated: false }, retention: 'local-until-deleted',
      transcriptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const proof = randomBytes(32).toString('hex');
    const session = await http(first, '/api/session', { method: 'POST', headers: { ...readHeaders(first), 'x-ashlr-read-client': proof } });
    expect(session.status).toBe(204); const cookie = session.headers['set-cookie']![0]!.split(';')[0]!;
    const sessionRead = await http(first, historyPath(), { headers: { cookie, 'x-ashlr-read-client': proof } });
    expect(sessionRead.status).toBe(200); expect(JSON.parse(sessionRead.text)).toEqual(JSON.parse(read.text));
    expect(sessionRead.headers['cache-control']).toBe('no-store');
    const metadata = await snapshot(first); expect(metadata.supervisor?.jobs[0]?.historyAvailable).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('PRIVATE_HISTORY');
    const ledgerFile = join(f.options.root, 'pool-state.json'); const ledger = readFileSync(ledgerFile);
    await first.close(); const restarted = await f.start();
    const retained = await http(restarted, historyPath(), { headers: readHeaders(restarted) }); expect(retained.status).toBe(200);
    expect(JSON.parse(retained.text)).toEqual(JSON.parse(read.text)); expect(f.requests).toHaveLength(1);
    const deleted = await remove(restarted); expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.text).job.historyAvailable).toBeUndefined(); expect(deleted.text).not.toContain('PRIVATE_HISTORY');
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    expect((await remove(restarted)).status).toBe(200); expect(readFileSync(ledgerFile)).toEqual(ledger);
    expect((await submit(restarted, task)).status).toBe(202);
    expect((await submit(restarted, { ...task, retainHistory: false })).status).toBe(409);
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    await restarted.close(); const third = await f.start();
    expect((await http(third, historyPath(), { headers: readHeaders(third) })).status).toBe(404);
    expect(f.requests).toHaveLength(1); expect(readFileSync(ledgerFile)).toEqual(ledger);
  });

  it('keeps omitted/false consent ephemeral and immutable on retry', async () => {
    const f = await fixture(); const handle = await f.start(); const task = f.task();
    expect((await submit(handle, task)).status).toBe(202);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); f.finish(); await settle(handle);
    expect((await submit(handle, { ...task, retainHistory: false })).status).toBe(202);
    expect((await submit(handle, { ...task, retainHistory: true })).status).toBe(409);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await remove(handle)).status).toBe(200);
    await handle.close(); const restarted = await f.start();
    expect((await http(restarted, historyPath(), { headers: readHeaders(restarted) })).status).toBe(404);
    expect(f.requests).toHaveLength(1);
  });

  it('refuses queued/active deletion, then clears both retained history and session output after settlement', async () => {
    const f = await fixture(); const handle = await f.start();
    expect((await http(handle, '/api/resources/queue', { method: 'POST', headers: controlHeaders(handle), body: { paused: true } })).status).toBe(200);
    expect((await submit(handle, f.task({ retainHistory: true }))).status).toBe(202);
    expect((await remove(handle)).status).toBe(409); expect(f.requests).toEqual([]);
    expect((await http(handle, '/api/resources/queue', { method: 'POST', headers: controlHeaders(handle), body: { paused: false } })).status).toBe(200);
    await vi.waitFor(() => expect(f.held).toHaveLength(1)); expect((await remove(handle)).status).toBe(409);
    f.finish(); await settle(handle); expect((await remove(handle)).status).toBe(200);
    expect((await http(handle, historyPath(), { headers: readHeaders(handle) })).status).toBe(404);
    expect((await http(handle, '/api/resources/tasks/task-a/output', { headers: readHeaders(handle) })).status).toBe(404);
  });
});

const diagnosticHandle = { port: 4321, readToken: 'PRIVATE_READ_TOKEN' } as ResourceConsoleServerHandle;
const diagnosticSnapshot = (job: Record<string, unknown> = {}) => ({ supervisor: {
  paused: false, closing: false, error: null, activeCount: 1, queuedCount: 0,
  jobs: [{ id: 'task-a', state: 'dispatching', reason: 'dispatch-requested', outcome: null, ...job }],
} });
const diagnosticCounts = { requests: 0, held: 0 };
const diagnosticProjection = (snapshot: unknown, counts = diagnosticCounts) =>
  projectDispatchDiagnostic({ code: 'observed', snapshot }, 'task-a', counts);
function diagnosticEvents() {
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const res = Object.assign(new EventEmitter(), { statusCode: 200 as number | undefined, destroy: vi.fn() });
  let receive!: (response: IncomingMessage) => void;
  const factory = vi.fn((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    receive = callback; return req as unknown as ClientRequest;
  });
  return { req, res, factory, respond: () => receive(res as unknown as IncomingMessage) };
}

describe('failure-only history diagnostic closed projection', () => {
  it('projects an exact literal line without private snapshot or error fields', () => {
    const snapshot = diagnosticSnapshot({ prompt: 'PRIVATE_PROMPT', output: 'PRIVATE_OUTPUT', workerId: 'PRIVATE_WORKER' });
    Object.assign(snapshot, { root: '/PRIVATE_ROOT', workspace: '/PRIVATE_WORKSPACE', endpoint: 'https://PRIVATE_ENDPOINT',
      readToken: 'PRIVATE_READ_TOKEN', controlToken: 'PRIVATE_CONTROL_TOKEN', capacityKey: 'PRIVATE_CAPACITY',
      tokenCount: 99, transcriptDigest: 'PRIVATE_DIGEST', observedAt: 'PRIVATE_TIME' });
    expect(dispatchDiagnosticLine({ code: 'observed', snapshot }, 'task-a', diagnosticCounts)).toBe(
      '[history-dispatch-diagnostic-v1] {"schemaVersion":1,"kind":"history-dispatch-failure","diagnostic":"observed",'
      + '"supervisor":{"present":"yes","paused":false,"closing":false,"error":"none","active":1,"queued":0,"jobs":1},'
      + '"selectedJob":{"present":"yes","state":"dispatching","reason":"dispatch-requested","outcome":"none"},'
      + '"fixture":{"requests":0,"held":0}}\n');
  });
  it.each([
    ['queued', 'no-eligible-capacity', null, 'none'],
    ['settled', 'worker-transport-failed', 'failed', 'failed'],
    ['unresolved', 'previous-dispatch-unresolved', 'uncertain', 'uncertain'],
  ])('keeps declared closed %s state and reason', (state, reason, outcome, expectedOutcome) => {
    expect(diagnosticProjection(diagnosticSnapshot({ state, reason, outcome })).selectedJob)
      .toEqual({ present: 'yes', state, reason, outcome: expectedOutcome });
  });
  it('distinguishes null, missing, malformed supervisor, empty and duplicate jobs', () => {
    expect(diagnosticProjection({ supervisor: null }).supervisor.present).toBe('no');
    expect(diagnosticProjection({}).supervisor.present).toBe('unknown');
    expect(diagnosticProjection({ supervisor: 1 }).supervisor.present).toBe('unknown');
    expect(diagnosticProjection(null).diagnostic).toBe('malformed-snapshot');
    const snapshot = diagnosticSnapshot(); snapshot.supervisor.jobs = [];
    expect(diagnosticProjection(snapshot).selectedJob.present).toBe('no');
    snapshot.supervisor.jobs = [diagnosticSnapshot().supervisor.jobs[0]!, diagnosticSnapshot().supervisor.jobs[0]!];
    expect(diagnosticProjection(snapshot).selectedJob.present).toBe('unknown');
    expect(diagnosticProjection(snapshot).supervisor.jobs).toBe(2);
  });
  it('replaces unknown text and missing values with closed unknowns', () => {
    const snapshot = diagnosticSnapshot({ state: '/PRIVATE_STATE', reason: 'PRIVATE_REASON https://private.invalid', outcome: 'PRIVATE_OUTCOME' });
    Object.assign(snapshot.supervisor, { error: 'PRIVATE_ERROR', paused: 'false', closing: 0 });
    const projected = diagnosticProjection(snapshot);
    expect(projected.selectedJob).toEqual({ present: 'yes', state: 'unknown', reason: 'unknown', outcome: 'unknown' });
    expect(projected.supervisor).toMatchObject({ error: 'unknown', paused: null, closing: null });
    expect(dispatchDiagnosticLine({ code: 'observed', snapshot }, 'task-a', diagnosticCounts)).not.toContain('PRIVATE');
    expect(diagnosticProjection(diagnosticSnapshot({ state: null, reason: undefined, outcome: undefined })).selectedJob)
      .toMatchObject({ state: 'unknown', reason: 'unknown', outcome: 'unknown' });
  });
  it.each([-1, 0.5, NaN, Infinity, '1', 257])('refuses invalid fixture count %s without coercion', (value) => {
    const projected = projectDispatchDiagnostic({ code: 'observed', snapshot: diagnosticSnapshot() }, 'task-a', { requests: value, held: value });
    expect(projected.fixture).toEqual({ requests: null, held: null });
    const snapshot = diagnosticSnapshot(); Object.assign(snapshot.supervisor, { activeCount: value, queuedCount: value });
    expect(diagnosticProjection(snapshot).supervisor).toMatchObject({ active: null, queued: null });
  });
  it('preserves zero and actual maximum counts, refusing over-cap values', () => {
    const snapshot = diagnosticSnapshot(); Object.assign(snapshot.supervisor, { activeCount: 16, queuedCount: 64,
      jobs: Array.from({ length: 256 }, (_, i) => ({ id: `job-${i}` })) });
    expect(diagnosticProjection(snapshot, { requests: 256, held: 256 })).toMatchObject({
      supervisor: { active: 16, queued: 64, jobs: 256 }, fixture: { requests: 256, held: 256 } });
    Object.assign(snapshot.supervisor, { activeCount: 17, queuedCount: 65 });
    expect(diagnosticProjection(snapshot).supervisor).toMatchObject({ active: null, queued: null });
    Object.assign(snapshot.supervisor, { activeCount: 0, queuedCount: 0, jobs: [] });
    expect(diagnosticProjection(snapshot).supervisor).toMatchObject({ active: 0, queued: 0, jobs: 0 });
  });
  it('does not invoke getters or toJSON, and refuses unsafe job arrays', () => {
    const getter = vi.fn(() => 'PRIVATE_GETTER'); const toJSON = vi.fn(() => 'PRIVATE_JSON');
    const snapshot = diagnosticSnapshot({ toJSON });
    Object.defineProperty(snapshot.supervisor.jobs[0]!, 'reason', { get: getter, enumerable: true });
    Object.defineProperty(snapshot.supervisor, 'error', { get: getter, enumerable: true });
    expect(dispatchDiagnosticLine({ code: 'observed', snapshot }, 'task-a', diagnosticCounts)).not.toContain('PRIVATE');
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled();
    Object.defineProperty(snapshot.supervisor.jobs[0]!, 'id', { get: getter, enumerable: true });
    expect(diagnosticProjection(snapshot).selectedJob.present).toBe('unknown');
    const indexed = [diagnosticSnapshot().supervisor.jobs[0]!];
    Object.defineProperty(indexed, '0', { get: getter, enumerable: true });
    Object.assign(snapshot.supervisor, { jobs: indexed });
    expect(diagnosticProjection(snapshot).supervisor.jobs).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const custom = Object.setPrototypeOf([], {});
    for (const jobs of [new Array(2), custom, Array.from({ length: 257 }, () => ({ id: 'task-a' })), [Object.create({ id: 'task-a' })], [{}]]) {
      Object.assign(snapshot.supervisor, { jobs });
      expect(diagnosticProjection(snapshot)).toMatchObject({ supervisor: { jobs: null }, selectedJob: { present: 'unknown' } });
    }
  });
  it('keeps worst qualified output ASCII and below2048bytes, and refuses descriptor exceptions', () => {
    const snapshot = diagnosticSnapshot({ state: 'dispatching', reason: 'pool-evolution-reenrollment-required', outcome: 'timed-out' });
    Object.assign(snapshot.supervisor, { error: 'supervisor-commissioning-custody-unavailable', activeCount: 16, queuedCount: 64 });
    const line = dispatchDiagnosticLine({ code: 'observed', snapshot }, 'task-a', { requests: 256, held: 256 });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048); expect([...line].every((character) => character.charCodeAt(0) <= 127)).toBe(true);
    expect(line.startsWith(DIAGNOSTIC_PREFIX)).toBe(true); expect(line.endsWith('\n')).toBe(true);
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('PRIVATE_EXCEPTION'); } });
    expect(dispatchDiagnosticLine({ code: 'observed', snapshot: hostile }, 'task-a', diagnosticCounts)).toBe(
      '[history-dispatch-diagnostic-v1] {"schemaVersion":1,"kind":"history-dispatch-failure","diagnostic":"unavailable"}\n');
  });
});

describe('failure-only history diagnostic absolute request lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('uses one authenticated fixed GET and settles at250ms without awaiting destruction', async () => {
    const mock = diagnosticEvents(); const settled = vi.fn();
    const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory).then((value) => { settled(value); return value; });
    expect(mock.factory).toHaveBeenCalledExactlyOnceWith({ hostname: '127.0.0.1', port: 4321, path: '/api/resources',
      method: 'GET', agent: false, headers: { 'x-ashlr-token': 'PRIVATE_READ_TOKEN' } }, expect.any(Function));
    expect(mock.req.end).toHaveBeenCalledExactlyOnceWith();
    await vi.advanceTimersByTimeAsync(249); expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual({ code: 'deadline' });
    expect(mock.req.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    mock.req.emit('error', new Error('PRIVATE_LATE_ERROR')); mock.respond();
    expect(mock.res.destroy).toHaveBeenCalledOnce();
    mock.res.emit('error', new Error('PRIVATE_RESPONSE_ERROR')); mock.res.emit('data', Buffer.alloc(40_000)); mock.res.emit('end');
    expect(settled).toHaveBeenCalledOnce(); expect(mock.factory).toHaveBeenCalledOnce();
  });
  it('does not reset the absolute deadline for trickle data and consumes late events', async () => {
    const mock = diagnosticEvents(); const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory); mock.respond();
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(50); mock.res.emit('data', Buffer.from(' ')); }
    await vi.advanceTimersByTimeAsync(50); expect(await pending).toEqual({ code: 'deadline' });
    expect(mock.req.destroy).toHaveBeenCalledOnce(); expect(mock.res.destroy).toHaveBeenCalledOnce();
    mock.res.emit('data', Buffer.from('{}')); mock.res.emit('end'); mock.res.emit('error', new Error('PRIVATE'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([32_768, 32_769])('bounds raw bytes before append at%s', async (bytes) => {
    const mock = diagnosticEvents(); const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory); mock.respond();
    mock.res.emit('data', Buffer.from('{}' + ' '.repeat(bytes - 2))); mock.res.emit('end');
    expect(await pending).toEqual(bytes === 32_768 ? { code: 'observed', snapshot: {} } : { code: 'body-overflow' });
    expect(mock.req.destroy).toHaveBeenCalledTimes(bytes === 32_768 ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['error', 'aborted', 'close'])('settles once for response%s even when destroy emits end/error', async (event) => {
    const mock = diagnosticEvents(); const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory); mock.respond();
    mock.res.destroy.mockImplementation(() => { mock.res.emit('end'); mock.res.emit('error', new Error('PRIVATE')); });
    mock.res.emit(event, new Error('PRIVATE_STREAM'));
    expect(await pending).toEqual({ code: 'unavailable' }); expect(mock.res.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['error', 'close'])('refuses a request%s with no response and consumes later errors', async (event) => {
    const mock = diagnosticEvents(); const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory);
    mock.req.emit(event, new Error('PRIVATE_REQUEST'));
    expect(await pending).toEqual({ code: 'unavailable' }); expect(mock.req.destroy).toHaveBeenCalledOnce();
    mock.req.emit('error', new Error('PRIVATE_LATE')); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the original assertion after actual mock reader deadline and throwing cleanup', async () => {
    const original = new Error('PRIVATE_ORIGINAL'); const mock = diagnosticEvents(); const emit = vi.fn();
    mock.req.destroy.mockImplementation(() => { throw new Error('PRIVATE_CLEANUP'); });
    mock.res.destroy.mockImplementation(() => { throw new Error('PRIVATE_RESPONSE_CLEANUP'); });
    const pending = withDispatchFailureDiagnostic(async () => { throw original; }, async () =>
      dispatchDiagnosticLine(await readDispatchDiagnostic(diagnosticHandle, mock.factory), 'task-a', diagnosticCounts), emit);
    const rejection = expect(pending).rejects.toBe(original);
    await Promise.resolve(); mock.respond(); await vi.advanceTimersByTimeAsync(250); await rejection;
    expect(emit).toHaveBeenCalledOnce(); expect(emit.mock.calls[0]![0]).toContain('"diagnostic":"deadline"');
    expect(emit.mock.calls[0]![0]).not.toContain('PRIVATE'); expect(mock.req.destroy).toHaveBeenCalledOnce();
    expect(mock.res.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('contains request creation/end/destruction errors without leaking them', async () => {
    expect(await readDispatchDiagnostic(diagnosticHandle, () => { throw new Error('PRIVATE_CONSTRUCTOR'); })).toEqual({ code: 'unavailable' });
    const mock = diagnosticEvents(); mock.req.end.mockImplementation(() => { throw new Error('PRIVATE_END'); });
    mock.req.destroy.mockImplementation(() => { throw new Error('PRIVATE_DESTROY'); });
    expect(await readDispatchDiagnostic(diagnosticHandle, mock.factory)).toEqual({ code: 'unavailable' });
    expect(mock.req.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([undefined, 403])('refuses non200 status%s without body echo', async (statusCode) => {
    const mock = diagnosticEvents(); mock.res.statusCode = statusCode;
    const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory); mock.respond();
    mock.res.emit('data', Buffer.from('PRIVATE_BODY')); mock.res.emit('end');
    expect(await pending).toEqual({ code: 'http-refused' });
    expect(mock.req.destroy).toHaveBeenCalledOnce(); expect(mock.res.destroy).toHaveBeenCalledOnce();
  });
  it('refuses invalid JSON and clears the deadline on successful end', async () => {
    for (const text of ['PRIVATE_BAD_JSON', '{"supervisor":null}']) {
      const mock = diagnosticEvents(); const pending = readDispatchDiagnostic(diagnosticHandle, mock.factory); mock.respond();
      mock.res.emit('data', Buffer.from(text)); mock.res.emit('end');
      expect(await pending).toEqual(text.startsWith('{') ? { code: 'observed', snapshot: { supervisor: null } } : { code: 'parse-refused' });
      await vi.advanceTimersByTimeAsync(500);
      expect(mock.req.destroy).toHaveBeenCalledTimes(text.startsWith('{') ? 0 : 1); expect(vi.getTimerCount()).toBe(0);
      mock.res.emit('end'); mock.req.emit('error', new Error('PRIVATE_LATE')); mock.res.emit('error', new Error('PRIVATE_LATE'));
    }
  });
});

describe('failure-only history diagnostic original error precedence', () => {
  it('does no diagnostic work when the original assertion succeeds', async () => {
    const read = vi.fn(); const emit = vi.fn();
    await withDispatchFailureDiagnostic(async () => {}, read, emit);
    expect(read).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });
  it.each(['observed', 'read-throws', 'projection-throws', 'emitter-throws', 'held-later'])('rethrows identical original for%s', async (mode) => {
    const original = Object.assign(new Error('PRIVATE_ORIGINAL', { cause: 'PRIVATE_CAUSE' }), { privateField: 'PRIVATE_FIELD' });
    const before = Object.getOwnPropertyDescriptors(original); const held: unknown[] = [];
    const emit = vi.fn((line: string) => { expect(line).not.toContain('PRIVATE'); if (mode === 'emitter-throws') throw new Error('PRIVATE_EMITTER'); });
    const collect = vi.fn(async () => {
      if (mode === 'read-throws') throw new Error('PRIVATE_READ');
      if (mode === 'held-later') held.push('PRIVATE_HELD');
      const snapshot = mode === 'projection-throws'
        ? new Proxy({}, { getPrototypeOf: () => { throw new Error('PRIVATE_PROJECTOR'); } }) : diagnosticSnapshot();
      return dispatchDiagnosticLine({ code: 'observed', snapshot }, 'task-a', { requests: 0, held: held.length });
    });
    await expect(withDispatchFailureDiagnostic(async () => { throw original; }, collect, emit)).rejects.toBe(original);
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(before); expect(collect).toHaveBeenCalledOnce(); expect(emit).toHaveBeenCalledOnce();
    if (mode === 'held-later') { expect(held).toHaveLength(1); expect(emit.mock.calls[0]![0]).toContain('"held":1'); }
  });
});
