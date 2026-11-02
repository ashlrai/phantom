import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { reassignQueuedJobs, ReassignError } from '../src/core/fleet/runs-reassign.js';

let runsDir: string;
let queueDir: string;
let readyPath: string;
let logPath: string;
const NOW = new Date('2026-11-01T00:00:00Z');
const now = () => NOW;
const sleep = async () => {};

const slots = () => ({ lanes: {
  'codex-personal': { target: 1, floor: 0, ceiling: 4, held: false },
  devin: { target: 2, floor: 0, ceiling: 6, held: false },
  claude: { target: 1, floor: 0, ceiling: 3, held: false },
  'codex-local': { target: 1, floor: 0, ceiling: 2, held: false },
  'held-lane': { target: 0, floor: 0, ceiling: 2, held: true, held_reason: 'fake hold', held_by: 'autobackoff' },
} });
const prompt = (id: string) => `${queueDir}/prompts/${id}.md`;
const row = (id: string, lane: string, tier = 'work', repo = 'phantom', extra = '') =>
  `${id}\t${repo}\t${lane}\t${tier}\t${prompt(id)}${extra}`;
const fixture = () => [
  row('RQ-PHX-FAKEONE01', 'codex-personal'),
  row('RQ-PHX-FAKETWO02', 'codex-personal', 'mid'),
  row('RQ-PHX-LAUNCHED9', 'codex-personal'),
  row('RQ-PHX-PARKED33', 'PARKED-BYHAND.codex-local'),
  row('RQ-OTHR-PLAIN04', 'codex-personal', 'work', 'otherrepo'),
  row('RQ-PHX-EXTRA005', 'codex-personal', 'work', 'phantom', '\tkeepme'),
].join('\n') + '\n';
const ready = async () => (await readFile(readyPath, 'utf8')).split('\n').filter(Boolean);
const logRows = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
const opts = { now, sleep, verifyMs: 0 };

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'runs-reassign-'));
  queueDir = join(runsDir, 'queue');
  await mkdir(join(queueDir, 'prompts'), { recursive: true });
  readyPath = join(queueDir, 'ready.tsv');
  logPath = join(queueDir, 'reassign.log');
  await writeFile(readyPath, fixture());
  await writeFile(join(queueDir, 'slots.json'), JSON.stringify(slots(), null, 1));
  await writeFile(join(queueDir, 'claude-lane.state'), 'up fake healthy\n');
  await writeFile(join(runsDir, 'RQ-PHX-LAUNCHED9.launch'), 'launched RQ-PHX-LAUNCHED9 codex-personal pid 42 base fake');
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it('dry run reports the plan and touches neither ready.tsv nor the log', async () => {
  const original = await readFile(readyPath, 'utf8');
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: false }, { runsDir, ...opts });
  expect(report).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), applied: false, lane: 'devin', verified: null });
  expect(report.moved).toEqual([{ id: 'RQ-PHX-FAKEONE01', fromLane: 'codex-personal', toLane: 'devin', fromTier: 'work', toTier: 'work' }]);
  expect(report.skipped).toEqual([]);
  expect(await readFile(readyPath, 'utf8')).toBe(original);
  await expect(readFile(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('apply moves exactly the planned row and leaves every other byte unchanged', async () => {
  const before = await ready();
  const report = await reassignQueuedJobs(
    { job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: true, reason: 'lane held overnight' },
    { runsDir, changedBy: 'Fake phone', ...opts });
  expect(report).toMatchObject({ applied: true, verified: true });
  expect(report.moved).toEqual([{ id: 'RQ-PHX-FAKEONE01', fromLane: 'codex-personal', toLane: 'devin', fromTier: 'work', toTier: 'work' }]);
  const after = await ready();
  expect(after[0]).toBe(row('RQ-PHX-FAKEONE01', 'devin'));
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(await logRows()).toEqual([
    `${NOW.toISOString()}\tRQ-PHX-FAKEONE01\tcodex-personal\tdevin\tFake phone\tlane held overnight`,
  ]);
});

it('retiers in place when only the tier changes', async () => {
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'codex-personal', tier: 'fast', apply: true }, { runsDir, ...opts });
  expect(report.moved).toEqual([{ id: 'RQ-PHX-FAKEONE01', fromLane: 'codex-personal', toLane: 'codex-personal', fromTier: 'work', toTier: 'fast' }]);
  expect((await ready())[0]).toBe(row('RQ-PHX-FAKEONE01', 'codex-personal', 'fast'));
});

it('from-lane mode moves every queued RQ-PHX row and skips launched, parked and foreign rows', async () => {
  const report = await reassignQueuedJobs({ fromLane: 'codex-personal', lane: 'devin', apply: true }, { runsDir, ...opts });
  expect(report).toMatchObject({ applied: true, verified: true });
  expect(report.moved.map((move) => move.id)).toEqual(['RQ-PHX-FAKEONE01', 'RQ-PHX-FAKETWO02', 'RQ-PHX-EXTRA005']);
  expect(report.skipped).toEqual([
    { id: 'RQ-PHX-LAUNCHED9', reason: 'job-launched' },
    { id: 'RQ-OTHR-PLAIN04', reason: 'not-phantom' },
  ]);
  const after = await ready();
  expect(after[2]).toBe(row('RQ-PHX-LAUNCHED9', 'codex-personal'));
  expect(after[4]).toBe(row('RQ-OTHR-PLAIN04', 'codex-personal', 'work', 'otherrepo'));
  expect(after[5]).toContain('devin\t');
  expect(after[5]).toContain('\tkeepme');
  expect(await logRows()).toHaveLength(3);
});

it('from-lane mode refuses when every matching row is blocked but still reports the skips', async () => {
  await writeFile(readyPath, `${row('RQ-PHX-LAUNCHED9', 'codex-personal')}\n`);
  const report = await reassignQueuedJobs({ fromLane: 'codex-personal', lane: 'devin', apply: true }, { runsDir, ...opts });
  expect(report).toMatchObject({ applied: true, verified: null, moved: [] });
  expect(report.skipped).toEqual([{ id: 'RQ-PHX-LAUNCHED9', reason: 'job-launched' }]);
});

it('refuses unknown lanes, unknown tiers, same lane+tier and missing jobs', async () => {
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'nope', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'lane-unknown', status: 422 });
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', tier: 'bogus', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'tier-unknown', status: 422 });
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'codex-personal', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'lane-same' });
  await expect(reassignQueuedJobs({ fromLane: 'codex-personal', lane: 'codex-personal', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'lane-same' });
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-NOPE9999', lane: 'devin', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'job-not-found', status: 404 });
});

it('refuses a launched job and a parked job in single-job mode', async () => {
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-LAUNCHED9', lane: 'devin', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'job-launched' });
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-PARKED33', lane: 'devin', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'job-parked' });
});

it('refuses a held lane unless forced', async () => {
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'held-lane', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'lane-held' });
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'held-lane', apply: true, force: true }, { runsDir, ...opts });
  expect(report.moved.map((move) => move.id)).toEqual(['RQ-PHX-FAKEONE01']);
  expect((await ready())[0]).toBe(row('RQ-PHX-FAKEONE01', 'held-lane'));
});

it('refuses claude while its lane state starts with down, unless forced', async () => {
  await writeFile(join(queueDir, 'claude-lane.state'), 'down fake maintenance window\n');
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'claude', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'lane-down' });
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'claude', apply: true, force: true }, { runsDir, ...opts });
  expect(report.moved.map((move) => move.id)).toEqual(['RQ-PHX-FAKEONE01']);
  expect((await ready())[0]).toBe(row('RQ-PHX-FAKEONE01', 'claude'));
});

it('reports queue-missing when ready.tsv is absent', async () => {
  await rm(readyPath);
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: false }, { runsDir, ...opts }))
    .rejects.toMatchObject({ code: 'queue-missing', status: 503 });
});

it('rejects a call with both job and fromLane or neither', async () => {
  await expect(reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', fromLane: 'devin', lane: 'devin', apply: false }, { runsDir, ...opts }))
    .rejects.toThrow(TypeError);
  await expect(reassignQueuedJobs({ lane: 'devin', apply: false }, { runsDir, ...opts })).rejects.toThrow(TypeError);
});

it('verifies after a reverted write and confirms the row on the second attempt', async () => {
  const original = await readFile(readyPath, 'utf8');
  let reverts = 1;
  const reverting = async () => { if (reverts-- > 0) await writeFile(readyPath, original); };
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: true },
    { runsDir, now, sleep: reverting });
  expect(report).toMatchObject({ applied: true, verified: true });
  expect(report.moved.map((move) => move.id)).toEqual(['RQ-PHX-FAKEONE01']);
  expect((await ready())[0]).toBe(row('RQ-PHX-FAKEONE01', 'devin'));
  expect(await logRows()).toHaveLength(1);
});

it('reports unverified, moves nothing and writes no log when every write reverts', async () => {
  const original = await readFile(readyPath, 'utf8');
  const reverting = async () => { await writeFile(readyPath, original); };
  const report = await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: true },
    { runsDir, now, sleep: reverting });
  expect(report).toMatchObject({ applied: true, verified: false, moved: [] });
  expect(report.skipped).toEqual([{ id: 'RQ-PHX-FAKEONE01', reason: 'unverified' }]);
  expect(await readFile(readyPath, 'utf8')).toBe(original);
  expect(await logRows()).toEqual([]);
});

it('scrubs control characters and caps the reason in the audit row', async () => {
  const reason = `fake\treason\n${'x'.repeat(300)}`;
  await reassignQueuedJobs({ job: 'RQ-PHX-FAKEONE01', lane: 'devin', apply: true, reason }, { runsDir, ...opts });
  const logged = await logRows();
  expect(logged).toHaveLength(1);
  const cells = logged[0]!.split('\t');
  expect(cells).toHaveLength(6);
  expect(cells[5]!.length).toBeLessThanOrEqual(200);
  expect(cells[5]).toContain('fake reason');
});

it('throws ReassignError with name and status', async () => {
  const error = await reassignQueuedJobs({ job: 'RQ-PHX-NOPE9999', lane: 'devin', apply: false }, { runsDir, ...opts }).catch((e) => e);
  expect(error).toBeInstanceOf(ReassignError);
  expect(error).toMatchObject({ name: 'ReassignError', code: 'job-not-found', status: 404 });
});
