import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { controllerBacklogItems } from '../src/core/improve/controller-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-controller-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const REPO = 'ashlrai/phantom';

interface TickRow {
  schema: 'fleet-controller.ledger.v1';
  ts: number;
  mode?: string;
  shed_level?: number | null;
  shed?: string;
  shed_reasons?: string[];
  shadow?: { shed_level: number; shed: string; reasons: string[]; targets?: Record<string, number> } | null;
  signals?: Record<string, unknown>;
  objective_score?: number | null;
  quality_receipts?: Array<Record<string, unknown>>;
  ambiguous_holds?: string[];
}

/** A dispatchd-tick row: healthy defaults, fields overridden per fixture. */
const tick = (atSec: number, over: Partial<TickRow> = {}): TickRow => ({
  schema: 'fleet-controller.ledger.v1',
  ts: atSec,
  mode: 'enforce',
  shed_level: 0,
  shed: 'normal',
  shed_reasons: [],
  signals: {
    load1: 8, load5: 7, load15: 6, ncpu: 18, mem_free_pct: 40, memory_pressure: 1,
    swap_gb: 0, swap_growth_gb: 0, procs: 300, worktrees: 5, disk_free_gb: 200,
    merge_rate_1h: 2.5, ci_fail_rate: 0.1, closed_unmerged_rate: 0.2,
    missing: [], degraded: [],
  },
  objective_score: 2.1,
  quality_receipts: [
    { schema: 'route.quality.v1', lane: 'claude', reason: 'same_quality', score: 0.9, resolved: 30 },
  ],
  ambiguous_holds: [],
  ...over,
});

const ledgerText = (rows: TickRow[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A runs dir holding metrics/fleet-controller.jsonl with the given rows (or raw text), optionally a .1 generation. */
const writeRuns = (name: string, rows: TickRow[] | string, older?: TickRow[] | string): string => {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'metrics', 'fleet-controller.jsonl'), typeof rows === 'string' ? rows : ledgerText(rows));
  if (older !== undefined) {
    fs.writeFileSync(path.join(dir, 'metrics', 'fleet-controller.jsonl.1'), typeof older === 'string' ? older : ledgerText(older));
  }
  return dir;
};

/** Rows stamped inside the fixture days: two ticks per (day,hour) pair. */
const stamped = (make: (day: number, hh: number) => TickRow, days = [20, 21], hours = [1, 2, 3]): TickRow[] => {
  const rows: TickRow[] = [];
  for (const day of days) {
    for (const hh of hours) {
      const base = Date.UTC(2026, 10, day, hh) / 1000;
      rows.push({ ...make(day, hh), ts: base }, { ...make(day, hh), ts: base + 1200 });
    }
  }
  return rows;
};

describe('controllerBacklogItems', () => {
  it('turns recurring fail-closed missing readings into a priority-3 item', async () => {
    const rows = stamped(() => tick(0, {
      shed_level: 3, shed: 'freeze', shed_reasons: ['fail_closed:missing=load1,ncpu'],
      signals: { missing: ['load1', 'ncpu'], degraded: ['merge'] },
      objective_score: null,
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-fc', rows), now: NOW });
    const fc = items.find((i) => i.id.startsWith('controller-failclosed-'));
    expect(fc).toBeDefined();
    expect(fc!.id).toMatch(/^controller-failclosed-[0-9a-f]{16}$/);
    expect(validBacklogItem(fc!)).not.toBeNull();
    expect(fc).toMatchObject({ priority: 3, repo: REPO, area: 'fleet-controller' });
    expect(fc!.title).toContain('fail-closing');
    expect(fc!.prompt).toContain('missing:load1,ncpu');
    expect(fc!.prompt).toContain('fleet-controller.jsonl');
    expect(fc!.prompt).toContain('fleet_controller.py');
    expect(fc!.prompt).toContain('no-change');
    // The frozen shed level is itself recurring evidence.
    expect(items.some((i) => i.id === 'controller-shed')).toBe(true);
  });

  it('emits the shed umbrella and per-driver items for recurring applied shedding', async () => {
    const rows = stamped(() => tick(0, {
      shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'],
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-shed', rows), now: NOW });
    const shed = items.find((i) => i.id === 'controller-shed');
    expect(shed).toBeDefined();
    expect(validBacklogItem(shed!)).not.toBeNull();
    expect(shed).toMatchObject({ priority: 3, repo: REPO, area: 'fleet-controller' });
    expect(shed!.prompt).toContain('shed25');
    expect(shed!.prompt).toContain('procs');
    expect(shed!.prompt).toContain('fleet-controller.jsonl');
    const driver = items.find((i) => i.id.startsWith('controller-shedsig-'));
    expect(driver).toBeDefined();
    expect(driver!.title).toContain('procs');
    expect(driver!.prompt).toContain("'procs'");
    expect(driver!.prompt).toContain('process-count band');
  });

  it('emits the unapplied-shed item when shadow plans keep computing level ≥1', async () => {
    const rows = stamped(() => tick(0, {
      shed_level: 0, shed: 'normal', shed_reasons: ['shadow'], mode: 'shadow',
      shadow: { shed_level: 2, shed: 'shed25', reasons: ['load=2'], targets: { claude: 4 } },
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-shadow', rows), now: NOW });
    const unapplied = items.find((i) => i.id === 'controller-shed-unapplied');
    expect(unapplied).toBeDefined();
    expect(validBacklogItem(unapplied!)).not.toBeNull();
    expect(unapplied!.prompt).toContain('would-shed');
    expect(unapplied!.prompt).toContain('shadow');
    expect(items.some((i) => i.id === 'controller-shed')).toBe(false);
    // The would-be driver still counts as shed-driver evidence.
    expect(items.some((i) => i.id.startsWith('controller-shedsig-'))).toBe(true);
  });

  it('emits per-lane items for recurring ambiguous hold attribution', async () => {
    const rows = stamped(() => tick(0, { ambiguous_holds: ['claude-api'] }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-amb', rows), now: NOW });
    const lane = items.find((i) => i.id.startsWith('controller-ambiguous-'));
    expect(lane).toBeDefined();
    expect(lane!.id).toMatch(/^controller-ambiguous-[0-9a-f]{16}$/);
    expect(validBacklogItem(lane!)).not.toBeNull();
    expect(lane!.title).toContain('claude-api');
    expect(lane!.prompt).toContain('ambiguous_holds');
    expect(lane!.prompt).toContain('unheld while');
  });

  it('emits the objective-blind item when merge readings stay unreadable', async () => {
    const rows = stamped(() => tick(0, {
      objective_score: null,
      signals: { degraded: ['merge'], missing: [] },
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-obj', rows), now: NOW });
    const blind = items.find((i) => i.id === 'controller-objective-blind');
    expect(blind).toBeDefined();
    expect(validBacklogItem(blind!)).not.toBeNull();
    expect(blind!.prompt).toContain('objective_score null');
    expect(blind!.prompt).toContain('merge');
    // 'merge' in degraded is the same evidence, never a second degraded cell.
    expect(items.some((i) => i.id.startsWith('controller-blind-'))).toBe(false);
  });

  it('emits the quality-unmeasured item when receipts keep answering unmeasured', async () => {
    const rows = stamped(() => tick(0, {
      quality_receipts: [
        { schema: 'route.quality.v1', lane: 'claude', reason: 'unmeasured', score: null, resolved: null },
        { schema: 'route.quality.v1', lane: 'codex', reason: 'unmeasured', score: null, resolved: null },
      ],
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-quality', rows), now: NOW });
    const quality = items.find((i) => i.id === 'controller-quality-unmeasured');
    expect(quality).toBeDefined();
    expect(validBacklogItem(quality!)).not.toBeNull();
    expect(quality!.prompt).toContain('unmeasured');
    expect(quality!.prompt).toContain('eval-report');
  });

  it('emits per-signal items for recurring degraded readings', async () => {
    const rows = stamped(() => tick(0, {
      signals: { degraded: ['worktrees'], missing: [] },
    }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-deg', rows), now: NOW });
    const blind = items.find((i) => i.id.startsWith('controller-blind-'));
    expect(blind).toBeDefined();
    expect(blind!.title).toContain('worktrees');
    expect(blind!.prompt).toContain('worktree');
    expect(blind!.prompt).toContain('worktrees.ts');
  });

  it('stays quiet below the recurring bars', async () => {
    // Five firing hours clear the 4-hour per-key bar but not the 6-hour
    // umbrella bar: the driver item emits, the shed umbrella does not.
    const five = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [20, 21], [1, 2]).concat(
      stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [20], [3]),
    );
    const fiveItems = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-five', five), now: NOW });
    expect(fiveItems.some((i) => i.id === 'controller-shed')).toBe(false);
    expect(fiveItems.some((i) => i.id.startsWith('controller-shedsig-'))).toBe(true);
    // Three firing hours never reach either bar.
    const three = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [20, 21], [1]);
    expect(await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-three', three), now: NOW })).toEqual([]);
    // Six recurring hours all on ONE day is an incident, not a pattern.
    const oneDay = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [20], [1, 2, 3, 4, 5, 6]);
    expect(await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-one', oneDay), now: NOW })).toEqual([]);
    // Sparse ticks: shedding on a minority of each hour's rows never fires the hour.
    const sparse: TickRow[] = [];
    for (const day of [20, 21]) {
      for (const hh of [1, 2, 3]) {
        const base = Date.UTC(2026, 10, day, hh) / 1000;
        sparse.push(tick(base, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }));
        sparse.push(tick(base + 600), tick(base + 900));
      }
    }
    expect(await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-sparse', sparse), now: NOW })).toEqual([]);
    // No rows at all, and a missing ledger, are unknown — never a finding.
    expect(await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-empty', []), now: NOW })).toEqual([]);
    expect(await controllerBacklogItems({ repo: REPO, runsDir: path.join(home, 'no-such-runs'), now: NOW })).toEqual([]);
  });

  it('ignores rows outside the window, foreign schemas and damaged lines', async () => {
    const stale = stamped(() => tick(0, { shed_level: 3, shed: 'freeze', shed_reasons: ['fail_closed:missing=load1,ncpu'] }), [20, 21], [1, 2, 3])
      .map((r) => ({ ...r, ts: r.ts - 10 * 86_400 }));
    expect(await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-stale', stale), now: NOW })).toEqual([]);
    const dir = path.join(home, 'runs-damaged');
    fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
    const good = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['worktrees=2'] }));
    fs.writeFileSync(path.join(dir, 'metrics', 'fleet-controller.jsonl'),
      `not json\n{"schema":"other","ts":1}\n${ledgerText(good)}{"schema":"fleet-controller.ledger.v1","ts":"x"}\n`);
    const items = await controllerBacklogItems({ repo: REPO, runsDir: dir, now: NOW });
    expect(items.some((i) => i.id === 'controller-shed')).toBe(true);
    // A ledger of only damaged lines is unknown.
    const junk = writeRuns('runs-junk', 'not json\n{"schema":"fleet-controller.ledger.v1"}\n');
    expect(await controllerBacklogItems({ repo: REPO, runsDir: junk, now: NOW })).toEqual([]);
  });

  it('folds both ledger generations (.1 rotation + current)', async () => {
    // Three firing hours in .1 plus three in the current file: each
    // generation alone is below the six-hour umbrella bar.
    const older = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [20], [1, 2, 3]);
    const newer = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }), [21], [1, 2, 3]);
    const runsDir = writeRuns('runs-rot', newer, older);
    const items = await controllerBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items.some((i) => i.id === 'controller-shed')).toBe(true);
  });

  it('emits only for the fleet repository', async () => {
    const rows = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }));
    const runsDir = writeRuns('runs-repo', rows);
    expect(await controllerBacklogItems({ repo: 'ashlrai/lexicon', runsDir, now: NOW })).toEqual([]);
    expect(await controllerBacklogItems({ repo: '', runsDir, now: NOW })).toEqual([]);
    expect(await controllerBacklogItems({ repo: 'not-a-repo', runsDir, now: NOW })).toEqual([]);
    const items = await controllerBacklogItems({ repo: 'AshlrAI/Phantom', runsDir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.repo === 'AshlrAI/Phantom')).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = stamped(() => tick(0, {
      shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'], ambiguous_holds: ['claude-api'],
    }));
    const runsDir = writeRuns('runs-stable', rows);
    const first = await controllerBacklogItems({ repo: REPO, runsDir, now: NOW });
    const second = await controllerBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('honours the limit with fail-closed items first', async () => {
    const rows = stamped(() => tick(0, {
      shed_level: 3, shed: 'freeze', shed_reasons: ['fail_closed:missing=load1,ncpu'],
      signals: { missing: ['load1', 'ncpu'], degraded: [] },
    }));
    const runsDir = writeRuns('runs-limit', rows);
    const items = await controllerBacklogItems({ repo: REPO, runsDir, now: NOW, limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^controller-failclosed-/);
  });

  it('scrubs secret-shaped lane names before they reach a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const rows = stamped(() => tick(0, { ambiguous_holds: [token] }));
    const items = await controllerBacklogItems({ repo: REPO, runsDir: writeRuns('runs-secret', rows), now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.prompt).not.toContain(token);
      expect(item.title).not.toContain(token);
    }
  });

  it('reads the default runs dir under HOME and ASHLR_RUNS_DIR', async () => {
    const rows = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }));
    const dir = path.join(home, '.ashlr-runs');
    fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'metrics', 'fleet-controller.jsonl'), ledgerText(rows));
    const items = await controllerBacklogItems({ repo: REPO, now: NOW });
    expect(items.some((i) => i.id === 'controller-shed')).toBe(true);
    const envDir = path.join(home, 'env-runs');
    fs.mkdirSync(path.join(envDir, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(envDir, 'metrics', 'fleet-controller.jsonl'), ledgerText(rows));
    process.env.ASHLR_RUNS_DIR = envDir;
    const viaEnv = await controllerBacklogItems({ repo: REPO, now: NOW });
    expect(viaEnv.some((i) => i.id === 'controller-shed')).toBe(true);
  });

  it('appends controller items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_HOME = path.join(home, '.ashlr-e2e');
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs-e2e');
      const dir = path.join(home, 'runs-e2e');
      fs.mkdirSync(path.join(dir, 'metrics'), { recursive: true });
      const rows = stamped(() => tick(0, { shed_level: 2, shed: 'shed25', shed_reasons: ['procs=2'] }));
      fs.writeFileSync(path.join(dir, 'metrics', 'fleet-controller.jsonl'), ledgerText(rows));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const controller = first.items.filter((i) => i.id.startsWith('controller-'));
      expect(controller.length).toBeGreaterThan(0);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(controller)).toBe(controller.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('controller-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('controller-'))).toHaveLength(controller.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
