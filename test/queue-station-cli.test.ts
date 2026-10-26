import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRouterQueue, type QueueCliDeps } from '../src/cli/router-queue.js';
import { QUEUE_STATIONS } from '../src/core/observability/router-queue.js';
import { readStationEvents } from '../src/core/observability/router-queue-store.js';
import type { QueueGh } from '../src/core/observability/router-queue-github.js';

const NOW = '2026-10-26T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const JOB = { jobId: 'RQ-QUEUE-2', repo: 'ashlrai/phantom', attempt: 'claim-1' };
const RECEIPT = { ...JOB, publishedAt: NOW, pr: 42, headSha: HEAD };
let directory: string;
let journal: string;
function file(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
async function invoke(args: string[], deps: QueueCliDeps = {}) {
  const output: string[] = []; const errors: string[] = [];
  const code = await cmdRouterQueue(args, { now: () => new Date(NOW), ...deps, write: text => { output.push(text); }, error: text => { errors.push(text); } });
  return { code, output: output.join(''), errors: errors.join('') };
}
function statusArgs(requireComplete = false): string[] {
  return ['status', '--job', JOB.jobId, '--repo', JOB.repo, '--attempt', JOB.attempt, '--journal', journal,
    ...(requireComplete ? ['--require-complete'] : [])];
}
function provider(merged: boolean): NonNullable<QueueCliDeps['github']> {
  const gh: QueueGh = async args => {
    let value: unknown;
    if (args[0] === 'pr') value = {
      number: 42, url: 'https://github.com/ashlrai/phantom/pull/42', state: merged ? 'MERGED' : 'OPEN',
      headRefOid: HEAD, baseRefName: 'master', isCrossRepository: false,
      headRepository: { name: 'phantom' }, headRepositoryOwner: { login: 'ashlrai' },
      mergeCommit: merged ? { oid: MERGE } : null, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    };
    else if (args[1] === 'graphql') value = { data: { repository: { pullRequest: { headRefOid: HEAD, mergeQueueEntry: { id: 'MQE_42' } } } } };
    else if (args[1] === 'repos/ashlrai/phantom') value = { full_name: 'ashlrai/phantom', default_branch: 'master' };
    else if (args[1]?.includes('/releases?')) value = [{ id: 700, tag_name: 'v1.2.3', draft: false, prerelease: false, published_at: NOW }];
    else if (args[1]?.includes('/compare/')) value = { status: 'ahead', merge_base_commit: { sha: MERGE } };
    else if (args[0] === 'run') value = [{ databaseId: 900, headSha: MERGE, headBranch: 'master', event: 'push', status: 'completed', conclusion: 'failure' }];
    else throw new Error('Unexpected fixture command');
    return { ok: true, stdout: JSON.stringify(value) };
  };
  return async fn => fn(gh);
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'router-queue-cli-')); journal = join(directory, 'private', 'events.json'); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('queue CLI durable lifecycle', () => {
  it('records an entire job across queue diffs, publish hook and GitHub polls, then checks coverage', async () => {
    const snapshot = file('snapshot.json', { schemaVersion: 1, queue: [{ ...JOB, status: 'READY' }], claims: [{ ...JOB, claimedAt: NOW }], publications: [] });
    const receipt = file('publication.json', RECEIPT);
    const observe = ['observe', '--input', snapshot, '--journal', journal];
    const first = await invoke(observe);
    expect(first.code).toBe(0); expect(JSON.parse(first.output).added).toBe(3);
    expect(JSON.parse((await invoke(observe)).output).added).toBe(0);
    expect((await invoke(statusArgs(true))).code).toBe(1);
    const published = await invoke(['publish', '--input', receipt, '--journal', journal]);
    expect(published.code).toBe(0); expect(JSON.parse(published.output).added).toBe(1);
    const open = await invoke(['poll', '--input', receipt, '--journal', journal], { github: provider(false) });
    expect(open.code).toBe(0); expect(JSON.parse(open.output).added).toBe(2);
    const landed = await invoke(['poll', '--input', receipt, '--journal', journal], { github: provider(true) });
    expect(landed.code).toBe(0); expect(JSON.parse(landed.output)).toMatchObject({ added: 3, complete: true, missing: [], unavailable: [] });
    expect(JSON.parse((await invoke(['poll', '--input', receipt, '--journal', journal], { github: provider(true) })).output).added).toBe(0);
    const result = await invoke(statusArgs(true));
    expect(result.code).toBe(0); expect(result.errors).toBe('');
    expect(JSON.parse(result.output)).toMatchObject({ ...JOB, schemaVersion: 1, complete: true, seen: [...QUEUE_STATIONS], missing: [] });
    expect(readStationEvents(journal)).toHaveLength(9);
    expect(JSON.parse(readFileSync(journal, 'utf8')).events).toHaveLength(9);
  });

  it('keeps local commands offline and reports missing coverage for an empty journal', async () => {
    const github = vi.fn(async () => { throw new Error('Provider must remain unused'); });
    const empty = file('empty.json', { schemaVersion: 1, queue: [], claims: [], publications: [] });
    expect((await invoke(['observe', '--input', empty, '--journal', journal], { github })).code).toBe(0);
    const result = await invoke(statusArgs(), { github });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ complete: false, seen: [], missing: [...QUEUE_STATIONS] });
    expect((await invoke(statusArgs(true), { github })).code).toBe(1);
    expect(github).not.toHaveBeenCalled();
  });

  it('keeps earlier receipts intact after unavailable GitHub evidence', async () => {
    const receipt = file('publication.json', RECEIPT);
    await invoke(['publish', '--input', receipt, '--journal', journal]);
    const unavailable: NonNullable<QueueCliDeps['github']> = async fn => fn(async () => ({ ok: false, stdout: 'synthetic-private-response' }));
    const result = await invoke(['poll', '--input', receipt, '--journal', journal], { github: unavailable });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ added: 0, unavailable: ['pr-unavailable'], complete: false, seen: ['publish'] });
    expect(result.output).not.toContain('synthetic-private-response');
    expect(readStationEvents(journal).map(event => event.station)).toEqual(['publish']);
  });
});

describe('queue CLI input and error boundaries', () => {
  it.each([
    ['unknown-private-command'], ['observe'], ['status'], ['observe', '--input'],
    ['observe', '--input', '--journal'], ['observe', '--private-option', 'synthetic-private-value'],
    ['observe', '--input', 'synthetic-private-value', '--input', 'duplicate-private-value'],
    ['status', '--job', JOB.jobId, '--repo', JOB.repo, '--attempt', JOB.attempt, '--require-complete', '--require-complete'],
  ].map(args => ({ args })))('rejects invalid CLI usage without echoing it: %j', async ({ args }) => {
    const result = await invoke(args);
    expect(result.code).toBe(2); expect(result.output).toBe('');
    expect(result.errors).not.toContain('private');
  });

  it.each([[], ['help'], ['--help'], ['-h']].map(args => ({ args })))('shows queue help without account access: %j', async ({ args }) => {
    const github = vi.fn(async () => { throw new Error('No provider'); });
    const result = await invoke(args, { github });
    expect(result.code).toBe(0); expect(result.output).toContain('phm telemetry queue');
    expect(github).not.toHaveBeenCalled();
  });

  it('does not echo invalid JSON, unsafe paths or transport errors', async () => {
    const privateMarker = 'synthetic-private-marker';
    const invalid = join(directory, 'invalid.json'); writeFileSync(invalid, `{${privateMarker}`, { mode: 0o600 });
    const absent = join(directory, privateMarker);
    const receipt = file('publication.json', RECEIPT);
    const cases = [
      await invoke(['observe', '--input', invalid, '--journal', journal]),
      await invoke(['observe', '--input', absent, '--journal', journal]),
      await invoke(['poll', '--input', receipt, '--journal', journal], { github: async () => { throw new Error(privateMarker); } }),
    ];
    for (const result of cases) {
      expect(result.code).toBe(1); expect(result.output).toBe(''); expect(result.errors).toContain('Queue observation failed');
      expect(result.errors).not.toContain(privateMarker); expect(result.errors).not.toContain(directory);
    }
  });

  it('rejects symlinked input without changing the journal', async () => {
    const target = file('target.json', RECEIPT); const link = join(directory, 'linked.json');
    symlinkSync(target, link);
    expect((await invoke(['publish', '--input', link, '--journal', journal])).code).toBe(1);
    expect(readStationEvents(journal)).toEqual([]);
  });

  it('rejects malformed snapshots atomically and hides invalid identities', async () => {
    const input = file('invalid-snapshot.json', { schemaVersion: 1, queue: [{ ...JOB, status: 'READY' }], claims: null, publications: [] });
    const result = await invoke(['observe', '--input', input, '--journal', journal]);
    expect(result.code).toBe(1); expect(readStationEvents(journal)).toEqual([]);
    const status = await invoke(['status', '--job', 'synthetic-private\nvalue', '--repo', JOB.repo, '--attempt', JOB.attempt, '--journal', journal]);
    expect(status.code).toBe(1); expect(status.errors).not.toContain('synthetic-private');
  });
});
