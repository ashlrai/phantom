/** Real private-file commits and real lease custody; the fixed worker is a controlled transport. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const transport = vi.hoisted(() => ({ workers: [] as Array<{ emit(event: string, value?: unknown): boolean;
  messages: Array<{ id: number; owner: unknown; startedAt: number; snapshot: { evidence: unknown; state: string } }>;
  terminate: ReturnType<typeof vi.fn> }> }));
vi.mock('node:worker_threads', async original => {
  const actual = await original<typeof import('node:worker_threads')>();
  const { EventEmitter } = await import('node:events');
  return { ...actual, Worker: class extends EventEmitter {
    messages: typeof transport.workers[number]['messages'] = [];
    terminate = vi.fn(async () => { this.emit('exit', 0); return 0; });
    constructor() { super(); transport.workers.push(this); }
    postMessage(value: typeof this.messages[number]) { this.messages.push(value); }
  } };
});
import { independentCommissioningFixture, saveIndependentJson } from './support/pool-commissioning-independent-fixture.js';
import { checkResourcePoolCommissioning, applyResourcePoolCommissioning } from '../src/core/resources/pool-commissioning.js';
import { createQuotaEvidencePublisher, type QuotaEvidencePublisher } from '../src/core/resources/quota-evidence-background.js';
import { acquireResourceQuotaRefreshLease, type ResourceQuotaRefreshLease } from '../src/core/resources/quota-refresh-lease.js';
import { captureQuotaEvidenceRejectPins } from '../src/core/resources/quota-evidence-pins.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { prepareSharedQuotaEvidence, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME } from '../src/core/resources/quota-shared-evidence.js';
let root: string, lease: ResourceQuotaRefreshLease, publisher: QuotaEvidencePublisher | undefined;
let current = true;
const fault = vi.fn();
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-worker-'))); chmodSync(root, 0o700);
  current = true; lease = await acquireResourceQuotaRefreshLease(root); lease.markPending();
});
afterEach(async () => { vi.restoreAllMocks(); await publisher?.close().catch(() => {}); publisher = undefined;
  lease.close(); rmSync(root, { recursive: true, force: true }); transport.workers.splice(0); fault.mockClear(); });
function fixture() {
  const pool = { schemaVersion: 1 as const, id: 'background-quota', workers: ['codex-a'].map(id => ({ id, provider: 'codex' as const,
    model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 60000, priority: 1, reservePercent: 25, allowUnknownQuota: false })) };
  const bindings = [{ workerId: 'codex-a', capacityKey: 'codex-a', kind: 'native-cli' as const, command: ['/test-owned/codex-a'] }];
  const config = { schemaVersion: 1 as const, poolDigest: digest(canonical({ pool, bindings })), workers: [{ workerId: 'codex-a', accountHint: 'a'.repeat(64), bucketIds: ['codex'] }] };
  const now = Date.now(), time = (n: number) => new Date(n).toISOString();
  const snapshot = { state: 'running' as const, evidence: { observations: [{ workerId: 'codex-a', observedAt: time(now), updatedAt: time(now),
    expiresAt: time(now + 60000), health: 'ready' as const, retryAfter: null,
    windows: [{ id: 'codex_codex_primary', usedPercent: 20, resetsAt: time(now + 3600000) }] }], unavailableWorkerIds: [] as string[] } };
  const scope = { root, pool, bindings, config };
  publisher = createQuotaEvidencePublisher({ scope, lease, isCurrent: () => current, onFault: fault });
  const worker = transport.workers.at(-1)!;
  worker.emit('message', { type: 'ready' });
  let rpcId = 0;
  const commit = (job: typeof worker.messages[number], evidence = prepareSharedQuotaEvidence({ ...scope, evidence: job.snapshot.evidence as typeof snapshot.evidence, now: job.startedAt }), pins = captureQuotaEvidenceRejectPins(scope)) => {
    const id = ++rpcId, response = new SharedArrayBuffer(16 + 256 * 1024), header = new Int32Array(response, 0, 4); header[2] = id;
    worker.emit('message', { type: 'engineering-host-call', id, method: 'quota.commit', inputJson: JSON.stringify({ id: job.id, evidence, pins }), response });
    return JSON.parse(Buffer.from(response, 16, header[1]).toString()) as { ok: boolean; value?: unknown };
  };
  const reply = (job: typeof worker.messages[number]) => worker.emit('message', { type: 'result', id: job.id, ok: true });
  return { snapshot, scope, worker, commit, reply, file: join(root, RESOURCE_SHARED_QUOTA_EVIDENCE_FILENAME) };
}
describe.skipIf(process.platform === 'win32')('fixed quota publication worker custody', () => {
  it('commits fresh prepared data once on the real host and retains original expiry', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    expect(f.commit(job)).toEqual({ ok: true, value: true });
    expect(f.commit(job).ok).toBe(false); f.reply(job); expect(await pending).toBe(true);
    const record = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(record.observations).toEqual(f.snapshot.evidence.observations);
    expect(Date.parse(record.publishedAt)).toBe(job.startedAt);
    expect(Date.parse(record.expiresAt) - job.startedAt).toBe(5000);
  });
  it('refuses close AFTER fresh preparation but BEFORE the commit RPC', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    const prepared = prepareSharedQuotaEvidence({ ...f.scope, evidence: f.snapshot.evidence, now: job.startedAt });
    await publisher!.close();
    expect(f.commit(job, prepared).ok).toBe(false); expect(await pending).toBe(false);
    expect(existsSync(f.file)).toBe(false); lease.assertOwnership();
  });
  it('refuses generation revocation between preparation and commit', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    current = false; expect(f.commit(job).ok).toBe(false); expect(existsSync(f.file)).toBe(false);
    await publisher!.close(); expect(await pending).toBe(false);
  });
  it('does not relabel a 5000ms expired preparation as a fresh heartbeat', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    const prepared = prepareSharedQuotaEvidence({ ...f.scope, evidence: f.snapshot.evidence, now: job.startedAt });
    vi.spyOn(Date, 'now').mockReturnValue(job.startedAt + 5000);
    expect(f.commit(job, prepared).ok).toBe(false); expect(existsSync(f.file)).toBe(false);
    await publisher!.close(); expect(await pending).toBe(false);
  });
  it('retains only one active and latest snapshot, with no second validation in flight', async () => {
    const f = fixture(); const a = publisher!.publish(f.snapshot), b = publisher!.publish(f.snapshot), c = publisher!.publish(f.snapshot);
    expect(await b).toBe(false); expect(f.worker.messages).toHaveLength(1);
    const first = f.worker.messages[0]!; expect(f.commit(first).ok).toBe(true); f.reply(first); expect(await a).toBe(true);
    expect(f.worker.messages).toHaveLength(2); const last = f.worker.messages[1]!;
    expect(f.commit(last).ok).toBe(true); f.reply(last); expect(await c).toBe(true);
  });
  it('refuses a newly unsafe target without touching its sentinel', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    symlinkSync('/test-owned/sentinel', f.file); expect(f.commit(job).ok).toBe(false);
    await publisher!.close(); expect(await pending).toBe(false);
  });
  it('rejects protected input mutation after preparation rather than reusing its proof', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot), job = f.worker.messages[0]!;
    const pins = captureQuotaEvidenceRejectPins(f.scope);
    const prepared = prepareSharedQuotaEvidence({ ...f.scope, evidence: f.snapshot.evidence, now: job.startedAt });
    writeFileSync(join(root, 'resource-console-state.json'), '{}', { mode: 0o600 });
    expect(f.commit(job, prepared, pins).ok).toBe(false); expect(existsSync(f.file)).toBe(false);
    await publisher!.close(); expect(await pending).toBe(false);
  });
  it('bounds startup and faults an unready worker without a replacement', async () => {
    const f = fixture(); await publisher!.close(); publisher = undefined;
    vi.useFakeTimers();
    try {
      publisher = createQuotaEvidencePublisher({ scope: f.scope, lease, isCurrent: () => true, onFault: fault });
      const pending = publisher.publish(f.snapshot), rejected = expect(pending).rejects.toThrow('publication unavailable');
      await vi.advanceTimersByTimeAsync(5000); await rejected;
      expect(fault).toHaveBeenCalledOnce(); expect(transport.workers).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it('coalesces a thousand repeated observations into one active and latest job', async () => {
    const f = fixture(); const pending = Array.from({ length: 1000 }, () => publisher!.publish(f.snapshot));
    expect(f.worker.messages).toHaveLength(1); expect((await Promise.all(pending.slice(1, -1))).every(result => !result)).toBe(true);
    const first = f.worker.messages[0]!; expect(f.commit(first).ok).toBe(true); f.reply(first); expect(await pending[0]).toBe(true);
    expect(f.worker.messages).toHaveLength(2); const last = f.worker.messages[1]!;
    expect(f.commit(last).ok).toBe(true); f.reply(last); expect(await pending.at(-1)).toBe(true);
    expect(transport.workers).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.file, 'utf8')).observations).toHaveLength(1);
  });
  it('pins actual commissioned profile/auth metadata without replacing fresh native custody', () => {
    const f = independentCommissioningFixture();
    try {
      const plan = checkResourcePoolCommissioning(f.request);
      applyResourcePoolCommissioning({ ...f.request, expectedPlanDigest: plan.planDigest });
      const scope = { root: f.root, pool: f.currentPool(), bindings: f.currentBindings(), config: f.currentQuota() };
      const evidence = { observations: [], unavailableWorkerIds: [] };
      expect(() => prepareSharedQuotaEvidence({ ...scope, evidence, now: Date.now() })).not.toThrow();
      const before = captureQuotaEvidenceRejectPins(scope);
      const auth = join(f.personal.nativeStatePath, 'auth.json');
      saveIndependentJson(auth, { secret: 'PRIVATE_SENTINEL_MUST_NOT_BE_READ' });
      const after = captureQuotaEvidenceRejectPins(scope);
      expect(after).not.toEqual(before); expect(canonical(after)).not.toContain('PRIVATE_SENTINEL_MUST_NOT_BE_READ');
      const launcher = readFileSync(f.personal.launcherPath);
      writeFileSync(f.personal.launcherPath, Buffer.concat([launcher, Buffer.from('\n// modified profile\n')]), { mode: 0o600 });
      expect(captureQuotaEvidenceRejectPins(scope)).not.toEqual(after);
      expect(() => prepareSharedQuotaEvidence({ ...scope, evidence, now: Date.now() })).toThrow();
      expect(existsSync(f.invoked)).toBe(false);
    } finally { f.cleanup(); }
  });
  it('latches a worker fault and never automatically starts another worker', async () => {
    const f = fixture(), pending = publisher!.publish(f.snapshot); const rejection = expect(pending).rejects.toThrow('publication unavailable');
    f.worker.emit('error', new Error('controlled failure')); await rejection;
    expect(fault).toHaveBeenCalledOnce(); expect(transport.workers).toHaveLength(1);
    await expect(publisher!.publish(f.snapshot)).rejects.toThrow('publication unavailable');
  });
});
