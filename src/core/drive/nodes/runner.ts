import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { privateDirectory } from '../../universe/artifacts.js';
import { fsyncDirectory } from '../../util/durability.js';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { scrubSecrets } from '../../util/scrub.js';
import { localLanePlan } from './local-model-caps.js';
import { callPool, readPoolConfig, type PoolConfig } from './pool-host.js';
import { validCap, validId } from './state.js';
import { nodeStopped } from './worker.js';
import type { JobClaim, JobView } from './index.js';

const exec = promisify(execFile);
const PROTOCOL = 'phm-node-worker/v1';
const MAX_INPUT = 16 * 1024;
const OMLX_URL = 'http://127.0.0.1:8000/v1/chat/completions';
const SHELL_CHECK = 'process.stdout.write("node-shell-check-ok\\n")';
type Pack = 'shell-check' | 'omlx-chat';
export interface NodeRunnerRequest { protocol: typeof PROTOCOL; job: JobView & { pack: Pack }; claim: JobClaim }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected;
}
function reference(value: unknown): value is string { return validId(value) && scrubSecrets(value) === value; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

/** Closed protocol: queue input can select a pack, never a command, prompt, URL or environment. */
export function parseNodeRunnerRequest(text: string): NodeRunnerRequest {
  const fail = (): never => { throw new Error('Invalid node runner request'); };
  if (Buffer.byteLength(text) > MAX_INPUT) return fail();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  if (!object(value) || !keys(value, 'claim,job,protocol') || value.protocol !== PROTOCOL ||
      !object(value.job) || !object(value.claim)) return fail();
  const j = value.job, c = value.claim;
  // validId allows paths; result filenames deliberately accept only one bounded component.
  if (!keys(j, 'id,owner,pack,requires,secrets,state') || !reference(j.id) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(j.id) || !reference(j.owner) || j.state !== 'running' ||
      !['shell-check', 'omlx-chat'].includes(String(j.pack)) || !Array.isArray(j.secrets) || j.secrets.length ||
      !Array.isArray(j.requires) || j.requires.length > 64 || !j.requires.every(validCap) ||
      new Set(j.requires).size !== j.requires.length ||
      !keys(c, 'expiresAt,jobId,leaderToken,nodeId,session,token') || c.jobId !== j.id || !reference(c.nodeId) ||
      ![c.session, c.token, c.leaderToken, c.expiresAt].every(positive)) return fail();
  return value as unknown as NodeRunnerRequest;
}

/** Bounded stdin even when the parent never closes its pipe. */
export async function readNodeRunnerRequest(input: Readable): Promise<NodeRunnerRequest> {
  const timer = setTimeout(() => input.destroy(new Error('Node runner input timed out')), 5000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const data = Buffer.from(chunk);
      bytes += data.length;
      if (bytes > MAX_INPUT) throw new Error('Node runner input too large');
      chunks.push(data);
    }
    return parseNodeRunnerRequest(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

/** Fixed code only. Node's permission sandbox grants no filesystem, child, worker or addon access.
 * This is not a general shell executor: no queue bytes reach argv and no shell is invoked. */
async function shellCheck(signal: AbortSignal): Promise<number> {
  const result = await exec(process.execPath, ['--permission', '--no-warnings', '--input-type=commonjs', '-e', SHELL_CHECK],
    { cwd: '/', env: {}, shell: false, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024, signal });
  if (result.stdout !== 'node-shell-check-ok\n') throw new Error('Shell check failed');
  return Buffer.byteLength(result.stdout);
}

/** Numeric loopback, no proxy/credential configuration, redirects, tools or remote model fallback. */
async function omlxChat(signal: AbortSignal): Promise<number> {
  const plan = localLanePlan().plan;
  if (plan.backoff || !plan.model || !plan.caps.includes('omlx')) throw new Error('Local lane unavailable');
  const model = plan.model.repo.split('/').at(-1);
  return new Promise((resolve, reject) => {
    // A fresh direct agent avoids environment-proxy configuration on the global agent.
    const request = httpRequest(OMLX_URL, { method: 'POST', agent: false, signal,
      headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('error', reject);
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Local model unavailable')); return; }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) { response.destroy(); reject(new Error('Local model response too large')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const content = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new Error('Invalid local model response');
          resolve(Buffer.byteLength(content)); // Untrusted text is never logged, executed or persisted.
        } catch { reject(new Error('Invalid local model response')); }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 16, temperature: 0, stream: false }));
  });
}

function appendOutcome(root: string, row: Record<string, unknown>): void {
  const directory = privateDirectory(join(root, 'metrics'));
  const path = join(directory, 'jobs.jsonl');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd), named = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== named.ino || stat.dev !== named.dev ||
        (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe node metrics');
    const line = JSON.stringify(row) + '\n';
    if (writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error('Incomplete node metrics');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Production uses the witnessed pool. Injectable ports keep protocol/fencing tests hermetic. */
export interface NodeRunnerDeps {
  config?: PoolConfig;
  call?: typeof callPool;
  stopped?: () => boolean;
}

export async function runNodeRunner(request: NodeRunnerRequest, deps: NodeRunnerDeps = {}): Promise<{ resultRef: string }> {
  // Revalidate even internal callers; no typed cast can bypass the closed input boundary.
  const { job, claim } = parseNodeRunnerRequest(JSON.stringify(request));
  const config = deps.config ?? readPoolConfig();
  if (!config || config.node !== claim.nodeId || config.owner !== job.owner) throw new Error('Runner identity mismatch');
  const call = deps.call ?? callPool, stopped = deps.stopped ?? nodeStopped;
  const lease = ['--node', claim.nodeId, '--session', String(claim.session), '--job', claim.jobId,
    '--token', String(claim.token), '--leader-token', String(claim.leaderToken)];
  const controller = new AbortController();
  let expiresAt = claim.expiresAt;
  const fence = () => {
    try {
      controller.signal.throwIfAborted();
      if (stopped() || expiresAt <= Date.now()) throw new Error('Lease unavailable');
      const current = call(config, 'renew', lease);
      const expiry = current.result['expiresAt'];
      if (current.demoted || !positive(expiry) || expiry <= Date.now()) throw new Error('Lease unavailable');
      expiresAt = expiry;
    } catch { controller.abort(); throw new Error('Node runner fenced'); }
  };
  fence();
  const root = privateDirectory(join(homedir(), '.ashlr-runs'));
  const results = privateDirectory(join(root, 'node-results'));
  const resultRef = `node-results:${job.id}`;
  const stop = () => controller.abort();
  const timer = setInterval(() => { try { fence(); } catch { /* abort stops the bounded action */ } }, 3000);
  const deadline = setTimeout(stop, 60_000);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const row = { schema: 'phm-node-runner.v1', event: 'finish', job: `${job.id}:${claim.token}`, jobId: job.id,
    node: claim.nodeId, pack: job.pack, token: claim.token, leaderToken: claim.leaderToken };
  let staged: string | undefined;
  try {
    const outputBytes = await (job.pack === 'shell-check' ? shellCheck(controller.signal) : omlxChat(controller.signal));
    fence();
    const artifact = { ...row, ts: new Date().toISOString(), outcome: 'succeeded', resultRef, outputBytes };
    const candidate = join(results, `.${randomUUID()}.json`);
    writePrivateFileAtomically(`${candidate}.tmp`, candidate, JSON.stringify(artifact) + '\n', { anchorPath: root, label: 'Node result' });
    staged = candidate;
    fence();
    // Immutable per-job artifacts: a late/replayed claim must never replace an existing result.
    // This is local evidence only; worker.complete is the authoritative atomic fencing boundary.
    privateDirectory(results);
    linkSync(staged, join(results, `${job.id}.json`));
    unlinkSync(staged); staged = undefined;
    fsyncDirectory(results);
    fence();
    appendOutcome(root, artifact);
    return { resultRef };
  } catch {
    appendOutcome(root, { ...row, ts: new Date().toISOString(), outcome: controller.signal.aborted ? 'fenced' : 'failed' });
    throw new Error('Node runner failed or fenced');
  } finally {
    clearInterval(timer); clearTimeout(deadline);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    if (staged) { try { unlinkSync(staged); } catch { /* A failed cleanup never returns a completion. */ } }
  }
}
