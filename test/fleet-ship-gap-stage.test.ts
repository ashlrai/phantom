import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetShipGap, ghShipGapReader, npmIsLive, type JsonGetter } from '../src/cli/fleet-ship-gap.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const TAGGED_AT = '2026-10-01T12:00:00.000Z';
const clock = () => new Date('2026-10-31T12:00:00.000Z');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

interface Opts {
  pkg?: unknown | 'fail';
  runs?: unknown | 'fail';
  tag?: string;
}

/** Fake read-only gh for acme/app; records every endpoint it was asked for. */
function fakeGh(opts: Opts = {}) {
  const calls: string[][] = [];
  const gh: CloudGh = async (args) => {
    calls.push([...args]);
    const ep = args[1]!;
    const fail = { ok: false, stdout: '', stderr: 'gh: HTTP 500' };
    const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '' });
    if (/^repos\/[^/]+\/[^/?]+$/.test(ep)) return ok({ default_branch: 'main' });
    if (ep.endsWith('/tags?per_page=100')) return ok([{ name: opts.tag ?? 'v3.29.16' }]);
    if (ep.includes('/compare/')) return ok({ ahead_by: 0, base_commit: { commit: { committer: { date: TAGGED_AT } } } });
    if (ep.endsWith('/contents/package.json')) {
      return opts.pkg === 'fail' || opts.pkg === undefined ? fail : ok({ content: b64(opts.pkg) });
    }
    if (ep.includes('/actions/runs')) {
      return opts.runs === 'fail' || opts.runs === undefined ? fail : ok(opts.runs);
    }
    return fail;
  };
  return { gh, calls };
}

const npmServing = (version: string | null): { getJson: JsonGetter; urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    getJson: async (url) => { urls.push(url); return version === null ? null : { version }; },
  };
};

describe('npmIsLive', () => {
  it('is false when the tag is ahead of npm, true when caught up or past, null when unknown', () => {
    expect(npmIsLive('v3.29.16', '3.29.15')).toBe(false);
    expect(npmIsLive('v3.29.16', '3.29.16')).toBe(true);
    expect(npmIsLive('v3.29.16', '3.30.0')).toBe(true);
    expect(npmIsLive('v1.0.0', '1.0.0-rc1')).toBe(false);
    expect(npmIsLive('v3.29.16', null)).toBeNull();
    expect(npmIsLive('v3.29.16', 'garbage')).toBeNull();
  });
});

describe('ghShipGapReader stage reads', () => {
  it('reads npm version and the latest scheduled CI conclusion with GETs only', async () => {
    const { gh, calls } = fakeGh({
      pkg: { name: '@acme/app' },
      runs: { workflow_runs: [{ conclusion: 'failure' }] },
    });
    const npm = npmServing('3.29.15');
    const read = await ghShipGapReader(gh, npm.getJson)('acme/app');
    expect(read).toMatchObject({ ok: true, npmVersion: '3.29.15', ciConclusion: 'failure' });
    expect(npm.urls).toEqual(['https://registry.npmjs.org/@acme%2fapp/latest']);
    expect(calls.map((c) => c[1])).toContain('repos/acme/app/actions/runs?event=schedule&per_page=1');
    // Only `gh api <endpoint>`: no -X / --method / field flags.
    for (const c of calls) expect(c).toEqual(['api', c[1]]);
  });

  it('keeps failed reads null and skips npm for repos without a public package', async () => {
    const failing = fakeGh({ pkg: { name: 'app' }, runs: 'fail' });
    const down = npmServing(null);
    expect(await ghShipGapReader(failing.gh, down.getJson)('acme/app'))
      .toMatchObject({ ok: true, npmVersion: null, ciConclusion: null });

    for (const pkg of [{ name: 'app', private: true }, { version: '1.0.0' }, 'fail' as const]) {
      const npm = npmServing('9.9.9');
      const { gh } = fakeGh({ pkg, runs: { workflow_runs: [] } });
      expect(await ghShipGapReader(gh, npm.getJson)('acme/app')).toMatchObject({ npmVersion: null, ciConclusion: null });
      expect(npm.urls).toEqual([]);
    }
  });
});

describe('fleet ship-gap stage', () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { output.push(String(m)); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('a repo tagged ahead of npm reads as not live even with zero commits ahead', async () => {
    const { gh } = fakeGh({ pkg: { name: 'app' }, runs: { workflow_runs: [{ conclusion: 'success' }] } });
    const npm = npmServing('3.29.15');
    expect(await cmdFleetShipGap(['--json'], { gh, getJson: npm.getJson, now: clock })).toBe(0);
    const report = JSON.parse(output.join('\n')) as { repos: Record<string, unknown>[] };
    expect(report.repos).toHaveLength(7);
    for (const row of report.repos) {
      expect(row).toMatchObject({ ahead: 0, npmVersion: '3.29.15', ciConclusion: 'success', live: false });
    }
  });

  it('emits npmVersion, ciConclusion and live per row', async () => {
    const reader = async (repo: string) => repo === 'ashlrai/phantom'
      ? { ok: true as const, tag: 'v3.29.16', taggedAt: TAGGED_AT, ahead: 0, npmVersion: '3.29.15', ciConclusion: 'success' }
      : { ok: true as const, tag: 'v1.0.0', taggedAt: TAGGED_AT, ahead: 2 };
    expect(await cmdFleetShipGap(['--json'], { reader, now: clock })).toBe(0);
    const rows = (JSON.parse(output.join('\n')) as { repos: { repo: string; npmVersion: unknown; ciConclusion: unknown; live: unknown; ahead: number }[] }).repos;
    const phantom = rows.find((r) => r.repo === 'ashlrai/phantom')!;
    expect(phantom).toMatchObject({ ahead: 0, npmVersion: '3.29.15', ciConclusion: 'success', live: false });
    const locus = rows.find((r) => r.repo === 'ashlrai/locus')!;
    expect(locus).toMatchObject({ npmVersion: null, ciConclusion: null, live: null });
  });

  it('flags the stale npm version in text mode', async () => {
    const reader = async () => ({ ok: true as const, tag: 'v3.29.16', taggedAt: TAGGED_AT, ahead: 0, npmVersion: '3.29.15', ciConclusion: 'failure' });
    expect(await cmdFleetShipGap([], { reader, now: clock })).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('npm 3.29.15');
    expect(text).toContain('not live');
    expect(text).toContain('ci failure');
  });
});
