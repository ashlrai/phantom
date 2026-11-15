import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ exec: vi.fn(), http: vi.fn(), plan: vi.fn(), readConfig: vi.fn(), call: vi.fn() }));
vi.mock('node:http', () => ({ request: ports.http }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: ports.exec }) }));
vi.mock('../src/core/drive/nodes/local-model-caps.js', () => ({ localLanePlan: ports.plan }));
vi.mock('../src/core/drive/nodes/pool-host.js', () => ({ readPoolConfig: ports.readConfig, callPool: ports.call }));
vi.mock('../src/core/drive/nodes/worker.js', () => ({ nodeStopped: () => false }));
import { parseNodeRunnerRequest, readNodeRunnerRequest, runNodeRunner } from '../src/core/drive/nodes/runner.js';
import { validId } from '../src/core/drive/nodes/state.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { executePool, initializePool } from '../src/core/drive/nodes/pool.js';
import type { NodesStore } from '../src/core/drive/nodes/state.js';
import { cmdNode } from '../src/cli/node.js';

const config = { role: 'worker' as const, primary: 'mac', backup: 'muse', owner: 'mason', node: 'muse' };
const request = () => ({ protocol: 'phm-node-worker/v1' as const,
  job: { id: 'job-1', owner: 'mason', state: 'running' as const, requires: ['codex'], secrets: [], pack: 'shell-check' as const },
  claim: { nodeId: 'muse', session: 2, jobId: 'job-1', token: 4, leaderToken: 3, expiresAt: Date.now() + 30_000 } });
let home: string;
let responseBody: string, responseStatus: number, sentBody: string;
const resultPath = () => join(home, '.ashlr-runs/node-results/job-1.json');
const metrics = () => readFileSync(join(home, '.ashlr-runs/metrics/jobs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
beforeEach(() => {
  vi.resetAllMocks();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'node-runner-')));
  vi.stubEnv('HOME', home);
  responseBody = JSON.stringify({ choices: [{ message: { content: 'untrusted model output' } }] });
  responseStatus = 200;
  ports.http.mockImplementation((_url, _options, callback) => {
    const request = new PassThrough();
    request.on('data', chunk => { sentBody = String(chunk); });
    request.on('finish', () => {
      const response = Object.assign(new PassThrough(), { statusCode: responseStatus });
      callback(response); response.end(responseBody);
    });
    return request;
  });
  ports.exec.mockResolvedValue({ stdout: 'node-shell-check-ok\n' });
  ports.plan.mockReturnValue({ plan: { backoff: false, model: { repo: 'local/model' }, caps: ['omlx'] } });
  ports.readConfig.mockReturnValue(config);
  ports.call.mockImplementation(() => ({ demoted: false, result: { expiresAt: Date.now() + 30_000 } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

describe('reference node runner', () => {
  it.each([
    (r: any) => { r.protocol = 'wrong'; },
    (r: any) => { r.command = 'echo'; },
    (r: any) => { r.job.argv = ['secret']; },
    (r: any) => { r.job.pack = 'unknown'; },
    (r: any) => { r.job.id = 'a/../../escape'; r.claim.jobId = r.job.id; },
    (r: any) => { r.job.id = 'a'.repeat(121); r.claim.jobId = r.job.id; },
    (r: any) => { r.job.state = 'pending'; },
    (r: any) => { r.job.owner = `ghp_${'x'.repeat(36)}`; },
    (r: any) => { r.job.secrets = ['API_KEY']; },
    (r: any) => { r.job.requires = ['codex', 'codex']; },
    (r: any) => { r.claim.jobId = 'other'; },
    (r: any) => { r.claim.token = 0; },
    (r: any) => { r.claim.session = 1.5; },
    (r: any) => { r.claim.leaderToken = Number.MAX_SAFE_INTEGER + 1; },
  ])('rejects malformed or credential-bearing requests before execution', mutate => {
    const r = request(); mutate(r);
    expect(() => parseNodeRunnerRequest(JSON.stringify(r))).toThrow('Invalid node runner request');
    expect(ports.exec).not.toHaveBeenCalled();
  });
  it('bounds, parses and times out stdin', async () => {
    expect(await readNodeRunnerRequest(Readable.from([JSON.stringify(request())]))).toMatchObject({ protocol: 'phm-node-worker/v1' });
    await expect(readNodeRunnerRequest(Readable.from([' '.repeat(16 * 1024 + 1)]))).rejects.toThrow('too large');
    await expect(readNodeRunnerRequest(Readable.from(['{}\n{}']))).rejects.toThrow('Invalid');
    vi.useFakeTimers();
    const pending = expect(readNodeRunnerRequest(new PassThrough())).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000); await pending;
  });
  it('returns a valid reference to a private artifact and records only metadata', async () => {
    const reply = await runNodeRunner(request());
    expect(reply).toEqual({ resultRef: 'node-results:job-1' });
    expect(validId(reply.resultRef)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(4096);
    expect(JSON.parse(readFileSync(resultPath(), 'utf8'))).toMatchObject({ jobId: 'job-1', outcome: 'succeeded', token: 4, leaderToken: 3 });
    expect(statSync(resultPath()).mode & 0o777).toBe(0o600);
    expect(metrics()).toHaveLength(1);
    expect(ports.exec).toHaveBeenCalledWith(process.execPath, ['--permission', '--no-warnings', '--input-type=commonjs', '-e',
      'process.stdout.write("node-shell-check-ok\\n")'], expect.objectContaining({ env: {}, cwd: '/', shell: false, killSignal: 'SIGKILL', maxBuffer: 1024 }));
    expect(ports.call.mock.calls.every(c => c[1] === 'renew')).toBe(true);
    expect(ports.call.mock.calls[0]![2]).toEqual(['--node', 'muse', '--session', '2', '--job', 'job-1', '--token', '4', '--leader-token', '3']);
  });
  it('rejects owner, node, expiry and witness failures before work', async () => {
    await expect(runNodeRunner(request(), { config: { ...config, owner: 'other' } })).rejects.toThrow('identity');
    await expect(runNodeRunner(request(), { config: { ...config, node: 'other' } })).rejects.toThrow('identity');
    const expired = request(); expired.claim.expiresAt = Date.now() - 1;
    await expect(runNodeRunner(expired)).rejects.toThrow('fenced');
    await expect(runNodeRunner(request(), { stopped: () => true })).rejects.toThrow('fenced');
    ports.call.mockReturnValue({ demoted: true, result: { expiresAt: Date.now() + 30_000 } });
    await expect(runNodeRunner(request())).rejects.toThrow('fenced');
    ports.call.mockImplementation(() => { throw new Error('transport'); });
    await expect(runNodeRunner(request())).rejects.toThrow('fenced');
    expect(ports.exec).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
  it('fences after execution and never publishes an artifact for a stale claim', async () => {
    ports.exec.mockImplementation(async () => { ports.call.mockReturnValue({ demoted: false, result: {} }); return { stdout: 'node-shell-check-ok\n' }; });
    await expect(runNodeRunner(request())).rejects.toThrow('fenced');
    expect(readdirSync(join(home, '.ashlr-runs/node-results'))).toEqual([]);
    expect(metrics()[0].outcome).toBe('fenced');
  });
  it('aborts an in-flight action when the lease cannot be renewed', async () => {
    vi.useFakeTimers();
    ports.exec.mockImplementation((_exe, _argv, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = expect(runNodeRunner(request())).rejects.toThrow('fenced');
    ports.call.mockReturnValue({ demoted: false, result: {} });
    await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(metrics()[0].outcome).toBe('fenced');
  });
  it('stops at the runner deadline even while renewals succeed', async () => {
    vi.useFakeTimers();
    ports.exec.mockImplementation((_exe, _argv, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = expect(runNodeRunner(request())).rejects.toThrow('fenced');
    await vi.advanceTimersByTimeAsync(60_000); await pending;
    expect(metrics()[0].outcome).toBe('fenced');
    expect(readdirSync(join(home, '.ashlr-runs/node-results'))).toEqual([]);
  });
  it('uses real witness fencing and leaves queue completion to the worker', async () => {
    const state = emptyState();
    const store: NodesStore = { transaction: fn => fn(state) };
    initializePool(store, 'mac', 'muse');
    const rpc = (verb: string, args: string[]) => executePool(store, { origin: 'primary', action: 'execute', verb, args }, 'mason');
    const session = String(rpc('join', ['--node', 'muse', '--caps', 'codex']).result.session);
    const identity = ['--node', 'muse', '--session', session];
    rpc('beat', identity);
    rpc('enqueue', ['--job', 'job-1', '--requires', 'codex', '--pack', 'shell-check']);
    const pulled = rpc('pull', identity).result;
    const r = parseNodeRunnerRequest(JSON.stringify({ protocol: 'phm-node-worker/v1', job: pulled.job, claim: pulled.claim }));
    const call = (_config: unknown, verb: string, args: string[]) => rpc(verb, args);
    await expect(runNodeRunner({ ...r, claim: { ...r.claim, token: r.claim.token + 1 } }, { config, call })).rejects.toThrow('fenced');
    expect(ports.exec).not.toHaveBeenCalled();
    const result = await runNodeRunner(r, { config, call });
    expect(state.jobs[0]!.state).toBe('running');
    expect(rpc('complete', [...identity, '--job', r.job.id, '--token', String(r.claim.token),
      '--leader-token', String(r.claim.leaderToken), '--result', result.resultRef]).result.completed).toBe(true);
  });
  it('never overwrites a previous result, including a symlink destination', async () => {
    await runNodeRunner(request());
    const original = readFileSync(resultPath(), 'utf8');
    await expect(runNodeRunner(request())).rejects.toThrow();
    expect(readFileSync(resultPath(), 'utf8')).toBe(original);
    rmSync(resultPath());
    const target = join(home, 'outside'); writeFileSync(target, 'untouched'); symlinkSync(target, resultPath());
    await expect(runNodeRunner(request())).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });
  it('refuses linked storage and metrics', async () => {
    symlinkSync(home, join(home, '.ashlr-runs'));
    await expect(runNodeRunner(request())).rejects.toThrow();
    expect(ports.exec).not.toHaveBeenCalled();
    rmSync(join(home, '.ashlr-runs'));
    await runNodeRunner(request());
    const ledger = join(home, '.ashlr-runs/metrics/jobs.jsonl'); rmSync(ledger);
    symlinkSync(resultPath(), ledger);
    await expect(runNodeRunner(request())).rejects.toThrow();
    expect(JSON.parse(readFileSync(resultPath(), 'utf8')).outcome).toBe('succeeded');
  });
  it('calls only fixed numeric loopback and discards all model text', async () => {
    await runNodeRunner({ ...request(), job: { ...request().job, pack: 'omlx-chat' } });
    expect(ports.http).toHaveBeenCalledWith('http://127.0.0.1:8000/v1/chat/completions', expect.objectContaining({ agent: false, method: 'POST' }), expect.any(Function));
    const options = ports.http.mock.calls[0]![1];
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(sentBody)).toMatchObject({ model: 'model', stream: false, max_tokens: 16 });
    expect(readFileSync(resultPath(), 'utf8')).not.toContain('untrusted');
    expect(ports.exec).not.toHaveBeenCalled();
  });
  it.each([[302, 'redirect'], [200, '{}'], [200, 'x'.repeat(16 * 1024 + 1)]] as const)(
    'refuses bad, redirected and oversized local model responses', async (status, body) => {
      responseStatus = status; responseBody = body;
      await expect(runNodeRunner({ ...request(), job: { ...request().job, pack: 'omlx-chat' } })).rejects.toThrow();
      expect(readdirSync(join(home, '.ashlr-runs/node-results'))).toEqual([]);
      expect(metrics()[0].outcome).toBe('failed');
    });
  it('does not contact a held local model', async () => {
    ports.plan.mockReturnValue({ plan: { backoff: true } });
    await expect(runNodeRunner({ ...request(), job: { ...request().job, pack: 'omlx-chat' } })).rejects.toThrow();
    expect(ports.http).not.toHaveBeenCalled();
  });
  it('routes the CLI, preserves stdout for success only, and rejects command flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([JSON.stringify(request())]) as NodeJS.ReadStream);
    expect(await cmdNode(['run-once', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledExactlyOnceWith('{"resultRef":"node-results:job-1"}');
    log.mockClear();
    expect(await cmdNode(['run-once', '--command', 'anything'])).toBe(2);
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['{}']) as NodeJS.ReadStream);
    expect(await cmdNode(['run-once'])).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });
});
