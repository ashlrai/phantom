import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readVerifiedCompletion,
  summarizeAgentActivity,
  summarizeVerifiedCompletion,
  type VerifiedCompletionReport,
} from '../src/core/fleet/agent-activity.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const now = Date.parse('2026-11-08T12:00:00Z');
const at = (h: number, m = 0) => new Date(Date.parse('2026-11-08T00:00:00Z') + h * 3_600_000 + m * 60_000).toISOString();
const row = (event: string, job: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event, job, ts, ...extra });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ledgerFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'verified-completion-')); dirs.push(dir);
  const path = join(dir, 'jobs.jsonl'); writeFileSync(path, text); return path;
};
const PR = (n: number, repo = 'ashlrai/phantom') => `https://github.com/${repo}/pull/${n}`;

const launch = (job: string, ts: string, extra: Record<string, unknown> = {}) =>
  row('launch', job, ts, { repo: 'phantom', lane: 'devin', tier: 'work', ...extra });
const finish = (job: string, ts: string, extra: Record<string, unknown> = {}) =>
  row('finish', job, ts, { lane: 'devin', exit_code: 0, empty: false, ...extra });
const publish = (job: string, ts: string, url: string, extra: Record<string, unknown> = {}) =>
  row('publish', job, ts, { url, lane: 'devin', ...extra });
const resolve = (job: string, ts: string, state: string, url?: string) =>
  row(state === 'PUBLISHED' ? 'publish' : 'outcome', job, ts, url ? { outcome: state, url } : { outcome: state });

describe('summarizeVerifiedCompletion', () => {
  it('counts a published PR resolved MERGED as verified, not merely reported', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-A-1', at(1)),
      finish('RQ-A-1', at(2)),
      publish('RQ-A-1', at(2, 10), PR(11)),
      resolve('RQ-A-1', at(3), 'MERGED', PR(11)),
    ].join('\n'), now);
    expect(report.eligible).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.pending).toBe(0);
    expect(report.rate).toBe(1);
    expect(report.claims.published).toBe(1);
    expect(report.falseCompletions).toBe(0);
  });

  it('a publish with no reconciled outcome stays pending — publish alone is not verified', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-B-1', at(1)), finish('RQ-B-1', at(2)), publish('RQ-B-1', at(2, 10), PR(12)),
    ].join('\n'), now);
    expect(report.eligible).toBe(1);
    expect(report.pending).toBe(1);
    expect(report.rate).toBeNull();
  });

  it('a published PR resolved CLOSED is a false completion', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-C-1', at(1)), finish('RQ-C-1', at(2)), publish('RQ-C-1', at(2, 10), PR(13)),
      resolve('RQ-C-1', at(3), 'CLOSED', PR(13)),
    ].join('\n'), now);
    expect(report.failed).toBe(1);
    expect(report.falseCompletions).toBe(1);
    expect(report.rate).toBe(0);
    expect(report.detail.falseCompletionJobs).toEqual(['RQ-C-1']);
  });

  it('reconciler rows keep event=publish with outcome MERGED/CLOSED and still resolve', () => {
    // metrics-outcomes copies the publish row and sets outcome + github ts.
    const report = summarizeVerifiedCompletion([
      launch('RQ-D-1', at(1)), finish('RQ-D-1', at(2)), publish('RQ-D-1', at(2, 10), PR(14)),
      row('publish', 'RQ-D-1', at(30), { url: PR(14), outcome: 'MERGED', lane: 'devin' }),
    ].join('\n'), now);
    expect(report.verified).toBe(1);
    expect(report.pending).toBe(0);
  });

  it('eventless producer + reconciler rows (jobId/prUrl/outcome) still form and resolve claims', () => {
    // The real publish producer writes {jobId, prUrl, outcome:'PUBLISHED'} with
    // no event field; metrics-outcomes copies it with outcome MERGED/CLOSED.
    const report = summarizeVerifiedCompletion([
      JSON.stringify({ jobId: 'RQ-P-1', prUrl: PR(40), outcome: 'PUBLISHED', ts: at(2), lane: 'devin', repo: 'phantom' }),
      JSON.stringify({ jobId: 'RQ-P-1', prUrl: PR(40), outcome: 'MERGED', ts: at(3),
                       mergedAt: at(3), source: 'metrics-outcomes-reconciler' }),
      JSON.stringify({ jobId: 'RQ-P-2', prUrl: PR(41), outcome: 'PUBLISHED', ts: at(2), lane: 'devin' }),
      JSON.stringify({ jobId: 'RQ-P-2', prUrl: PR(41), outcome: 'CLOSED', ts: at(3),
                       closedAt: at(3), source: 'metrics-outcomes-reconciler' }),
    ].join('\n'), now);
    expect(report.eligible).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.rate).toBe(0.5);
    expect(report.claims.published).toBe(2);
  });

  it('event:published normalizes to a publish claim', () => {
    const report = summarizeVerifiedCompletion([
      row('published', 'RQ-Q-1', at(1), { prUrl: PR(42) }),
      row('outcome', 'RQ-Q-1', at(2), { outcome: 'MERGED', url: PR(42) }),
    ].join('\n'), now);
    expect(report.eligible).toBe(1);
    expect(report.verified).toBe(1);
  });

  it('mixed outcomes: MERGED wins over a CLOSED sibling PR on the same attempt', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-E-1', at(1)), finish('RQ-E-1', at(2)),
      publish('RQ-E-1', at(2, 10), PR(15)), publish('RQ-E-1', at(2, 20), PR(16)),
      resolve('RQ-E-1', at(3), 'CLOSED', PR(15)), resolve('RQ-E-1', at(4), 'MERGED', PR(16)),
    ].join('\n'), now);
    expect(report.verified).toBe(1);
    expect(report.duplicates.multiPrJobs).toBe(1);
    expect(report.detail.multiPrJobs).toEqual(['RQ-E-1']);
  });

  it('a closed sibling with another PR still open stays pending', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-F-1', at(1)), finish('RQ-F-1', at(2)),
      publish('RQ-F-1', at(2, 10), PR(17)), publish('RQ-F-1', at(2, 20), PR(18)),
      resolve('RQ-F-1', at(3), 'CLOSED', PR(17)),
    ].join('\n'), now);
    expect(report.pending).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('batch member done claims verify through the batch session PR', () => {
    const report = summarizeVerifiedCompletion([
      row('batch_claim', 'RQ-M-1', at(1), { batch: 'RQ-BATCH-phantom-x-1', repo: 'phantom', lane: 'devin', tier: 'work' }),
      row('task_outcome', 'RQ-M-1', at(2), { batch: 'RQ-BATCH-phantom-x-1', lane: 'devin', repo: 'phantom', outcome: 'done' }),
      launch('RQ-BATCH-phantom-x-1', at(1, 30)), finish('RQ-BATCH-phantom-x-1', at(2, 30), { batch_size: 3 }),
      publish('RQ-BATCH-phantom-x-1', at(3), PR(20)),
      resolve('RQ-BATCH-phantom-x-1', at(4), 'MERGED', PR(20)),
    ].join('\n'), now);
    expect(report.claims.batchMembers).toBe(1);
    // the batch session itself is infrastructure: no published claim for it
    expect(report.claims.published).toBe(0);
    expect(report.eligible).toBe(1);
    expect(report.verified).toBe(1);
    expect(report.byLane.devin).toEqual({ eligible: 1, verified: 1, failed: 0, pending: 0 });
  });

  it('batch member done with a CLOSED batch PR is a false completion', () => {
    const report = summarizeVerifiedCompletion([
      row('batch_claim', 'RQ-M-2', at(1), { batch: 'RQ-BATCH-phantom-x-2', repo: 'phantom', lane: 'devin' }),
      row('task_outcome', 'RQ-M-2', at(2), { batch: 'RQ-BATCH-phantom-x-2', lane: 'devin', outcome: 'done' }),
      launch('RQ-BATCH-phantom-x-2', at(1, 30)), publish('RQ-BATCH-phantom-x-2', at(3), PR(21)),
      resolve('RQ-BATCH-phantom-x-2', at(4), 'CLOSED', PR(21)),
    ].join('\n'), now);
    expect(report.failed).toBe(1);
    expect(report.falseCompletions).toBe(1);
  });

  it('batch member done before the batch publishes stays pending', () => {
    const report = summarizeVerifiedCompletion([
      row('batch_claim', 'RQ-M-3', at(1), { batch: 'RQ-BATCH-phantom-x-3', repo: 'phantom', lane: 'devin' }),
      row('task_outcome', 'RQ-M-3', at(2), { batch: 'RQ-BATCH-phantom-x-3', lane: 'devin', outcome: 'done' }),
    ].join('\n'), now);
    expect(report.pending).toBe(1);
    expect(report.rate).toBeNull();
  });

  it('non-done task outcomes are not completion claims', () => {
    const report = summarizeVerifiedCompletion([
      row('batch_claim', 'RQ-M-4', at(1), { batch: 'RQ-BATCH-phantom-x-4', repo: 'phantom', lane: 'devin' }),
      row('task_outcome', 'RQ-M-4', at(2), { batch: 'RQ-BATCH-phantom-x-4', lane: 'devin', outcome: 'failed' }),
      row('task_outcome', 'RQ-M-5', at(2), { batch: 'RQ-BATCH-phantom-x-4', repo: 'phantom', lane: 'devin', outcome: 'skipped' }),
    ].join('\n'), now);
    expect(report.eligible).toBe(0);
    expect(report.claims.batchMembers).toBe(0);
  });

  it('two jobs publishing the same PR url is a shared-url duplicate', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-G-1', at(1)), publish('RQ-G-1', at(2), PR(22)),
      launch('RQ-G-2', at(1, 30)), publish('RQ-G-2', at(2, 30), PR(22)),
      resolve('RQ-G-1', at(3), 'MERGED', PR(22)),
    ].join('\n'), now);
    expect(report.duplicates.sharedPrUrls).toBe(1);
    expect(report.duplicates.multiPrJobs).toBe(0);
    // both claims verify — the PR did merge — but the duplication is flagged
    expect(report.verified).toBe(2);
  });

  it('a publish to a repo other than the routed repo is unauthorized', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-H-1', at(1), { repo: 'phantom' }), publish('RQ-H-1', at(2), PR(23, 'ashlrai/lexicon')),
      launch('RQ-H-2', at(1, 30), { repo: 'ashlrai/phantom' }), publish('RQ-H-2', at(2, 30), PR(24, 'evil/phantom')),
      launch('RQ-H-3', at(2), { repo: 'phantom' }), publish('RQ-H-3', at(3), PR(25)),
    ].join('\n'), now);
    // H-1: routed 'phantom' vs 'ashlrai/lexicon' -> basename 'lexicon' != 'phantom' -> unauthorized
    // H-2: routed 'ashlrai/phantom' vs 'evil/phantom' -> owner mismatch -> unauthorized
    // H-3: routed 'phantom' vs 'ashlrai/phantom' -> basename match -> authorized
    expect(report.unauthorizedActions).toBe(2);
    expect(report.detail.unauthorizedJobs.sort()).toEqual(['RQ-H-1', 'RQ-H-2']);
  });

  it('a finished non-empty job with no publish is completed-but-unpublished, not eligible', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-I-1', at(1)), finish('RQ-I-1', at(2)),
      launch('RQ-I-2', at(1)), finish('RQ-I-2', at(2), { empty: true }),
      launch('RQ-I-3', at(1)), finish('RQ-I-3', at(2), { exit_code: 1 }),
    ].join('\n'), now);
    expect(report.eligible).toBe(0);
    expect(report.completedUnpublished).toBe(1);
  });

  it('a bare outcome row with no publish is an outcome claim', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-J-1', at(1)), row('outcome', 'RQ-J-1', at(2), { outcome: 'MERGED' }),
      launch('RQ-J-2', at(1)), row('outcome', 'RQ-J-2', at(2), { outcome: 'CLOSED' }),
    ].join('\n'), now);
    expect(report.claims.outcomes).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.failed).toBe(1);
  });

  it('claims outside the window do not count', () => {
    const old = new Date(now - 2 * 3_600_000).toISOString();
    const report = summarizeVerifiedCompletion([
      launch('RQ-K-1', old), finish('RQ-K-1', old), publish('RQ-K-1', old, PR(30)),
      resolve('RQ-K-1', old, 'MERGED', PR(30)),
    ].join('\n'), now, { windowMs: 3_600_000 });
    expect(report.eligible).toBe(0);
    expect(report.verified).toBe(0);
    expect(report.rate).toBeNull();
  });

  it('a retry attempt is a separate claim: old CLOSED publish fails, new MERGED publish verifies', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-L-1', at(1)), finish('RQ-L-1', at(2)), publish('RQ-L-1', at(2, 10), PR(26)),
      resolve('RQ-L-1', at(3), 'CLOSED', PR(26)),
      launch('RQ-L-1', at(5)), finish('RQ-L-1', at(6)), publish('RQ-L-1', at(6, 10), PR(27)),
      resolve('RQ-L-1', at(7), 'MERGED', PR(27)),
    ].join('\n'), now);
    expect(report.eligible).toBe(2);
    expect(report.verified).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.rate).toBe(0.5);
    expect(report.falseCompletions).toBe(1);
  });

  it('a stale outcome stamped before a requeue cannot close the new attempt', () => {
    const report = summarizeVerifiedCompletion([
      launch('RQ-N-1', at(1)), finish('RQ-N-1', at(2)), publish('RQ-N-1', at(2, 10), PR(28)),
      row('enqueue', 'RQ-N-1', at(8)),           // requeue boundary
      resolve('RQ-N-1', at(3), 'CLOSED', PR(28)), // github ts inside window but stamped pre-requeue
      launch('RQ-N-1', at(9)), publish('RQ-N-1', at(9, 10), PR(29)),
    ].join('\n'), now);
    // attempt 1 claim: PR(28) resolved CLOSED -> failed; attempt 2 claim: PR(29) pending
    expect(report.eligible).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.pending).toBe(1);
  });
});

describe('readVerifiedCompletion / AgentActivityReport.verified', () => {
  it('reads a real ledger file and reports healthy with the metric', async () => {
    const text = [
      launch('RQ-A-1', at(1)), finish('RQ-A-1', at(2)), publish('RQ-A-1', at(2, 10), PR(11)),
      resolve('RQ-A-1', at(3), 'MERGED', PR(11)),
    ].join('\n');
    const report = await readVerifiedCompletion({ jobsPath: ledgerFile(text), now: () => now });
    expect(report.v).toBe(1);
    expect(report.schema).toBe('fleet.verified-completion.v1');
    expect(report.sourceState).toBe('healthy');
    expect(report.verified).toBe(1);
    expect(report.rate).toBe(1);
    expect(report.windowMs).toBe(24 * 3_600_000);
  });

  it('reports missing for an absent ledger and degraded for malformed rows', async () => {
    const missing = await readVerifiedCompletion({ jobsPath: join(tmpdir(), 'no-such-ledger-vc', 'jobs.jsonl'), now: () => now });
    expect(missing.sourceState).toBe('missing');
    expect(missing.eligible).toBe(0);
    const degraded = await readVerifiedCompletion({ jobsPath: ledgerFile('garbage\n' + 'x'), now: () => now });
    expect(degraded.sourceState).toBe('degraded');
    expect(degraded.dropped).toBeGreaterThan(0);
  });

  it('AgentActivityReport carries the same verified block', async () => {
    const text = [
      launch('RQ-A-1', at(1)), finish('RQ-A-1', at(2)), publish('RQ-A-1', at(2, 10), PR(11)),
      resolve('RQ-A-1', at(3), 'MERGED', PR(11)),
    ].join('\n');
    const { verified } = summarizeAgentActivity(text, now);
    expect(verified.schema).toBe('fleet.verified-completion.v1');
    expect(verified.verified).toBe(1);
    expect(verified.windowMs).toBe(24 * 3_600_000);
  });
});

describe('GET /api/fleet/verified-completion', () => {
  const handles: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const h of handles.splice(0)) { try { await h.close(); } catch { /* ignore */ } }
    rmSync(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), { force: true });
  });

  function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        { hostname: parsed.hostname, port, path: parsed.pathname + parsed.search, method: 'GET',
          headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) } },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves the verified-completion report from the isolated runs ledger', async () => {
    const recent = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    const metricsDir = join(homedir(), '.ashlr-runs', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(join(metricsDir, 'jobs.jsonl'), [
      launch('RQ-A-1', recent(3_600_000)), finish('RQ-A-1', recent(3_500_000)),
      publish('RQ-A-1', recent(3_400_000), PR(11)), resolve('RQ-A-1', recent(3_300_000), 'MERGED', PR(11)),
    ].join('\n') + '\n');
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    handles.push(h);
    const res = await get(`${h.url}/api/fleet/verified-completion`, h.port);
    expect(res.statusCode).toBe(200);
    const report = JSON.parse(res.body) as VerifiedCompletionReport;
    expect(report.schema).toBe('fleet.verified-completion.v1');
    expect(report.sourceState).toBe('healthy');
    expect(report.verified).toBe(1);
    expect(report.rate).toBe(1);
  });

  it('caps the hours window and reports missing for an absent ledger', async () => {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    handles.push(h);
    const capped = await get(`${h.url}/api/fleet/verified-completion?hours=9999`, h.port);
    expect(capped.statusCode).toBe(200);
    const report = JSON.parse(capped.body) as VerifiedCompletionReport;
    expect(report.windowMs).toBe(168 * 3_600_000);
    expect(report.sourceState).toBe('missing');
    expect(report.eligible).toBe(0);
    expect(report.rate).toBeNull();
  });
});
