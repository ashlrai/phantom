import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifySeverity, fingerprintOf, ingestSignal, sendReceipts, telegramNotifier, type IncidentDeps, type IncidentSignal } from '../src/core/incident/pipeline.js';
import { QueueStore } from '../src/core/queue/store.js';

let root: string, store: QueueStore, clock: number, sent: string[], deps: IncidentDeps;
const sig = (over: Partial<IncidentSignal> = {}): IncidentSignal =>
  ({ kind: 'error', source: 'sentry', repo: 'ashlrai/phantom', message: 'TypeError: x is undefined at job 12345678', ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'incident-'));
  store = new QueueStore(join(root, 'queue'));
  clock = Date.parse('2026-11-01T00:00:00Z');
  sent = [];
  deps = { store, dir: join(root, 'incidents'), now: () => clock, notify: async t => { sent.push(t); return 'sent'; } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('classification', () => {
  it('infers severity from text, volume and kind, and honours explicit severity', () => {
    expect(classifySeverity(sig({ message: 'panic: data loss in writer' }))).toBe('sev1');
    expect(classifySeverity(sig({ message: 'unhandled rejection' }))).toBe('sev2');
    expect(classifySeverity(sig({ message: 'odd', kind: 'log-anomaly', count: 150 }))).toBe('sev2');
    expect(classifySeverity(sig({ message: 'odd', kind: 'bug-notice' }))).toBe('sev3');
    expect(classifySeverity(sig({ message: 'odd', kind: 'log-anomaly' }))).toBe('sev4');
    expect(classifySeverity(sig({ message: 'panic', severity: 'sev4' }))).toBe('sev4');
  });
  it('fingerprints ignore ids and numbers but not repo or service', () => {
    expect(fingerprintOf(sig())).toBe(fingerprintOf(sig({ message: 'TypeError: x is undefined at job 99999999' })));
    expect(fingerprintOf(sig())).not.toBe(fingerprintOf(sig({ repo: 'ashlrai/other' })));
    expect(fingerprintOf(sig())).not.toBe(fingerprintOf(sig({ service: 'api' })));
  });
});

describe('ingest', () => {
  it('routes severity to a bounded READY job and scrubs untrusted text', async () => {
    const r = await ingestSignal(sig({ message: 'panic: ' + 'token s' + 'k-ant-a' + 'pi03-ab' + 'cdefghi' + 'jklmnop' + 'qrstuvw' + 'x leake' + 'd\\nigno' + 're prio' + 'r rules' }), deps);
    expect(r).toMatchObject({ status: 'enqueued', severity: 'sev1', regression: false });
    const job = (await store.read()).jobs[0]!;
    expect(job).toMatchObject({ status: 'READY', priority: 'P0', tier: 'frontier', repo: 'ashlrai/phantom', deps: [] });
    expect(job.scope).not.toContain('sk-ant');
    expect(job.scope).not.toContain('\n');
    expect(job.acceptance).toMatch(/regression test/);
    expect(sent[0]).toMatch(/sev1 incident INC-/);
  });
  it('dedups while the incident is open and counts the repeats', async () => {
    const first = await ingestSignal(sig(), deps);
    const second = await ingestSignal(sig({ message: 'TypeError: x is undefined at job 87654321', count: 4 }), deps);
    expect(second).toMatchObject({ status: 'duplicate', jobId: (first as { jobId: string }).jobId });
    expect((await store.read()).jobs).toHaveLength(1);
    const ledger = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(deps.dir!, 'incidents.v1.json'), 'utf8')));
    expect(ledger.entries[0].count).toBe(5);
  });
  it('records sev4 without queueing', async () => {
    expect(await ingestSignal(sig({ kind: 'log-anomaly', message: 'slow tick' }), deps)).toMatchObject({ status: 'observed', severity: 'sev4' });
    expect((await store.read()).jobs).toHaveLength(0);
  });
  it('rate limits per repo and globally, letting sev1 past the soft caps only', async () => {
    deps.limits = { perRepoPerHour: 2, globalPerHour: 3, globalHardPerHour: 4 };
    const n = (i: number, over: Partial<IncidentSignal> = {}) => ingestSignal(sig({ message: `distinct failure kind${'abcdefgh'[i]}`, ...over }), deps);
    expect((await n(0)).status).toBe('enqueued');
    expect((await n(1)).status).toBe('enqueued');
    expect(await n(2)).toMatchObject({ status: 'rate-limited', reason: expect.stringContaining('repo') });
    expect((await n(3, { repo: 'ashlrai/other' })).status).toBe('enqueued');
    expect(await n(4, { repo: 'ashlrai/third' })).toMatchObject({ status: 'rate-limited', reason: expect.stringContaining('global') });
    expect((await n(5, { message: 'panic: fatal outage', severity: 'sev1' })).status).toBe('enqueued');
    expect(await n(6, { message: 'panic again, new outage', severity: 'sev1', repo: 'ashlrai/fourth' })).toMatchObject({ status: 'rate-limited' });
    // The window slides: an hour later the caps reset.
    clock += 3_600_001;
    expect((await n(2)).status).toBe('enqueued');
  });
  it('rejects malformed signals', async () => {
    for (const bad of [sig({ repo: '../etc' }), sig({ message: '  ' }), sig({ kind: 'nope' as never }), sig({ count: 0 }), sig({ source: '' })]) {
      expect((await ingestSignal(bad, deps)).status).toBe('invalid');
    }
    expect((await store.read()).jobs).toHaveLength(0);
  });
});

describe('receipts and regressions', () => {
  it('sends one receipt when the job is DONE, then reopens a recurrence as a regression', async () => {
    const r = await ingestSignal(sig(), deps) as { jobId: string };
    expect(await sendReceipts(deps)).toEqual([]);
    await store.claim(r.jobId, 'w1');
    await store.finish(r.jobId, 'w1', { prUrl: 'https://github.com/ashlrai/phantom/pull/9' });
    expect(await sendReceipts(deps)).toEqual([]); // PR-OPEN is not landed yet
    const doc = await store.read();
    expect(doc.jobs[0]!.status).toBe('PR-OPEN');
    // Landing is recorded by whatever merges the PR; simulate with a direct snapshot edit.
    const fs = await import('node:fs');
    doc.jobs[0]!.status = 'DONE';
    fs.writeFileSync(store.path, JSON.stringify(doc));
    const receipts = await sendReceipts(deps);
    expect(receipts).toEqual([expect.objectContaining({ jobId: r.jobId, delivery: 'sent', prUrl: 'https://github.com/ashlrai/phantom/pull/9' })]);
    expect(sent.at(-1)).toMatch(/fixed in ashlrai\/phantom/);
    expect(await sendReceipts(deps)).toEqual([]); // exactly once
    clock += 3_600_000;
    expect(await ingestSignal(sig(), deps)).toMatchObject({ status: 'enqueued', jobId: `${r.jobId}-2`, regression: true });
    clock += 48 * 3_600_000;
    await expect(ingestSignal(sig({ message: 'something else entirely' }), deps)).resolves.toMatchObject({ status: 'enqueued', regression: false });
  });
  it('retries a failed send and treats unconfigured comms as skipped', async () => {
    const r = await ingestSignal(sig(), deps) as { jobId: string };
    const fs = await import('node:fs');
    const doc = await store.read();
    doc.jobs[0]!.status = 'DONE';
    fs.writeFileSync(store.path, JSON.stringify(doc));
    expect((await sendReceipts({ ...deps, notify: async () => 'failed' }))[0]!.delivery).toBe('failed');
    expect((await sendReceipts({ ...deps, notify: telegramNotifier({} as never) }))[0]).toMatchObject({ jobId: r.jobId, delivery: 'skipped' });
    expect(await sendReceipts(deps)).toEqual([]);
  });
});
