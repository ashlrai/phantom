import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCiTriggers, ghCiTriggerReader } from '../src/cli/fleet-ci-triggers.js';
import {
  classifyWorkflow,
  isDailyCron,
  parseWorkflowTriggers,
  type CiTriggerFactsReport,
  type CiTriggerRepoRead,
  type CiTriggerWorkflowItem,
} from '../src/core/fleet/ci-trigger-facts.js';
import { cmdFleet } from '../src/cli/fleet.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const SHA = 'f'.repeat(40);

/** The observed master ci.yml `on:` shape, reduced to a small fake fixture. */
const CI_YML = `name: CI
on:
  pull_request:
    branches: ["**"]
    types: [opened, synchronize, reopened]
  merge_group:
  workflow_call:
  schedule:
    - cron: "3 9 * * *"
  workflow_dispatch:
    inputs:
      mac_shard:
        type: choice
        default: all
jobs:
  quick:
    runs-on: ubuntu-latest
    steps: [{run: 'echo ok'}]
`;

const item = (path: string, name: string | null, enabled: boolean | null, source: CiTriggerWorkflowItem['source']): CiTriggerWorkflowItem =>
  ({ path, name, enabled, source });
const okRead = (workflows: CiTriggerWorkflowItem[], extra: Partial<CiTriggerRepoRead> = {}): CiTriggerRepoRead =>
  ({ ok: true, defaultBranch: 'master', defaultBranchSha: SHA, truncated: [], workflows, ...extra } as CiTriggerRepoRead);

let output: string[];
let errors: string;
beforeEach(() => {
  output = [];
  errors = '';
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { output.push(String(m)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { errors += String(c); return true; });
});
afterEach(() => vi.restoreAllMocks());

const report = () => JSON.parse(output.join('\n')) as CiTriggerFactsReport;

describe('parseWorkflowTriggers', () => {
  it('parses scalar, sequence and mapping on: forms', () => {
    expect(parseWorkflowTriggers('on: push\n')).toMatchObject({ ok: true, triggers: { events: ['push'], schedules: [] } });
    expect(parseWorkflowTriggers('on: [push, pull_request]\n')).toMatchObject({ ok: true, triggers: { events: ['push', 'pull_request'] } });
    expect(parseWorkflowTriggers(CI_YML)).toMatchObject({
      ok: true,
      triggers: {
        events: ['pull_request', 'merge_group', 'workflow_call', 'schedule', 'workflow_dispatch'],
        schedules: ['3 9 * * *'],
        manualOrReusable: ['workflow_call', 'workflow_dispatch'],
      },
    });
  });

  it('preserves on as a key quoted, and honours the YAML-1.1 boolean-true key', () => {
    expect(parseWorkflowTriggers('"on": [push]\n')).toMatchObject({ ok: true, triggers: { events: ['push'] } });
    expect(parseWorkflowTriggers("'on': pull_request\n")).toMatchObject({ ok: true, triggers: { events: ['pull_request'] } });
    expect(parseWorkflowTriggers('true: [push]\n')).toMatchObject({ ok: true, triggers: { events: ['push'] } });
  });

  it('fails on invalid or unsupported YAML instead of guessing', () => {
    for (const source of ['on: [push\n', '- just\n- a\n- list\n', 'on: 42\n', 'on:\n  schedule: nightly\n', 'on:\n  schedule: [{cron: 7}]\n']) {
      expect(parseWorkflowTriggers(source).ok, source).toBe(false);
    }
  });
});

describe('classifyWorkflow and isDailyCron', () => {
  it('classifies by name/path evidence; release and custody never read as CI', () => {
    expect(classifyWorkflow('CI', '.github/workflows/ci.yml')).toBe('ci-test');
    expect(classifyWorkflow('Companion Smoke', '.github/workflows/companion-smoke.yml')).toBe('ci-test');
    expect(classifyWorkflow('Release', '.github/workflows/release.yml')).toBe('release-deployment');
    expect(classifyWorkflow('Custody helper', '.github/workflows/custody.yml')).toBe('release-deployment');
    expect(classifyWorkflow('Attest qualified CI build', '.github/workflows/attest-ci-build.yml')).toBe('release-deployment');
    expect(classifyWorkflow('Auto-tag', '.github/workflows/auto-tag.yml')).toBe('release-deployment');
    expect(classifyWorkflow('Dependency Audit', '.github/workflows/dependency-audit.yml')).toBe('maintenance');
    expect(classifyWorkflow('Merge Queue Reaper', '.github/workflows/merge-queue-reaper.yml')).toBe('maintenance');
    expect(classifyWorkflow('Odd job', '.github/workflows/frobnicate.yml')).toBe('unknown');
  });

  it('recognises only the fixed once-a-day cron shape', () => {
    expect(isDailyCron('3 9 * * *')).toBe(true);
    expect(isDailyCron('*/30 * * * *')).toBe(false);
    expect(isDailyCron('17 9 * * 1')).toBe(false);
  });
});

describe('ashlr fleet ci-triggers', () => {
  it('flags the current ci.yml trigger shape for owner review', async () => {
    const read = okRead([item('.github/workflows/ci.yml', 'CI', true, { ok: true, text: CI_YML })]);
    expect(await cmdFleetCiTriggers(['--json'], { reader: async () => read, now: () => NOW })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ v: 1, status: 'ok', defaultBranch: 'master', defaultBranchSha: SHA, scanned: 1, unread: 0 });
    expect(r.ownerReview).toEqual([{ path: '.github/workflows/ci.yml', name: 'CI', flags: ['pull-request-trigger', 'merge-group-trigger'] }]);
    expect(r.workflows[0]).toMatchObject({
      classification: 'ci-test', enabled: true, read: 'ok',
      dailySchedules: ['3 9 * * *'], manualOrReusable: ['workflow_call', 'workflow_dispatch'], ownerReview: true,
    });
    expect(r.workflows[0].events).toEqual(['pull_request', 'merge_group', 'workflow_call', 'schedule', 'workflow_dispatch']);
  });

  it('skips owner review for disabled workflows and never flags release work', async () => {
    const read = okRead([
      item('.github/workflows/ci.yml', 'CI', false, { ok: true, text: CI_YML }),
      item('.github/workflows/release.yml', 'Release', true, { ok: true, text: 'name: Release\non:\n  push:\n    tags: ["v*"]\n' }),
    ]);
    expect(await cmdFleetCiTriggers(['--json'], { reader: async () => read, now: () => NOW })).toBe(0);
    const r = report();
    expect(r.ownerReview).toEqual([]);
    expect(r.workflows[0]).toMatchObject({ enabled: false, ownerReview: false, flags: ['pull-request-trigger', 'merge-group-trigger'] });
    expect(r.workflows[1]).toMatchObject({ classification: 'release-deployment', events: ['push'], flags: ['push-trigger', 'no-daily-schedule'], ownerReview: false });
  });

  it('flags ci-test workflows with no daily schedule or several', async () => {
    const read = okRead([
      item('a.yml', 'CI reusable', true, { ok: true, text: 'on: workflow_call\n' }),
      item('b.yml', 'CI', true, { ok: true, text: 'on:\n  schedule:\n    - {cron: "3 9 * * *"}\n    - {cron: "0 13 * * *"}\n' }),
    ]);
    expect(await cmdFleetCiTriggers(['--json'], { reader: async () => read, now: () => NOW })).toBe(0);
    const [a, b] = report().workflows;
    expect(a).toMatchObject({ flags: ['no-daily-schedule'], ownerReview: true });
    expect(b).toMatchObject({ flags: ['multiple-daily-schedules'], dailySchedules: ['3 9 * * *', '0 13 * * *'], ownerReview: true });
  });

  it('marks API failure unknown and exits nonzero — never a clean zero', async () => {
    expect(await cmdFleetCiTriggers(['--repo', 'acme/app', '--json'], { reader: async () => ({ ok: false, reason: 'gh api repos/acme/app failed (HTTP 401)' }), now: () => NOW })).toBe(1);
    expect(report()).toMatchObject({ status: 'unknown', reason: 'gh api repos/acme/app failed (HTTP 401)', workflows: [], ownerReview: [], scanned: 0 });
  });

  it('marks unread, unparsed and truncated evidence incomplete — exit nonzero', async () => {
    const read = okRead([
      item('a.yml', 'CI', true, { ok: false, reason: 'blob unavailable' }),
      item('b.yml', 'CI', true, { ok: true, text: 'on: [push\n' }),
    ], { truncated: ['workflow inventory truncated at 200/240'] });
    expect(await cmdFleetCiTriggers(['--json'], { reader: async () => read, now: () => NOW })).toBe(1);
    const r = report();
    expect(r.workflows).toMatchObject([{ read: 'unread', error: 'blob unavailable' }, { read: 'unparsed' }]);
    expect(r.truncated).toEqual(['workflow inventory truncated at 200/240']);
  });

  it('rejects unsafe --repo values before any read', async () => {
    for (const repo of ['../x', 'a/b/c', ';rm -rf', 'owner/', '/repo', 'owner/repo?x=1', '.a/b', 'a/..']) {
      const reader = vi.fn();
      expect(await cmdFleetCiTriggers(['--repo', repo], { reader }), repo).toBe(2);
      expect(reader).not.toHaveBeenCalled();
    }
    expect(errors).toContain('usage:');
  });

  it('rejects bad arguments, prints usage on --help and dispatches via `fleet ci-triggers`', async () => {
    const reader = vi.fn();
    expect(await cmdFleetCiTriggers(['--bogus'], { reader })).toBe(2);
    expect(await cmdFleetCiTriggers(['--json', '--json'], { reader })).toBe(2);
    expect(await cmdFleetCiTriggers(['--help'], { reader })).toBe(0);
    expect(reader).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('ashlr fleet ci-triggers');
    expect(await cmdFleet(['ci-triggers', '--help'])).toBe(0);
    expect(await cmdFleet(['ci-triggers', '--bogus'])).toBe(2);
  });

  it('prints offending path, event and the owner-review requirement in text mode', async () => {
    const read = okRead([item('.github/workflows/ci.yml', 'CI', true, { ok: true, text: CI_YML })]);
    expect(await cmdFleetCiTriggers([], { reader: async () => read, now: () => NOW })).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('.github/workflows/ci.yml');
    expect(text).toContain('pull-request-trigger');
    expect(text).toContain('wner review required');
    expect(text).toContain('once-per-day');
  });
});

describe('ghCiTriggerReader', () => {
  const ghFor = (responses: Record<string, unknown>): CloudGh => async (args) => {
    const r = responses[args[1]!];
    if (r === undefined) return { ok: false, stdout: '', stderr: 'not stubbed' };
    if (typeof r === 'object' && r !== null && 'fail' in r) return { ok: false, stdout: '', stderr: String((r as { fail: unknown }).fail) };
    return { ok: true, stdout: JSON.stringify(r), stderr: '' };
  };
  const blob = (text: string) => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });

  it('walks repo, branch, inventory and contents GETs; decodes source at the sha', async () => {
    const calls: string[] = [];
    const base = ghFor({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/branches/main': { commit: { sha: SHA } },
      'repos/acme/app/actions/workflows?per_page=100&page=1': {
        total_count: 2,
        workflows: [
          { path: '.github/workflows/ci.yml', name: 'CI', state: 'active' },
          { path: '.github/workflows/old.yml', name: 'Old', state: 'disabled_manually' },
        ],
      },
      [`repos/acme/app/contents/.github/workflows/ci.yml?ref=${SHA}`]: blob(CI_YML),
      [`repos/acme/app/contents/.github/workflows/old.yml?ref=${SHA}`]: { fail: 'HTTP 410' },
    });
    const gh: CloudGh = async (args) => { calls.push(args[1]!); return base(args); };
    const read = await ghCiTriggerReader(gh)('acme/app');
    expect(read).toMatchObject({ ok: true, defaultBranch: 'main', defaultBranchSha: SHA });
    if (!read.ok) throw new Error('read failed');
    expect(read.workflows[0]).toMatchObject({ path: '.github/workflows/ci.yml', enabled: true, source: { ok: true, text: CI_YML } });
    expect(read.workflows[1]).toMatchObject({ enabled: false, source: { ok: false } });
    expect(calls).toEqual([
      'repos/acme/app', 'repos/acme/app/branches/main',
      'repos/acme/app/actions/workflows?per_page=100&page=1',
      `repos/acme/app/contents/.github/workflows/ci.yml?ref=${SHA}`,
      `repos/acme/app/contents/.github/workflows/old.yml?ref=${SHA}`,
    ]);
  });

  it('fails the whole read when a GET fails, through the real handler', async () => {
    const gh: CloudGh = async () => ({ ok: false, stdout: '', stderr: 'gh: HTTP 401' });
    expect(await cmdFleetCiTriggers(['--repo', 'acme/app', '--json'], { gh, now: () => NOW })).toBe(1);
    expect(report()).toMatchObject({ status: 'unknown', workflows: [], ownerReview: [] });
  });

  it('reports truncation when the inventory is incomplete', async () => {
    const gh = ghFor({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/branches/main': { commit: { sha: SHA } },
      'repos/acme/app/actions/workflows?per_page=100&page=1': {
        total_count: 2,
        workflows: [{ path: '.github/workflows/ci.yml', name: 'CI', state: 'active' }],
      },
      [`repos/acme/app/contents/.github/workflows/ci.yml?ref=${SHA}`]: blob('on: push\n'),
    });
    const read = await ghCiTriggerReader(gh)('acme/app');
    expect(read).toMatchObject({ ok: true, truncated: ['workflow inventory truncated at 1/2'] });
  });
});
