import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaunchable } from '../src/cli/fleet-launchable.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let queue: string;
const original = process.env.ASHLR_RUNS_DIR;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launchable-'));
  queue = join(root, 'queue');
  mkdirSync(queue);
  process.env.ASHLR_RUNS_DIR = root;
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (original === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = original;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const status = (lanes: unknown) => writeFileSync(join(queue, 'status.json'), JSON.stringify({ lanes }));
// Dispatcher dialect: job, repo, lane, tier, prompt[, requirements].
const row = (id: string, lane: string, prompt: string) => [id, 'repo', lane, 'work', prompt].join('\t');
const report = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));

describe('fleet launchable', () => {
  it('counts eligible rows and compares each lane with its free slots', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 4, running: 1 }, beta: { target: 1, running: 1 }, PARKEDx: { target: 0, running: 0 } });
    writeFileSync(join(queue, 'ready.tsv'), [
      row('good', 'alpha', prompt), row('A123456Q8', 'alpha', prompt),
      row('A12345Q8', 'alpha', prompt), row('missing', 'alpha', join(root, 'missing')),
      row('drop', 'alpha', prompt), row('defer', 'alpha', prompt), row('other', 'alpha', prompt),
      row('parked', 'PARKEDx', prompt), row('RQ-PD8', 'PARKED-DEP.alpha', prompt),
      'PARKED-DEP.alpha\tRQ-PD9\talpha\twork\t' + prompt,
      row('beta', 'beta', prompt), '# comment',
    ].join('\n'));
    writeFileSync(join(queue, 'skipped-empty.tsv'), 'time\tdrop\tdrop\treason\ntime\tdefer\tdefer\treason\ntime\tother\tobserve\treason\n');
    writeFileSync(join(queue, 'FILLER_HOLD'), '');
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report()).toMatchObject({ fillerHold: true, lanes: [
      { lane: 'alpha', free: 3, launchable: 3 }, { lane: 'beta', free: 0, launchable: 1 },
      { lane: 'PARKEDx', free: 0, launchable: 0 },
    ] });
    status({ alpha: { target: 5, running: 1 } });
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    rmSync(join(queue, 'FILLER_HOLD'));
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report().lanes[0].launchable).toBe(4);
  });
  it('resolves the market lane hint and counts lane-open rows as shared supply', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 2, running: 0 }, beta: { target: 1, running: 0 } });
    const spec = (value: string) => JSON.stringify(value);
    writeFileSync(join(queue, 'ready.tsv'), [
      // requirements preferred_lane beats the lane column
      ['RQ-HINT', 'work', 'alpha', 'work', prompt, spec({ preferred_lane: 'beta' })].join('\t'),
      // explicit null preferred_lane is lane-open even with a lane cell
      ['RQ-OPEN1', 'work', 'alpha', 'work', prompt, spec({ preferred_lane: null })].join('\t'),
      // empty lane cell with no requirements is lane-open
      ['RQ-OPEN2', 'work', '', 'work', prompt].join('\t'),
      // a hint to a lane the status does not list is neither supply nor open
      ['RQ-GHOST', 'work', 'alpha', 'work', prompt, spec({ preferred_lane: 'ghost' })].join('\t'),
      // specs the market rejects are dead work, never launchable
      ['RQ-BADC', 'work', 'alpha', 'work', prompt, spec({ preferred_lane: 'CLAUDE!' })].join('\t'),
      ['RQ-BADK', 'work', 'alpha', 'work', prompt, spec({ bogus: 1 })].join('\t'),
      ['RQ-BADJSON', 'work', 'alpha', 'work', prompt, 'not-json'].join('\t'),
    ].join('\n'));
    // alpha: 2 free, 0 hinted; beta: 1 free, 1 hinted; 2 lane-open rows can
    // fill either lane, so no lane is under-supplied.
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report()).toMatchObject({ openRows: 2, lanes: [
      { lane: 'alpha', free: 2, launchable: 0 },
      { lane: 'beta', free: 1, launchable: 1 },
    ] });
  });
  it('resolves spec-less rows through their router-queue envelope like the market', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 2, running: 0 }, beta: { target: 1, running: 0 } });
    writeFileSync(join(queue, 'router-queue.md'), [
      '- READY phantom RQ-ENV (preferred_lane=beta): hinted work',
      '- READY phantom RQ-ENVALPHA (preferred_lane=alpha): back on the column lane anyway',
      '- READY phantom RQ-ENVBAD (preferred_lane=CLAUDE!): rejected spec',
    ].join('\n'));
    writeFileSync(join(queue, 'ready.tsv'), [
      // spec-less rows: the envelope's preferred_lane beats the lane column
      row('RQ-ENV', 'alpha', prompt), row('RQ-ENVALPHA', 'alpha', prompt),
      row('RQ-ENVLONE', 'alpha', prompt), // no envelope line: the lane column stands
      row('RQ-ENVBAD', 'alpha', prompt), // envelope spec the market rejects: dead work
      // a spec-less row whose lane cell is not a lane id is invalid, envelope or not
      [ 'RQ-BADLANE', 'repo', 'Not A Lane!', 'work', prompt ].join('\t'),
    ].join('\n'));
    // beta gets RQ-ENV through its envelope; alpha gets RQ-ENVALPHA and
    // RQ-ENVLONE; RQ-ENVBAD and RQ-BADLANE are market-rejected, never supply.
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report()).toMatchObject({ openRows: 0, lanes: [
      { lane: 'alpha', free: 2, launchable: 2 },
      { lane: 'beta', free: 1, launchable: 1 },
    ] });
  });
  it('never counts rows the market would reject', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 5, running: 0 } });
    writeFileSync(join(queue, 'ready.tsv'), [
      row('good', 'alpha', prompt),
      // unknown tier: dispatchd skips it silently, so it can never launch
      ['RQ-TIER', 'repo', 'alpha', 'bogus', prompt].join('\t'),
      // job id the market rejects
      ['bad id!', 'repo', 'alpha', 'work', prompt].join('\t'),
      // repo cell carrying a path
      ['RQ-REPO', 'org/repo', 'alpha', 'work', prompt].join('\t'),
      // requirements cell that is not a JSON object
      ['RQ-REQ', 'repo', 'alpha', 'work', prompt, 'null'].join('\t'),
    ].join('\n'));
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    expect(report()).toMatchObject({ lanes: [{ lane: 'alpha', free: 5, launchable: 1 }] });
  });
  it('flags a lane only when even all lane-open supply cannot fill its free slots', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 4, running: 0 }, beta: { target: 1, running: 0 } });
    writeFileSync(join(queue, 'ready.tsv'), [
      row('RQ-OPEN', '', prompt), row('RQ-HINT', 'beta', prompt),
    ].join('\n'));
    // alpha has 4 free slots and only 1 lane-open row can reach it: under-supplied.
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    expect(report()).toMatchObject({ openRows: 1, lanes: [
      { lane: 'alpha', free: 4, launchable: 0 },
      { lane: 'beta', free: 1, launchable: 1 },
    ] });
    expect(await cmdFleetLaunchable([])).toBe(1);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('1 lane-open row(s) can start on any lane.');
  });
  it('counts free slots against the shed launch target', async () => {
    status({ shed: { target: 4, running: 3, effective_target: 3 }, room: { target: 4, running: 2, effective_target: 3 } });
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    expect(report().lanes).toEqual([
      { lane: 'room', running: 2, target: 3, free: 1, launchable: 0 },
      { lane: 'shed', running: 3, target: 3, free: 0, launchable: 0 },
    ]);
  });
  it('handles absent optional files and clamps negative free slots', async () => {
    status({ idle: { target: 2, running: 0 }, full: { target: 1, running: 2 } });
    expect(await cmdFleetLaunchable([])).toBe(1);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('idle: 0 launchable, 2 free slots');
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    expect(report().lanes.find((lane: { lane: string }) => lane.lane === 'full').free).toBe(0);
  });
  it('fails closed on missing or malformed status and rejects invalid arguments', async () => {
    expect(await cmdFleetLaunchable(['--json'])).toBe(2);
    expect(report().error).toMatch(/Cannot read/);
    status({ bad: { target: '2', running: 0 } });
    expect(await cmdFleetLaunchable(['--json'])).toBe(2);
    expect(await cmdFleetLaunchable(['--bad'])).toBe(2);
    expect(await cmdFleetLaunchable(['--help'])).toBe(0);
    expect(FLEET_SUBCOMMAND_LOADERS.launchable).toBeTypeOf('function');
  });
});
