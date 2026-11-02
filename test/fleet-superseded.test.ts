import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSuperseded, type FleetSupersededDeps } from '../src/cli/fleet-superseded.js';
import { findSupersededPrs, type OpenFleetPr } from '../src/core/fleet/superseded-prs.js';

const open = (number: number, title = 'original', mergeStateStatus = 'DIRTY'): OpenFleetPr =>
  ({ number, title, mergeStateStatus });
const pairs = [[2461, 2505], [2406, 2500], [2420, 2483], [2379, 2490], [2371, 2482]] as const;

let output: string[];
let errors: string;
beforeEach(() => {
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet superseded', () => {
  it('finds the known pairs only through the merged jobs and their prompt references', () => {
    const originals = pairs.map(([number]) => open(number));
    const merged = pairs.map(([, number], index) => ({ number, title: `recut RQ-PHX-FAKE${index}` }));
    const prompts = new Map(pairs.map(([number], index) => [`RQ-PHX-FAKE${index}`, `Rebuild PR #${number}.`]));
    const rows = findSupersededPrs(originals, merged, prompts);
    expect(rows.map(row => [row.pr.number, row.supersededBy.number])).toEqual(pairs);
    expect(rows[0]!.evidence).toEqual({ jobId: 'RQ-PHX-FAKE0', reference: 'PR #2461' });
  });

  it('does not infer supersession from matching titles or a different PR number', () => {
    expect(findSupersededPrs([open(2461, 'same title')], [{ number: 2505, title: 'same title' }], new Map())).toEqual([]);
    expect(findSupersededPrs([open(2461)], [{ number: 2505, title: 'RQ-PHX-FAKE1' }],
      new Map([['RQ-PHX-FAKE1', 'PR #24610']]))).toEqual([]);
  });

  it('does not treat an open redo as merged', () => {
    expect(findSupersededPrs([open(2461), open(2505, 'RQ-PHX-FAKE1')], [],
      new Map([['RQ-PHX-FAKE1', 'Redo PR #2461']]))).toEqual([]);
  });

  it('reports rows and the remaining DIRTY count as JSON using only list reads', async () => {
    const gh = vi.fn<NonNullable<FleetSupersededDeps['gh']>>(async args => ({
      ok: true, stderr: '', stdout: JSON.stringify(args.includes('open')
        ? [open(2461), open(22), open(23, 'clean', 'CLEAN')]
        : [{ number: 2505, title: 'RQ-PHX-FAKE1' }]),
    }));
    const result = await cmdFleetSuperseded(['--json'], { gh, prompts: async () => new Map([['RQ-PHX-FAKE1', 'Redo PR #2461']]) });
    expect(result).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ total: 1, dirtyRemaining: 1, complete: true, rows: [{ pr: { number: 2461 }, supersededBy: { number: 2505 } }] });
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls.every(([args]) => args[0] === 'pr' && args[1] === 'list' && args.includes('--repo') && args.includes('ashlrai/phantom'))).toBe(true);
  });

  it('prints the total followed by remaining DIRTY PRs', async () => {
    const gh: NonNullable<FleetSupersededDeps['gh']> = async args => ({ ok: true, stderr: '', stdout: JSON.stringify(args.includes('open') ? [open(2461), open(22)] : [{ number: 2505, title: 'RQ-PHX-FAKE1' }]) });
    expect(await cmdFleetSuperseded([], { gh, prompts: async () => new Map([['RQ-PHX-FAKE1', 'PR #2461']]) })).toBe(0);
    expect(output).toEqual(['#2461 original -> merged #2505 (RQ-PHX-FAKE1: PR #2461)', 'Total superseded: 1', 'DIRTY PRs remaining: 1']);
  });

  it.each(['failed', 'thrown', 'invalid'] as const)('reports gh %s as unavailable', async failure => {
    const gh: NonNullable<FleetSupersededDeps['gh']> = async () => {
      if (failure === 'thrown') throw new Error('fake failure');
      return { ok: failure !== 'failed', stdout: 'invalid', stderr: 'fake failure' };
    };
    expect(await cmdFleetSuperseded([], { gh })).toBe(1);
    expect(errors).toContain('backlog unavailable');
    expect(output).toEqual([]);
  });

  it('does not associate an ambiguous title with either job', () => {
    expect(findSupersededPrs([open(2461)], [{ number: 2505, title: 'RQ-PHX-FAKE1 RQ-PHX-FAKE2' }],
      new Map([['RQ-PHX-FAKE1', 'PR #2461']]))).toEqual([]);
  });

  it('marks a capped list incomplete', async () => {
    const gh: NonNullable<FleetSupersededDeps['gh']> = async args => ({
      ok: true, stderr: '', stdout: JSON.stringify(args.includes('open') ? Array.from({ length: 1000 }, (_, i) => open(i + 1)) : []),
    });
    expect(await cmdFleetSuperseded(['--json'], { gh, prompts: async () => new Map() })).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ complete: false, dirtyRemaining: 1000 });
  });

  it('rejects malformed open rows and invalid options', async () => {
    const gh: NonNullable<FleetSupersededDeps['gh']> = async () => ({ ok: true, stdout: '[{"number":1,"title":"fake"}]', stderr: '' });
    expect(await cmdFleetSuperseded([], { gh })).toBe(1);
    expect(errors).toContain('backlog unavailable');
    expect(await cmdFleetSuperseded(['--wrong'], { gh })).toBe(2);
  });

  it('fails when prompts cannot be read instead of reporting an empty backlog', async () => {
    const gh: NonNullable<FleetSupersededDeps['gh']> = async () => ({ ok: true, stdout: '[]', stderr: '' });
    expect(await cmdFleetSuperseded([], { gh, prompts: async () => { throw new Error('fake failure'); } })).toBe(1);
    expect(errors).toContain('prompts unavailable');
  });
});
