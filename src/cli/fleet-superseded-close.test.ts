import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSupersededClose, type FleetSupersededCloseDeps } from './fleet-superseded-close.js';
import type { OpenFleetPr } from '../core/fleet/superseded-prs.js';

const open = (number: number, title = 'original', mergeStateStatus = 'DIRTY'): OpenFleetPr =>
  ({ number, title, mergeStateStatus });
const openPrs = [
  open(2461, 'bridge: RQ-PHX-FAKE1: first fake'),
  open(2406, 'bridge: RQ-PHX-FAKE2: second fake'),
  open(2379, 'bridge: RQ-PHX-FAKE3: third fake'),
];
const mergedPrs = [
  { number: 2505, title: 'bridge: RQ-PHX-FAKE1 recut' },
  { number: 2500, title: 'bridge: RQ-PHX-FAKE2 recut' },
];
const promptMap = new Map([
  ['RQ-PHX-FAKE1', 'Redo PR #2461.'],
  ['RQ-PHX-FAKE2', 'Redo PR #2406.'],
]);
const gh: NonNullable<FleetSupersededCloseDeps['gh']> = async args => ({
  ok: true, stderr: '', stdout: JSON.stringify(args.includes('open') ? openPrs : mergedPrs),
});

let output: string[];
let errors: string;
let root: string;
let deps: FleetSupersededCloseDeps;
let calls: string[][];
beforeEach(async () => {
  output = []; errors = ''; calls = [];
  root = await mkdtemp(join(tmpdir(), 'fleet-superseded-close-'));
  deps = {
    gh,
    prompts: async () => promptMap,
    runner: async (_file, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    runsDir: root,
  };
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('fleet superseded-close', () => {
  it('is a dry run by default: prints the plan and never calls the runner', async () => {
    expect(await cmdFleetSupersededClose([], deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(output).toEqual([
      '#2461 bridge: RQ-PHX-FAKE1: first fake -> merged #2505',
      '#2406 bridge: RQ-PHX-FAKE2: second fake -> merged #2500',
      'dry run: add --apply to close',
    ]);
  });

  it('--apply calls the runner once per planned row', async () => {
    expect(await cmdFleetSupersededClose(['--apply'], deps)).toBe(0);
    expect(calls).toEqual([
      ['pr', 'close', '2461', '--repo', 'ashlrai/phantom', '--comment', 'Superseded by #2505 (merged). Closed by ashlr fleet superseded-close.'],
      ['pr', 'close', '2406', '--repo', 'ashlrai/phantom', '--comment', 'Superseded by #2500 (merged). Closed by ashlr fleet superseded-close.'],
    ]);
  });

  it('--json prints the plan', async () => {
    expect(await cmdFleetSupersededClose(['--json'], deps)).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({
      repo: 'ashlrai/phantom', apply: false, attempted: 0, closed: 0, failed: 0, total: 2,
      rows: [{ number: 2461, supersededBy: 2505 }, { number: 2406, supersededBy: 2500 }],
    });
  });

  it('--limit 1 closes one', async () => {
    expect(await cmdFleetSupersededClose(['--apply', '--limit', '1'], deps)).toBe(0);
    expect(calls).toEqual([
      ['pr', 'close', '2461', '--repo', 'ashlrai/phantom', '--comment', 'Superseded by #2505 (merged). Closed by ashlr fleet superseded-close.'],
    ]);
  });

  it('exits 1 when an apply stops on a failure', async () => {
    deps.runner = async (_file, args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'fake close failure' }; };
    expect(await cmdFleetSupersededClose(['--apply'], deps)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(output.at(-1)).toBe('closed 0, failed 1; 1 not attempted');
  });

  it('prints usage and never reads gh for help or a bad flag', async () => {
    expect(await cmdFleetSupersededClose(['--help'])).toBe(0);
    expect(output[0]).toContain('Usage: ashlr fleet superseded-close');
    expect(await cmdFleetSupersededClose(['--bogus'], deps)).toBe(2);
    expect(await cmdFleetSupersededClose(['--limit'], deps)).toBe(2);
    expect(await cmdFleetSupersededClose(['--limit', 'abc'], deps)).toBe(2);
    expect(calls).toEqual([]);
  });

  it('reports backlog and prompt read failures', async () => {
    deps.gh = async () => ({ ok: false, stdout: '', stderr: 'fake failure' });
    expect(await cmdFleetSupersededClose([], deps)).toBe(1);
    expect(errors).toContain('backlog unavailable');
    deps.gh = gh;
    deps.prompts = async () => { throw new Error('fake failure'); };
    expect(await cmdFleetSupersededClose([], deps)).toBe(1);
    expect(errors).toContain('prompts unavailable');
  });
});
