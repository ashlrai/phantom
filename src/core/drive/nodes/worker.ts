import { validNodeTask } from './task.js';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkDriveExecutable } from '../script-bridge.js';
import type { JobClaim } from './index.js';
import { probeLocalModelCaps, type LocalLaneProbeDeps } from './local-model-caps.js';
import { callPool, type PoolConfig } from './pool-host.js';
import { NODE_HEARTBEAT_MS, isHostStats, validId } from './state.js';
import { nodeRamSlots, readNodeCapacity, type NodeCapacity } from './capacity.js';
import { nodeBeatCapacity } from './capacity-sample.js';
import { hostSlots, type HostSlotLease } from './host-slots.js';
import { localPhmVersion, versionCap } from './phm-version.js';
import { lightRecipe, restockLight } from './light.js';
import { probeLocalAuth } from './auth-probe.js';
import { NODE_PROVIDERS, isNodeProvider, resolveProviderBinary, type NodeProvider, type ProviderBinaries, type ProviderBinaryDeps } from './provider-binary.js';
import { probeRunnerPacks } from './runner-packs.js';
import type { JobView } from './index.js';
import { sampleHostStats } from './capacity.js';

/** Exit-code-only sign-in check of each provider's one resolved absolute binary. No PATH lookup or auth-file reads. */
export function probeProviderBinaries(run: typeof spawnSync = spawnSync, binaryDeps: ProviderBinaryDeps = {}): ProviderBinaries {
  const statusArgs: Record<NodeProvider, string[]> = { codex: ['login', 'status'], claude: ['auth', 'status', '--json'] };
  const found: ProviderBinaries = {};
  for (const provider of NODE_PROVIDERS) {
    const binary = resolveProviderBinary(provider, binaryDeps);
    if (!binary) continue;
    const result = run(binary, statusArgs[provider], { timeout: 5000, stdio: 'ignore', shell: false,
      env: { PATH: process.env['PATH'], HOME: homedir() } });
    if (!result.error && result.status === 0) found[provider] = binary;
  }
  return found;
}

/** Native sign-in checks plus the local oMLX lane plan. No auth-file reads, API tokens or output retention. */
export function probeNodeLanes(run: typeof spawnSync = spawnSync, localDeps: LocalLaneProbeDeps = {}, binaryDeps: ProviderBinaryDeps = {}): string[] {
  // Local model caps are planned, not probed: enabled config + RAM class + live headroom.
  return [...Object.keys(probeProviderBinaries(run, binaryDeps)), ...probeLocalModelCaps(localDeps)];
}

/** Two consecutive error results for one pack decline that pack for the rest of the session. */
export const PACK_FAILURE_LIMIT = 2;
export type RunnerErrorReason = 'pack-error' | 'codex-error' | 'runner-exit-nonzero';

/** Classifies a closed runner reply. Fenced runs stay `stopped`; error replies are never completions. */
export function classifyRunnerReply(code: number | null, fenced: boolean, stdout: string):
  { kind: 'ok'; resultRef: string } | { kind: 'error'; reason: RunnerErrorReason } | { kind: 'stopped' } {
  if (fenced) return { kind: 'stopped' };
  let reply: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
  } catch { /* unstructured output is not a result */ }
  if (reply && reply['packError'] !== undefined && reply['packError'] !== null && reply['packError'] !== false) return { kind: 'error', reason: 'pack-error' };
  if (reply && reply['codex'] === 'error') return { kind: 'error', reason: 'codex-error' };
  if (code !== 0) return { kind: 'error', reason: 'runner-exit-nonzero' };
  return reply && validId(reply['resultRef']) ? { kind: 'ok', resultRef: reply['resultRef'] as string } : { kind: 'stopped' };
}

/** Missing sentinels mean open; unreadable/unsafe control paths hold admission. */
export function nodeStopped(): boolean {
  for (const name of ['PAUSE', 'KILL']) {
    try { lstatSync(join(homedir(), '.ashlr-runs', name)); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
  }
  return false;
}

/** Trusted host runner receives references, never arbitrary commands from queue records.
 * Runner must sandbox provider work and fence any effects; it cannot publish. Diagnostics are
 * discarded. Only a bounded result reference is returned to primary custody.
 */
export async function runNodeWorker(config: PoolConfig, runner: string, light = false): Promise<Record<string, unknown>> {
  await checkDriveExecutable(runner);
  if (nodeStopped()) return { held: 'host-paused' };
  if (light && (config.node !== 'muse' || config.owner !== 'ashlr')) return { held: 'light-owner-node-mismatch' };
  const capacityNow = () => readNodeCapacity(light);
  const capacity = capacityNow();
  if (capacity.held) return { held: capacity.held, capacity };
  const auth = light ? probeLocalAuth() : undefined;
  const binaries: ProviderBinaries = light ? {} : probeProviderBinaries();
  const lanes = light ? ['light', 'comms', ...(auth === 'ok' ? ['gh'] : [])] : [...Object.keys(binaries), ...probeLocalModelCaps()];
  // Consecutive error results per pack in this session; a success resets the pack.
  const packFailures = new Map<string, number>();
  if (!lanes.length) return { held: 'no-local-provider-login' };
  const runnerPacks = light ? [] : probeRunnerPacks(runner);
  const capabilities = [...lanes, ...runnerPacks];
  const joined = callPool(config, 'join', ['--node', config.node, '--caps', [...capabilities, versionCap(localPhmVersion())].filter(Boolean).join(','), '--slots', String(capacity.slots)]);
  const session = joined.result['session'];
  if (!Number.isSafeInteger(session)) return { held: 'node-already-live' };
  const identity = ['--node', config.node, '--session', String(session)];
  // Optional observation must never become a new heartbeat/admission gate.
  const telemetry = (): string[] => {
    try {
      const sample = sampleHostStats(), json = JSON.stringify(sample);
      return isHostStats(sample) && json.length <= 64 * 1024 ? ['--host-stats', json] : [];
    } catch { return []; }
  };
  let active = 0;
  // Router slots include this session's active claims, not just the host's free slots.
  // A lease this attempt already owns is counted in both terms, so it is subtracted once.
  const routerSlots = (observed: NodeCapacity, owned = 0) => observed.held ? 0 : Math.min(capacity.slots, active + observed.slots - owned);
  // The pool's capacity sample does not accept CPU or host-slot holds yet. Those beats omit the
  // sample, so the router shows this host as unknown instead of refusing the whole heartbeat.
  const capacityReport = (observed: NodeCapacity, slots: number) => {
    const report = nodeBeatCapacity({ ...observed, slots });
    return report.sample ? ['--capacity', JSON.stringify(report.sample)] : [];
  };
  const usage = () => String(Math.min(1000, Math.round(active / capacity.slots * 1000)));
  const attempt = async (): Promise<Record<string, unknown>> => {
    const admission = capacityNow();
    const advertised = routerSlots(admission);
    callPool(config, 'beat', [...identity, ...telemetry(), ...capacityReport(admission, advertised), '--usage', usage(), '--slots', String(advertised), ...(auth ? ['--auth', auth] : [])]);
    if (admission.held) return { held: admission.held };
    let hostLease: HostSlotLease | null;
    try { hostLease = hostSlots().acquire(nodeRamSlots(admission.ramBytes)); }
    catch { return { slots: 0, held: 'host-slots-unmeasured' }; }
    if (!hostLease) return { slots: 0, held: 'host-slots-exhausted' };
    try { return await runAttempt(hostLease); }
    finally { hostLease.release(); }
  };
  const runAttempt = async (hostLease: HostSlotLease): Promise<Record<string, unknown>> => {
    const pulled = callPool(config, 'pull', identity);
    if (pulled.demoted || !pulled.result['pulled']) return { pulled: false };
    const claim = pulled.result['claim'] as JobClaim;
    const job = pulled.result['job'] as JobView;
    const jobCapacity = () => readNodeCapacity(light, { ...(job.pack ? { pack: job.pack } : {}), lease: hostLease });
    const lease = [...identity, '--job', claim.jobId, '--token', String(claim.token), '--leader-token', String(claim.leaderToken)];
    // A claim we will not run is handed back at once; stranding it until expiry shows the job
    // as running while nothing executes. Only a permanent inability (`decline`) bars this session from
    // the job; transient holds (capacity, stop, lease-lost) leave it retryable. Best effort: an older
    // primary without `release` just expires.
    const refuse = (held: string, decline: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> => {
      let released = false;
      try { released = callPool(config, 'release', decline ? [...lease, '--decline'] : lease).result['released'] === true; } catch { /* expiry fences it */ }
      return { held, ...extra, released };
    };
    if (job?.task !== undefined && (job.pack !== 'codex-file' || !validNodeTask(job.task))) return refuse('invalid-task', true);
    if (!validId(job?.id) || !Array.isArray(job.requires) || !job.requires.some(c => lanes.includes(c)) ||
        job.requires.some(c => !capabilities.includes(c)) || job.secrets.length || (light && !lightRecipe(job))) return refuse('unsupported-job', true);
    // A stopping node cannot run anything right now, but another session or a restart can: retryable.
    if (nodeStopped()) return refuse('unsupported-job', false);
    const packCapacity = jobCapacity();
    if (packCapacity.held) return refuse(packCapacity.held, false, { capacity: packCapacity });
    // Check immediately before spawn as well as throughout execution.
    const renewed = callPool(config, 'renew', lease);
    if (!renewed.result['expiresAt'] || renewed.demoted || jobCapacity().held) return refuse('lease-lost', false);
    const packKey = typeof job.pack === 'string' && job.pack ? job.pack : `job:${job.id}`;
    if ((packFailures.get(packKey) ?? 0) >= PACK_FAILURE_LIMIT) return refuse('pack-declined', true, { reason: 'pack-declined' });
    // Lane receipt: the exact absolute binary the probe signed in with, never a command.
    const providerBinaries = Object.fromEntries(job.requires.filter(isNodeProvider)
      .flatMap(provider => binaries[provider] ? [[provider, binaries[provider]]] : []));
    const reply = await new Promise<ReturnType<typeof classifyRunnerReply>>(resolve => {
      const child = spawn(runner, ['run'], { shell: false, detached: true,
        env: { PATH: process.env['PATH'], HOME: homedir() }, stdio: ['pipe', 'pipe', 'ignore'] });
      active++;
      let fenced = false;
      const output: Buffer[] = [];
      let bytes = 0;
      const stop = () => {
        fenced = true;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { child.kill('SIGKILL'); }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) stop();
        else output.push(chunk);
      });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      const timer = setInterval(() => {
        try {
          if (nodeStopped()) return stop();
          const observed = jobCapacity();
          if (observed.held) stop();
          const slots = routerSlots(observed, 1);
          callPool(config, 'beat', [...identity, ...telemetry(), ...capacityReport(observed, slots), '--usage', usage(), '--slots', String(slots)]);
          if (observed.held) return;
          const current = callPool(config, 'renew', lease);
          if (current.demoted || !current.result['expiresAt']) stop();
        } catch { stop(); }
      }, NODE_HEARTBEAT_MS);
      const deadline = setTimeout(stop, 30 * 60_000);
      child.on('error', () => { fenced = true; });
      child.stdin.on('error', stop);
      child.on('close', code => {
        clearInterval(timer); clearTimeout(deadline);
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        resolve(classifyRunnerReply(code, fenced, Buffer.concat(output).toString('utf8')));
      });
      try { child.stdin.end(JSON.stringify({ protocol: 'phm-node-worker/v1', job: pulled.result['job'], claim,
        ...(Object.keys(providerBinaries).length ? { providerBinaries } : {}) })); }
      catch { stop(); } // Retain the host slot until close even if writing stdin fails synchronously.
    });
    active--;
    if (reply.kind === 'stopped') return { completed: false, held: 'runner-stopped' };
    if (reply.kind === 'error') {
      // An error result returns the job to pending; the second consecutive failure hands it to another node.
      const failures = (packFailures.get(packKey) ?? 0) + 1;
      packFailures.set(packKey, failures);
      const decline = failures >= PACK_FAILURE_LIMIT;
      return { jobId: claim.jobId, completed: false, ...refuse('runner-error', decline, { reason: reply.reason, pack: packKey, failures }), declined: decline };
    }
    packFailures.delete(packKey);
    const completed = callPool(config, 'complete', [...lease, '--result', reply.resultRef]);
    return { jobId: claim.jobId, completed: completed.result['completed'] === true };
  };
  try {
    // A short light batch may finish between restock ticks. Fill its isolated slice
    // after joining too, so recurring workers do not depend on that race.
    if (light) restockLight((verb, args) => {
      const reply = callPool(config, verb, args);
      if (reply.demoted) throw new Error('Node admission demoted');
      return reply.result;
    }, true);
    // Keep one fenced node session until every slot settles; never leave while a sibling runs.
    // A retryable runner error gets one more pull in this session, so a repeat failure can decline.
    const slot = async (): Promise<Record<string, unknown>> => {
      const first = await attempt();
      if (first['held'] !== 'runner-error' || first['declined'] === true || first['released'] !== true) return first;
      return { ...await attempt(), previous: first };
    };
    const settled = await Promise.allSettled(Array.from({ length: capacity.slots }, () => slot()));
    const attempts = settled.map(result => result.status === 'fulfilled' ? result.value : { held: 'attempt-unavailable' });
    return attempts.length === 1 ? attempts[0]! : { slots: capacity.slots, attempts };
  } finally {
    try { callPool(config, 'leave', identity); } catch { /* expiry fences uncertain sessions */ }
  }
}
