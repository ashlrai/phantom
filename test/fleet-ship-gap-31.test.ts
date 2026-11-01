import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdFleetShipGap,
  ghShipGapReader,
  newestVersionTag,
  type FleetShipGapDeps,
  type ShipGapRead,
  type ShipGapReader,
} from '../src/cli/fleet-ship-gap.js';
import { cmdFleet } from '../src/cli/fleet.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { QUEUEGEN_REPOS } from '../src/core/drive/queuegen.js';

const TAGGED_AT = '2026-10-01T12:00:00.000Z';
const NOW = '2026-10-31T12:00:00.000Z';
const clock = () => new Date(NOW);

const okRead = (tag: string, taggedAt: string, ahead: number): ShipGapRead => ({ ok: true, tag, taggedAt, ahead });

/** A reader that returns `ahead` for every repo, or a fixed read per repo. */
function readerFor(table: Record<string, ShipGapRead | 'throw'>, ahead = 5): ShipGapReader {
  return async (repo) => {
    const read = table[repo];
    if (read === 'throw') throw new Error(`boom on ${repo}`);
    return read ?? okRead('v1.2.3', TAGGED_AT, ahead);
  };
}

/** Fake gh: endpoint (args[1]) → JSON body, or `{ fail: stderr }`. */
function fakeGh(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const gh: CloudGh = async (args) => {
    calls.push([...args]);
    const r = responses[args[1]!];
    if (r === undefined) return { ok: false, stdout: '', stderr: 'not stubbed' };
    if (typeof r === 'object' && r !== null && 'fail' in r) {
      return { ok: false, stdout: '', stderr: String((r as { fail: unknown }).fail) };
    }
    return { ok: true, stdout: JSON.stringify(r), stderr: '' };
  };
  return { gh, calls };
}

let output: string[];
let errors: string;
beforeEach(() => {
  output = [];
  errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

const report = () => JSON.parse(output.join('\n')) as {
  v: number; generatedAt: string; measured: number; unknown: number;
  repos: { repo: string; status: string; tag: string | null; taggedAt: string | null; tagAgeDays: number | null; ahead: number | null; reason?: string }[];
};

describe('ashlr fleet ship-gap', () => {
  it('lists the newest tag, its age and commits ahead for all seven repos', async () => {
    const deps: FleetShipGapDeps = { reader: readerFor({ 'ashlrai/phantom': okRead('v3.29.15', TAGGED_AT, 712) }), now: clock };
    expect(await cmdFleetShipGap(['--json'], deps)).toBe(0);
    const r = report();
    expect(r.v).toBe(1);
    expect(r.generatedAt).toBe(NOW);
    expect(r.measured).toBe(7);
    expect(r.unknown).toBe(0);
    expect(r.repos.map((row) => row.repo)).toEqual([...QUEUEGEN_REPOS]);
    const phantom = r.repos.find((row) => row.repo === 'ashlrai/phantom')!;
    expect(phantom).toMatchObject({ status: 'ok', tag: 'v3.29.15', taggedAt: TAGGED_AT, tagAgeDays: 30, ahead: 712 });
    const locus = r.repos.find((row) => row.repo === 'ashlrai/locus')!;
    expect(locus).toMatchObject({ status: 'ok', tag: 'v1.2.3', ahead: 5 });
    expect(errors).toBe('');
  });

  it('marks a failed read unknown, exits nonzero and never reports zero drift', async () => {
    const reader = readerFor({
      'ashlrai/lexicon': { ok: false, reason: 'gh api repos/ashlrai/lexicon failed (not authenticated)' },
      'ashlrai/ashlr-md': 'throw',
    });
    expect(await cmdFleetShipGap(['--json'], { reader, now: clock })).toBe(1);
    const r = report();
    expect(r.measured).toBe(5);
    expect(r.unknown).toBe(2);
    const lexicon = r.repos.find((row) => row.repo === 'ashlrai/lexicon')!;
    expect(lexicon).toMatchObject({ status: 'unknown', tag: null, taggedAt: null, tagAgeDays: null, ahead: null });
    expect(lexicon.reason).toContain('not authenticated');
    const md = r.repos.find((row) => row.repo === 'ashlrai/ashlr-md')!;
    expect(md.status).toBe('unknown');
    expect(md.ahead).toBeNull();
    expect(md.reason).toContain('boom on ashlrai/ashlr-md');
    // The five healthy repos still carry their real drift numbers.
    const secrets = r.repos.find((row) => row.repo === 'ashlrai/phantom-secrets')!;
    expect(secrets).toMatchObject({ status: 'ok', ahead: 5 });
  });

  it('reports an honest zero drift only for a successful read', async () => {
    const deps: FleetShipGapDeps = { reader: readerFor({ 'ashlrai/locus': okRead('v0.5.0', '2026-10-31T00:00:00.000Z', 0) }), now: clock };
    expect(await cmdFleetShipGap(['--json'], deps)).toBe(0);
    const locus = report().repos.find((row) => row.repo === 'ashlrai/locus')!;
    expect(locus).toMatchObject({ status: 'ok', tag: 'v0.5.0', tagAgeDays: 0, ahead: 0 });
  });

  it('prints the per-repo summary in text mode', async () => {
    const deps: FleetShipGapDeps = { reader: readerFor({ 'ashlrai/lexicon': { ok: false, reason: 'offline' } }), now: clock };
    expect(await cmdFleetShipGap([], deps)).toBe(1);
    const text = output.join('\n');
    expect(text).toContain('Fleet ship-gap: 6/7 repo(s) measured');
    expect(text).toContain('ashlrai/phantom');
    expect(text).toContain('commit(s) ahead');
    expect(text).toContain('unknown');
    expect(text).toContain('offline');
    expect(text).toContain('drift is unread, not zero');
  });

  it.each([['--bogus'], ['extra'], ['--json', '--json'], ['--repo', 'acme/app']])(
    'rejects bad arguments %j without reading anything', async (...args) => {
      const reader = vi.fn();
      expect(await cmdFleetShipGap(args, { reader })).toBe(2);
      expect(reader).not.toHaveBeenCalled();
      expect(errors).toContain('usage:');
    },
  );

  it('--help prints usage and reads nothing', async () => {
    const reader = vi.fn();
    expect(await cmdFleetShipGap(['--help'], { reader })).toBe(0);
    expect(reader).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('ashlr fleet ship-gap');
  });

  it('is reachable through `fleet ship-gap`', async () => {
    expect(await cmdFleet(['ship-gap', '--bogus'])).toBe(2);
    expect(errors).toContain('usage: ashlr fleet ship-gap');
    expect(await cmdFleet(['ship-gap', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('ashlr fleet ship-gap');
  });

  it('drives the production reader through injected gh api GETs', async () => {
    const gh: CloudGh = async (args) => {
      const ep = args[1]!;
      if (ep.startsWith('repos/ashlrai/lexicon')) {
        return { ok: false, stdout: '', stderr: 'gh: HTTP 404' };
      }
      if (ep.endsWith('/tags?per_page=100')) {
        return { ok: true, stdout: JSON.stringify([{ name: 'v0.1.0' }]), stderr: '' };
      }
      if (ep.includes('/compare/')) {
        return { ok: true, stdout: JSON.stringify({ ahead_by: 700, base_commit: { commit: { committer: { date: TAGGED_AT } } } }), stderr: '' };
      }
      return { ok: true, stdout: JSON.stringify({ default_branch: 'main' }), stderr: '' };
    };
    expect(await cmdFleetShipGap(['--json'], { gh, now: clock })).toBe(1);
    const r = report();
    expect(r.measured).toBe(6);
    expect(r.unknown).toBe(1);
    const phantom = r.repos.find((row) => row.repo === 'ashlrai/phantom')!;
    expect(phantom).toMatchObject({ status: 'ok', tag: 'v0.1.0', ahead: 700 });
    expect(r.repos.find((row) => row.repo === 'ashlrai/lexicon')!.status).toBe('unknown');
  });
});

describe('ghShipGapReader', () => {
  it('picks the highest version tag and reads ahead_by plus the tag date from compare', async () => {
    const { gh, calls } = fakeGh({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/tags?per_page=100': [
        { name: 'v1.2.0' }, { name: 'latest' }, { name: 'v1.10.0-rc1' }, { name: 'v1.10.0' }, { name: 'v1.9.0' },
      ],
      'repos/acme/app/compare/v1.10.0...main': {
        ahead_by: 12, base_commit: { commit: { committer: { date: TAGGED_AT } } },
      },
    });
    const read = await ghShipGapReader(gh)('acme/app');
    expect(read).toEqual({ ok: true, tag: 'v1.10.0', taggedAt: TAGGED_AT, ahead: 12 });
    expect(calls.map((c) => c[1])).toEqual([
      'repos/acme/app', 'repos/acme/app/tags?per_page=100', 'repos/acme/app/compare/v1.10.0...main',
    ]);
  });

  it('fails the repo read on any gh error, missing version tag or malformed compare', async () => {
    const failing = fakeGh({ 'repos/acme/app': { fail: 'gh: not authenticated' } });
    expect(await ghShipGapReader(failing.gh)('acme/app')).toMatchObject({ ok: false, reason: 'gh api repos/acme/app failed (gh: not authenticated)' });

    const noBranch = fakeGh({ 'repos/acme/app': { name: 'app' } });
    expect(await ghShipGapReader(noBranch.gh)('acme/app')).toMatchObject({ ok: false });

    const noTags = fakeGh({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/tags?per_page=100': [{ name: 'latest' }, { name: 'docs-refresh' }],
    });
    expect(await ghShipGapReader(noTags.gh)('acme/app')).toMatchObject({ ok: false, reason: 'acme/app has no version tags' });

    const badCompare = fakeGh({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/tags?per_page=100': [{ name: 'v1.0.0' }],
      'repos/acme/app/compare/v1.0.0...main': { status: 'diverged' },
    });
    expect(await ghShipGapReader(badCompare.gh)('acme/app')).toMatchObject({ ok: false, reason: 'gh api compare for acme/app did not report ahead_by' });

    const noDate = fakeGh({
      'repos/acme/app': { default_branch: 'main' },
      'repos/acme/app/tags?per_page=100': [{ name: 'v1.0.0' }],
      'repos/acme/app/compare/v1.0.0...main': { ahead_by: 4 },
    });
    expect(await ghShipGapReader(noDate.gh)('acme/app')).toMatchObject({ ok: false, reason: `gh api compare for acme/app did not report the tag's commit date` });

    const garbage: CloudGh = async () => ({ ok: true, stdout: '<html>rate limited</html>', stderr: '' });
    expect(await ghShipGapReader(garbage)('acme/app')).toMatchObject({ ok: false, reason: 'gh api repos/acme/app did not return JSON' });
  });
});

describe('newestVersionTag', () => {
  it('ranks by version, prefers stable over a same-version prerelease, skips non-versions', () => {
    expect(newestVersionTag([
      { name: 'v1.2.0' }, { name: 'latest' }, { name: 'v1.10.0-beta' }, { name: 'v1.10.0' }, { name: 'v1.9.9' },
    ])).toBe('v1.10.0');
    expect(newestVersionTag([{ name: '1.0.0' }, { name: 'v1.0.0-beta' }])).toBe('1.0.0');
    expect(newestVersionTag('not an array')).toBeNull();
    expect(newestVersionTag([])).toBeNull();
    expect(newestVersionTag([{ name: 'docs' }, { sha: 'x' }])).toBeNull();
  });
});
