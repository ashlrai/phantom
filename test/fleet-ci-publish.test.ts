import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiPublish } from '../src/cli/fleet-ci-publish.js';
import { CI_INCIDENT_TTL_MS } from '../src/core/fleet/ci-bus-incident.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const roots: string[] = [];
const args = ['--repo', 'AshlrAI/Phantom', '--run', '123', '--to', 'leader:one', '--json'];
const sha = 'a'.repeat(40);
const fakeSecret = 'ghp_' + 'aB1'.repeat(12); // synthetic redaction fixture
function fixture() {
  return {
    run: { id: 123, repository: { full_name: 'ashlrai/phantom' }, event: 'schedule', status: 'completed',
      conclusion: 'failure', run_attempt: 1, name: `Daily ${fakeSecret}`, head_branch: 'master', head_sha: sha },
    jobs: { total_count: 2, jobs: [
      { id: 22, run_id: 123, name: `Test ${fakeSecret}`, conclusion: 'failure', steps: [
        { number: 2, name: `Check ${fakeSecret}`, conclusion: 'failure' },
        { number: 1, name: 'Setup', conclusion: 'success' },
      ] },
      { id: 23, run_id: 123, name: 'Build', conclusion: 'success', steps: [] },
    ] },
  };
}
function setup(data = fixture()) {
  const root = mkdtempSync(join(tmpdir(), 'ci-bus-')); roots.push(root);
  const calls: string[][] = [];
  const gh: CloudGh = async argv => {
    calls.push(argv);
    return { ok: true, stdout: JSON.stringify(calls.length % 2 === 1 ? data.run : data.jobs), stderr: '' };
  };
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const invoke = (argv = args, ghReader = gh) => cmdFleetCiPublish(argv, { gh: ghReader, bus: { root, now: () => 100 } });
  const result = () => JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
  const retained = () => listBusInboxAfter(0, 100, { root, now: () => 100 });
  return { root, calls, output, errors, invoke, result, retained, data };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('fleet ci-publish', () => {
  it('posts real durable, scrubbed provenance once per attempt and recipient', async () => {
    const h = setup();
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toMatchObject({ status: 'posted', cursor: 1 });
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toMatchObject({ status: 'duplicate', cursor: 1 });
    const page = h.retained();
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('missing page');
    expect(page.messages).toHaveLength(1);
    const envelope = page.messages[0]!.envelope;
    expect(envelope).toMatchObject({ from: 'system:ci', to: 'leader:one', priority: 'P1', ttl: CI_INCIDENT_TTL_MS,
      body: { kind: 'ci.failed-scheduled-run', repo: 'ashlrai/phantom', runId: 123, attempt: 1,
        url: 'https://github.com/ashlrai/phantom/actions/runs/123/attempts/1', branch: 'master', headSha: sha,
        workflow: 'Daily [REDACTED]', failedJobCount: 1,
        jobs: [{ id: 22, name: 'Test [REDACTED]', failedSteps: ['Check [REDACTED]'], failedStepCount: 1 }] } });
    expect(readFileSync(join(h.root, 'bus-inbox', 'messages.json'), 'utf8')).not.toContain(fakeSecret);
    expect(JSON.stringify(h.output.mock.calls)).not.toContain(fakeSecret);
    h.data.run.name = 'Changed upstream name';
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toMatchObject({ status: 'duplicate', cursor: 1 });
    expect(h.retained()).toEqual(page);
    h.data.run.run_attempt = 2;
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toMatchObject({ status: 'posted', cursor: 2 });
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toMatchObject({ status: 'duplicate', cursor: 2 });
    const after = h.retained();
    expect(after.status === 'ok' && after.messages).toHaveLength(2);
    expect(h.calls).toEqual([
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123/attempts/1/jobs?per_page=100'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123/attempts/1/jobs?per_page=100'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123/attempts/1/jobs?per_page=100'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123/attempts/2/jobs?per_page=100'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123'],
      ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/ashlrai/phantom/actions/runs/123/attempts/2/jobs?per_page=100'],
    ]);
  });

  it('dry-runs the exact envelope without writing', async () => {
    const h = setup();
    expect(await h.invoke([...args, '--dry-run'])).toBe(0);
    const preview = h.result();
    expect(preview.status).toBe('dry-run');
    expect(h.retained()).toMatchObject({ status: 'ok', messages: [] });
    expect(await h.invoke()).toBe(0);
    const page = h.retained();
    expect(page.status === 'ok' && page.messages[0]!.envelope).toEqual(preview.envelope);
  });

  it.each([
    ['running', { status: 'in_progress', conclusion: null }, 'run is not completed'],
    ['success', { conclusion: 'success' }, 'run conclusion is not failure'],
    ['cancelled', { conclusion: 'cancelled' }, 'run conclusion is not failure'],
    ['PR', { event: 'pull_request' }, 'run event is not schedule'],
  ])('skips %s without bus writes', async (_label, patch, reason) => {
    const data = fixture(); Object.assign(data.run, patch);
    const h = setup(data);
    expect(await h.invoke()).toBe(0);
    expect(h.result()).toEqual({ status: 'skipped', reason });
    expect(h.calls).toHaveLength(1);
    expect(h.retained()).toMatchObject({ status: 'ok', messages: [] });
  });

  it.each([1, 2])('reports failed gh read %i without leaking stderr or writing', async failAt => {
    const h = setup(); let count = 0;
    const gh: CloudGh = async () => {
      count++;
      if (count === failAt) return { ok: false, stdout: '', stderr: fakeSecret };
      return { ok: true, stdout: JSON.stringify(h.data.run), stderr: '' };
    };
    expect(await h.invoke(args, gh)).toBe(1);
    expect(h.result()).toEqual({ status: 'error', reason: failAt === 1 ? 'GitHub run read failed' : 'GitHub jobs read failed' });
    expect(JSON.stringify(h.output.mock.calls)).not.toContain(fakeSecret);
    expect(h.retained()).toMatchObject({ status: 'ok', messages: [] });
  });

  it('rejects incomplete and inconsistent source data', async () => {
    const data = fixture(); data.jobs.total_count = 101;
    const h = setup(data);
    expect(await h.invoke()).toBe(1);
    expect(h.result()).toMatchObject({ status: 'error', reason: 'incomplete or invalid GitHub jobs response' });
    expect(h.retained()).toMatchObject({ status: 'ok', messages: [] });
  });

  it('reports a durable storage failure and does not expose its details', async () => {
    const h = setup();
    writeFileSync(join(h.root, 'bus-inbox'), 'blocked');
    expect(await h.invoke()).toBe(1);
    expect(h.result()).toEqual({ status: 'error', reason: 'bus storage unavailable' });
  });

  it.each([
    ['--repo', '../bad', '--run', '123', '--to', 'leader'],
    ['--repo', 'ashlrai/phantom', '--run', '0', '--to', 'leader'],
    ['--repo', 'ashlrai/phantom', '--run', '123', '--to', 'bad address'],
    ['--repo', 'ashlrai/phantom', '--run', '123', '--to', 'leader', '--repo', 'x/y'],
  ])('rejects invalid arguments before invoking gh', async (...argv) => {
    const h = setup();
    expect(await h.invoke(argv)).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.retained()).toMatchObject({ status: 'ok', messages: [] });
  });
});
