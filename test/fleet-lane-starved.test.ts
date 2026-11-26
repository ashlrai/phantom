/**
 * fleet-lane-starved.test.ts : RQ-STARVEN20MQ8. A lane is starved when it has
 * free slots and no ready rows; held and full lanes are not. Covers the lanes
 * read's `starved` object, the plain line, `phm fleet starved --json`, and the
 * 30 minute / 6 hour Leader-chat notice. Fixtures use a temp dir only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';
import {
  parseStarvedState, planStarvedNotices, postStarvedNotices, readStarved, starvedLine,
  STARVED_NOTICE_AFTER_MS, STARVED_NOTICE_GAP_MS, STARVED_STATE_FILE, type StarvedInput,
} from '../src/core/fleet/lane-starved.js';
import { cmdFleetStarved, explainFleetStarved, FLEET_STARVED_SCHEMA } from '../src/cli/fleet-starved.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-starved-lanes-'));
  dirs.push(dir);
  return dir;
}
const input = (over: Partial<StarvedInput> = {}): StarvedInput => ({ lane: 'claude', target: 8, running: 0, ready: 0, held: false, drained: false, ...over });

describe('readStarved', () => {
  it('marks a lane with free slots and no ready rows, with the plain line', () => {
    const read = readStarved([input()], { claude: minutesAgo(42) }, NOW);
    expect(read.lanes.claude).toEqual({
      free_slots: 8, ready_rows: 0, starved: true, starved_since: minutesAgo(42),
      line: 'claude: 8 free slots, 0 ready rows for 42 min; next step: add work for claude',
    });
  });

  it('leaves the age out until a first sighting is recorded and uses singular words', () => {
    const read = readStarved([input({ target: 1 })], {}, NOW);
    expect(read.lanes.claude!.starved_since).toBeNull();
    expect(read.lanes.claude!.line).toBe('claude: 1 free slot, 0 ready rows; next step: add work for claude');
  });

  it('does not call a held lane starved, and counts its ready rows as waiting elsewhere', () => {
    const read = readStarved([input(), input({ lane: 'devin', target: 4, ready: 3, held: true })], {}, NOW);
    expect(read.lanes.devin).toEqual({ free_slots: 0, ready_rows: 3, starved: false, starved_since: null, line: null });
    expect(read.waiting_elsewhere).toBe(3);
  });

  it('does not call a held lane with no ready rows starved either', () => {
    const read = readStarved([input({ held: true })], { claude: minutesAgo(5) }, NOW);
    expect(read.lanes.claude).toMatchObject({ free_slots: 0, starved: false, starved_since: null });
  });

  it('does not call a full lane starved', () => {
    const read = readStarved([input({ lane: 'codex', target: 2, running: 2 })], {}, NOW);
    expect(read.lanes.codex).toMatchObject({ free_slots: 0, ready_rows: 0, starved: false });
    expect(read.waiting_elsewhere).toBe(0);
  });

  it('does not call a lane with ready rows, a drained lane or an unreadable lane starved', () => {
    const read = readStarved([
      input({ lane: 'busy', ready: 2 }), input({ lane: 'dry', drained: true }),
      input({ lane: 'blind', ready: null }), input({ lane: 'notarget', target: null }),
    ], {}, NOW);
    expect(Object.values(read.lanes).some(row => row.starved)).toBe(false);
    expect(read.lanes.blind!.ready_rows).toBeNull();
    expect(read.lanes.notarget!.free_slots).toBeNull();
  });

  it('counts rows waiting on a drained pool only while some lane is starved', () => {
    const drained = input({ lane: 'dry', drained: true, ready: 4 });
    expect(readStarved([input(), drained], {}, NOW).waiting_elsewhere).toBe(4);
    expect(readStarved([input({ ready: 1 }), drained], {}, NOW).waiting_elsewhere).toBe(0);
  });

  it('does not call a lane starved while lane-open rows wait as open supply', () => {
    // The market may place unhinted READY rows on any lane, so a positive
    // open-row count means no lane is out of work — matching fleet unfed,
    // which counts the same rows as waitingElsewhere for every lane.
    const read = readStarved([input()], { claude: minutesAgo(42) }, NOW, 2);
    expect(read.lanes.claude).toMatchObject({ free_slots: 8, ready_rows: 0, starved: false, starved_since: null, line: null });
    expect(read.waiting_elsewhere).toBe(0);
    expect(read.open_rows).toBe(2);
  });

  it('still calls a lane starved when the open-row count is zero or unknown', () => {
    expect(readStarved([input()], {}, NOW, 0).lanes.claude!.starved).toBe(true);
    expect(readStarved([input()], {}, NOW, 0).open_rows).toBe(0);
    const unknown = readStarved([input()], {}, NOW);
    expect(unknown.lanes.claude!.starved).toBe(true);
    expect(unknown.open_rows).toBeNull();
  });

  it('ignores a first sighting in the future', () => {
    expect(readStarved([input()], { claude: new Date(NOW + 60_000).toISOString() }, NOW).lanes.claude!.starved_since).toBeNull();
    expect(starvedLine('claude', { free_slots: 2, ready_rows: 0, starved_since: minutesAgo(180) }, NOW)).toContain('for 3 h;');
  });
});

describe('lanes read: starved object', () => {
  it.each([
    { configuredHeld: false, dispatcherHeld: true, tickAgeMs: 0, held: true },
    { configuredHeld: true, dispatcherHeld: false, tickAgeMs: 0, held: true },
    { configuredHeld: false, dispatcherHeld: true, tickAgeMs: 5 * 60_000, held: false },
  ])('honors holds from the slots file or a fresh dispatcher tick (%j)', async ({
    configuredHeld, dispatcherHeld, tickAgeMs, held,
  }) => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir);
    await writeFile(join(queueDir, 'ready.tsv'), 'id\tstatus\tpool\nj1\tRUNNING\tclaude\n');
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      claude: { target: 4, floor: 0, ceiling: 4, held: configuredHeld, held_reason: configuredHeld ? 'manual pause' : null },
    }), { mode: 0o600 });
    await writeFile(join(queueDir, 'status.json'), JSON.stringify({
      last_tick: new Date(NOW - tickAgeMs).toISOString(),
      lanes: { claude: { running: 1, target: 4, queued: 0, held: dispatcherHeld } },
    }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root,
    });
    expect(snap.lanes.find(lane => lane.lane === 'claude')).toMatchObject({
      hold: { held, reason: configuredHeld ? 'manual pause' : null },
      health: { state: held ? 'held' : 'starved' },
    });
    expect(snap.starved.lanes.claude).toMatchObject({ free_slots: held ? 0 : 3, ready_rows: 0, starved: !held });
  });

  it.each([
    { effectiveTarget: 8, launchTarget: 2 },
    { effectiveTarget: 1, launchTarget: 1 },
    { effectiveTarget: 0, launchTarget: 0 },
  ])('uses the configured target and effective ceiling ($effectiveTarget)', async ({ effectiveTarget, launchTarget }) => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir);
    await writeFile(join(queueDir, 'ready.tsv'), '');
    await writeFile(join(queueDir, 'status.json'), JSON.stringify({
      last_tick: new Date(NOW).toISOString(),
      lanes: { claude: { running: 2, target: 2, effective_target: effectiveTarget, queued: 0, held: false } },
    }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root,
    });
    expect(snap.lanes.find(lane => lane.lane === 'claude')).toMatchObject({ slotTarget: launchTarget, health: { state: 'ok' } });
    expect(snap.starved.lanes.claude).toMatchObject({ free_slots: 0, ready_rows: 0, starved: false });
  });

  it.each([
    { label: 'parked work', readyTsv: 'RQ-PARKED\tphantom\tPARKED-DEP.claude\twork\tprompts/job.md\n', queued: 1, ready: 0 },
    { label: 'ready work ahead of the dispatcher tick', readyTsv: 'RQ-READY\tphantom\tclaude\twork\tprompts/job.md\n', queued: 0, ready: 1 },
    { label: 'missing evidence', readyTsv: null, queued: 0, ready: null },
    { label: 'degraded evidence', readyTsv: 'unparseable\n', queued: 0, ready: null },
  ])('uses ready supply for starvation with $label', async ({ readyTsv, queued, ready }) => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir);
    if (readyTsv !== null) await writeFile(join(queueDir, 'ready.tsv'), readyTsv);
    await writeFile(join(queueDir, 'status.json'), JSON.stringify({
      last_tick: new Date(NOW).toISOString(),
      lanes: { claude: { running: 0, target: 8, queued, held: false } },
    }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root,
    });
    expect(snap.lanes.find(lane => lane.lane === 'claude')).toMatchObject({
      queueDepth: queued,
      health: { state: ready === 0 ? 'starved' : 'ok' },
    });
    expect(snap.starved.lanes.claude).toMatchObject({ free_slots: 8, ready_rows: ready, starved: ready === 0 });
    expect(snap.starved.open_rows).toBe(ready === null ? null : 0);
  });

  it.each([
    { label: 'a reassigned job', attrs: 'tier=work, preferred_lane=claude', claudeReady: 1, devinReady: 0, open: 0 },
    { label: 'an open job', attrs: 'tier=work', claudeReady: 0, devinReady: 0, open: 1 },
    { label: 'an unreadable envelope file', attrs: null, claudeReady: null, devinReady: null, open: null },
  ])('uses envelope evidence for starvation with $label', async ({ attrs, claudeReady, devinReady, open }) => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir);
    await writeFile(join(queueDir, 'ready.tsv'), 'RQ-ENVELOPE\tphantom\tdevin\twork\tprompts/job.md\n');
    const routerPath = join(queueDir, 'router-queue.md');
    if (attrs === null) await mkdir(routerPath);
    else await writeFile(routerPath, `- READY RQ-ENVELOPE (${attrs}): Job\n`);
    await writeFile(join(queueDir, 'status.json'), JSON.stringify({
      last_tick: new Date(NOW).toISOString(),
      lanes: {
        claude: { running: 0, target: 4, held: false },
        devin: { running: 0, target: 4, held: false },
      },
    }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root,
    });
    expect(snap.starved.lanes.claude).toMatchObject({ ready_rows: claudeReady, starved: false });
    expect(snap.starved.lanes.devin).toMatchObject({ ready_rows: devinReady, starved: open === 0 });
    expect(snap.starved.open_rows).toBe(open);
  });

  it('reports starved, held and full lanes from queue files', async () => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, 'ready.tsv'), ['id\tstatus\tpool', 'j1\tREADY\tdevin', 'j2\tREADY\tdevin', 'j3\tRUNNING\tcodex', 'j4\tRUNNING\tcodex'].join('\n'));
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      claude: { target: 8, floor: 8, ceiling: 12 },
      devin: { target: 4, floor: 4, ceiling: 4, held: true, held_reason: 'rate limit' },
      codex: { target: 2, floor: 2, ceiling: 4 },
    }), { mode: 0o600 });
    const stateDir = await scratch();
    await writeFile(join(stateDir, STARVED_STATE_FILE), JSON.stringify({ since: { claude: minutesAgo(42) }, noticed: {} }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: stateDir,
    });
    expect(snap.starved.lanes.claude).toMatchObject({
      free_slots: 8, ready_rows: 0, starved: true, starved_since: minutesAgo(42),
      line: 'claude: 8 free slots, 0 ready rows for 42 min; next step: add work for claude',
    });
    expect(snap.starved.lanes.devin).toMatchObject({ free_slots: 0, ready_rows: 2, starved: false, starved_since: null });
    expect(snap.starved.lanes.codex).toMatchObject({ free_slots: 0, ready_rows: 0, starved: false });
    expect(snap.starved.waiting_elsewhere).toBe(2);
  });

  it('judges against the slot target, not the reserve floor', async () => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, 'ready.tsv'), ['id\tstatus\tpool', 'j1\tRUNNING\tclaude', 'j2\tRUNNING\tclaude'].join('\n'));
    // floor 1 is already met by two running jobs, but the lane should run 8.
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({ claude: { target: 8, floor: 1, ceiling: 12 } }), { mode: 0o600 });
    const snap = await getFleetLaneSnapshot({ queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root });
    expect(snap.starved.lanes.claude).toMatchObject({ free_slots: 6, ready_rows: 0, starved: true });
  });

  it('leaves every lane unjudged when the targets file is missing', async () => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, 'ready.tsv'), 'id\tstatus\tpool\nj1\tREADY\tdevin\n');
    const snap = await getFleetLaneSnapshot({ queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: root });
    expect(Object.values(snap.starved.lanes).every(row => !row.starved && row.free_slots === null)).toBe(true);
  });

  it('does not call a lane starved while lane-open ready.tsv rows wait as open supply', async () => {
    const root = await scratch();
    const queueDir = join(root, 'queue');
    await mkdir(queueDir, { recursive: true });
    // Dispatcher dialect: an empty lane cell is the market's open hint.
    await writeFile(join(queueDir, 'ready.tsv'), [
      'RQ-OPEN-A\tphantom\t\twork\t/Users/x/prompts/a.md',
      'RQ-OPEN-B\tphantom\t\tmid\tprompts/b.md\t{"preferred_lane":null}',
      'RQ-HINTED\tphantom\tdevin\twork\tprompts/c.md',
    ].join('\n'));
    await writeFile(join(queueDir, 'status.json'), JSON.stringify({
      last_tick: new Date(NOW).toISOString(),
      lanes: {
        claude: { running: 0, target: 8, held: false },
        devin: { running: 0, target: 4, held: false },
      },
    }));
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      claude: { target: 8, floor: 8, ceiling: 12 },
      devin: { target: 4, floor: 4, ceiling: 4 },
    }), { mode: 0o600 });
    const stateDir = await scratch();
    await writeFile(join(stateDir, STARVED_STATE_FILE), JSON.stringify({ since: { claude: minutesAgo(42) }, noticed: {} }));
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [], now: () => new Date(NOW), starvedStateDir: stateDir,
    });
    // claude has 8 free slots and no hinted ready rows, but two lane-open
    // rows are supply the market may place on it — fed, not starved.
    expect(snap.starved.lanes.claude).toMatchObject({ free_slots: 8, ready_rows: 0, starved: false, starved_since: null, line: null });
    expect(snap.starved.lanes.devin).toMatchObject({ ready_rows: 1, starved: false });
    expect(snap.starved.open_rows).toBe(2);
    expect(snap.sources.queue).toMatchObject({ state: 'healthy', unhinted: 2 });
  });
});

describe('phm fleet starved', () => {
  const status = JSON.stringify({ admission: { cap: 48, running: 4, reason: null }, lanes: { claude: { running: 0, target: 8, queued: 0, held: false } } });
  const read = readStarved([input(), input({ lane: 'devin', target: 4, ready: 3, held: true })], { claude: minutesAgo(42) }, NOW);

  it('prints the line, the waiting count and the typed JSON with a schema id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetStarved(['--json'], async () => status, async () => read)).toBe(1);
    const body = JSON.parse(String(log.mock.calls[0]![0]));
    expect(body.schema).toBe(FLEET_STARVED_SCHEMA);
    expect(body.waiting_elsewhere).toBe(3);
    expect(body.open_rows).toBeNull();
    expect(body.starved_lanes).toEqual([{
      lane: 'claude', free_slots: 8, ready_rows: 0, starved: true, starved_since: minutesAgo(42),
      line: 'claude: 8 free slots, 0 ready rows for 42 min; next step: add work for claude',
    }]);
    expect(await cmdFleetStarved([], async () => status, async () => read)).toBe(1);
    expect(String(log.mock.calls[1]![0]).split('\n').slice(0, 2)).toEqual([
      'claude: 8 free slots, 0 ready rows for 42 min; next step: add work for claude',
      '3 READY rows are waiting on a held or drained pool and could run on a starved lane instead.',
    ]);
  });

  it('reports open_rows and stays quiet while lane-open supply waits', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const open = readStarved([input()], { claude: minutesAgo(42) }, NOW, 3);
    expect(await cmdFleetStarved(['--json'], async () => status, async () => open)).toBe(0);
    const body = JSON.parse(String(log.mock.calls[0]![0]));
    expect(body.starved_lanes).toEqual([]);
    expect(body.open_rows).toBe(3);
  });

  it('stays quiet and exits 0 for a held or full fleet, and survives an unreadable lanes read', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calm = readStarved([input({ held: true }), input({ lane: 'codex', target: 2, running: 2 })], {}, NOW);
    expect(await cmdFleetStarved(['--json'], async () => status, async () => calm)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).starved_lanes).toEqual([]);
    expect(await cmdFleetStarved(['--json'], async () => status, async () => { throw new Error('nope'); })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]![0])).starved_lanes).toBeNull();
    expect(explainFleetStarved(JSON.parse(status)).waiting_elsewhere).toBe(0);
  });
});

describe('starved notice', () => {
  const read = readStarved([input()], {}, NOW);

  it('waits 30 minutes, posts once, then holds off for 6 hours', () => {
    let plan = planStarvedNotices(read, { since: {}, noticed: {} }, NOW);
    expect(plan.posts).toEqual([]);
    expect(plan.state.since.claude).toBe(new Date(NOW).toISOString());
    plan = planStarvedNotices(read, plan.state, NOW + STARVED_NOTICE_AFTER_MS);
    expect(plan.posts.map(p => p.text)).toEqual(['claude: 8 free slots, 0 ready rows for 30 min; next step: add work for claude.']);
    const noticed = { ...plan.state, noticed: { claude: NOW + STARVED_NOTICE_AFTER_MS } };
    expect(planStarvedNotices(read, noticed, NOW + STARVED_NOTICE_AFTER_MS + STARVED_NOTICE_GAP_MS - 1).posts).toEqual([]);
    expect(planStarvedNotices(read, noticed, NOW + STARVED_NOTICE_AFTER_MS + STARVED_NOTICE_GAP_MS).posts).toHaveLength(1);
  });

  it('forgets a lane once it has work again', () => {
    const state = { since: { claude: minutesAgo(90) }, noticed: { claude: NOW - 1000 } };
    const fed = readStarved([input({ ready: 1 })], state.since, NOW);
    expect(planStarvedNotices(fed, state, NOW)).toEqual({ posts: [], state: { since: {}, noticed: state.noticed } });
  });

  it('posts through the state file and retries a failed post', async () => {
    const dir = await scratch();
    const late = readStarved([input()], { claude: minutesAgo(45) }, NOW);
    await writeFile(join(dir, STARVED_STATE_FILE), JSON.stringify({ since: { claude: minutesAgo(45) }, noticed: {} }));
    expect(await postStarvedNotices(late, { stateDir: dir, post: () => { throw new Error('down'); } }, NOW)).toEqual([]);
    expect(parseStarvedState(await readFile(join(dir, STARVED_STATE_FILE), 'utf8')).noticed).toEqual({});
    const post = vi.fn();
    expect(await postStarvedNotices(late, { stateDir: dir, post }, NOW)).toHaveLength(1);
    expect(await postStarvedNotices(late, { stateDir: dir, post }, NOW + 60_000)).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(parseStarvedState(await readFile(join(dir, STARVED_STATE_FILE), 'utf8')).noticed.claude).toBe(NOW);
  });

  it('survives damaged state', () => {
    expect(parseStarvedState('{ nope')).toEqual({ since: {}, noticed: {} });
    expect(parseStarvedState(JSON.stringify({ since: { 'bad lane': 'x', ok: 'nope' }, noticed: { ok: 'x' } }))).toEqual({ since: {}, noticed: {} });
  });
});
