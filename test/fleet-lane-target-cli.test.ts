/** fleet-lane-target-cli.test.ts — `ashlr fleet lane-target`: read table over
 * queue/slots.json, single-lane row, bounded write through setLaneTarget,
 * --json pass-through, held-lane notice. Temp runs dirs; plainly fake values. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetLaneTarget, formatLaneTargets } from '../src/cli/fleet-lane-target.js';
import { readLaneTargets, type LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

let runsDir: string;
let path: string;
const fixture = () => ({ lanes: {
  devin: { target: 8, floor: 0, ceiling: 10, held: false, last_change: 1793448000, changed_by: 'Fake leader 2026-10-31T19:28:00Z' },
  sol: { target: 2, floor: 0, ceiling: 4, held: true, held_reason: 'fake hold for tests', held_until: '2026-11-02T00:00:00Z', paused_from: 3 },
  claude: { target: 1, floor: 1, ceiling: 3, held: false },
}, metadata: { keep: 'everything' } });
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-target-cli-'));
  await mkdir(join(runsDir, 'queue'));
  path = join(runsDir, 'queue/slots.json');
  await writeFile(path, JSON.stringify(fixture(), null, 1));
});
afterEach(async () => rm(runsDir, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const [log, err] = [console.log, process.stderr.write];
  console.log = (msg?: unknown) => { logs.push(String(msg)); };
  process.stderr.write = ((chunk: unknown) => { errs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await cmdFleetLaneTarget(args), out: logs.join('\n'), err: errs.join('') }; }
  finally { console.log = log; process.stderr.write = err; }
}

it('tables every lane in file order with bounds, holds and attribution', async () => {
  const { code, out } = await run(['--runs-dir', runsDir]);
  expect(code).toBe(0);
  expect(out.indexOf('devin')).toBeLessThan(out.indexOf('sol'));
  expect(out.indexOf('sol')).toBeLessThan(out.indexOf('claude'));
  expect(out).toContain('floor..ceiling');
  expect(out).toContain('0..10');
  expect(out).toContain('held: fake hold for tests until 2026-11-02T00:00:00Z');
  expect(out).toContain('target was 3');
  expect(out).toContain('Fake leader 2026-10-31T19:28:00Z');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(fixture()); // read-only
});

it('renders a pure snapshot with no I/O and notes a degraded source', () => {
  const snapshot: LaneTargetsV1 = { v: 1, generatedAt: '2026-11-01T11:00:00Z', sourceState: 'degraded', lanes: [
    { lane: 'fake', target: 0, floor: 0, ceiling: 2, held: true, heldReason: null, heldUntil: null, pausedFrom: 1, lastChange: null, changedBy: null },
    { lane: 'idle', target: 0, floor: 0, ceiling: 6, held: false, heldReason: null, heldUntil: null, pausedFrom: 4, lastChange: null, changedBy: 'Fake agent 2026-11-01T10:00:00Z' },
  ] };
  const text = formatLaneTargets(snapshot, Date.parse('2026-11-01T12:00:00Z'));
  expect(text).toContain('degraded');
  expect(text).toContain('held · target was 1');
  expect(text).toContain('target was 4'); // unheld lane still shows its remembered target
  expect(text).toContain('Fake agent 2026-11-01T10:00:00Z');
  expect(text).toContain('—');
});

it('prints one lane row and reports lane-unknown for an absent lane', async () => {
  const one = await run(['devin', '--runs-dir', runsDir]);
  expect(one.code).toBe(0);
  expect(one.out).toContain('devin');
  expect(one.out).not.toContain('claude');
  expect(one.out).not.toContain('held: fake hold');
  const missing = await run(['ghost', '--runs-dir', runsDir]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('lane-unknown');
  await rm(path);
  const noSource = await run(['devin', '--runs-dir', runsDir]);
  expect(noSource.code).toBe(1);
  expect(noSource.err).toContain('lane-unknown');
  expect(noSource.err).toContain('missing');
  const table = await run(['--runs-dir', runsDir]);
  expect(table.out).toContain('no lanes');
});

it('sets only the named lane target and prints old -> new with the ceiling', async () => {
  const { code, out } = await run(['devin', '10', '--runs-dir', runsDir]);
  expect(code).toBe(0);
  expect(out).toBe('devin: 8 -> 10 (ceiling 10)');
  const written = JSON.parse(await readFile(path, 'utf8'));
  expect(written.lanes.devin.target).toBe(10);
  expect(written.lanes.devin.changed_by).toContain('ashlr fleet lane-target');
  expect(written.lanes.sol).toEqual(fixture().lanes.sol); // untouched, byte for byte through JSON
  expect(written.lanes.claude).toEqual(fixture().lanes.claude);
  expect(written.metadata).toEqual(fixture().metadata);
});

it('refuses out-of-range, non-integer and unknown lanes with named codes', async () => {
  const original = await readFile(path, 'utf8');
  const range = await run(['devin', '11', '--runs-dir', runsDir]);
  expect(range.code).toBe(1);
  expect(range.err).toContain('out-of-range');
  const below = await run(['claude', '0', '--runs-dir', runsDir]);
  expect(below.code).toBe(1);
  expect(below.err).toContain('out-of-range');
  const nonInteger = await run(['devin', 'nine', '--runs-dir', runsDir]);
  expect(nonInteger.code).toBe(2);
  expect(nonInteger.err).toContain('invalid-target');
  const unknown = await run(['ghost', '1', '--runs-dir', runsDir]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('unknown-lane');
  expect(await readFile(path, 'utf8')).toBe(original); // refused writes never touch the file
});

it('emits the core snapshot through --json for reads and writes', async () => {
  const read = await run(['--json', '--runs-dir', runsDir]);
  expect(read.code).toBe(0);
  expect(JSON.parse(read.out).lanes.map((l: { lane: string }) => l.lane)).toEqual(['devin', 'sol', 'claude']);
  const write = await run(['devin', '9', '--json', '--runs-dir', runsDir]);
  expect(write.code).toBe(0);
  const emitted = JSON.parse(write.out) as LaneTargetsV1;
  expect(emitted.v).toBe(1);
  expect(emitted).toMatchObject({ sourceState: 'healthy' });
  expect(emitted.lanes).toEqual((await readLaneTargets({ runsDir })).lanes);
  expect(write.out).not.toContain('->');
});

it('prints the held notice only for held lanes and records --reason', async () => {
  const held = await run(['sol', '4', '--reason', 'fake order', '--runs-dir', runsDir]);
  expect(held.code).toBe(0);
  expect(held.out).toContain('sol: 2 -> 4 (ceiling 4)');
  expect(held.out).toContain('held: fake hold for tests');
  expect(held.out).toContain('the target applies when the hold lifts');
  expect(JSON.parse(await readFile(path, 'utf8')).lanes.sol.changed_by).toContain('ashlr fleet lane-target: fake order');
  const free = await run(['claude', '2', '--runs-dir', runsDir]);
  expect(free.code).toBe(0);
  expect(free.out).toBe('claude: 1 -> 2 (ceiling 3)');
  expect(free.out).not.toContain('held');
});

it.each([
  ['--bogus'], ['devin', '1', 'extra'], ['--runs-dir', 'relative/path'],
  ['devin', '--reason', 'no target'], ['devin', '1', '--reason'], ['devin', '1', '--runs-dir'],
])('rejects usage error %j with exit 2', async (...args: string[]) => {
  expect((await run(args)).code).toBe(2);
});
