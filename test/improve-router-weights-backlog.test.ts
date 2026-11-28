import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTER_WEIGHTS_MAX_ITEMS,
  ROUTER_WEIGHTS_MIN_SHIFT,
  routerWeightBacklogItems,
  type RouterWeightsItemsOptions,
} from '../src/core/improve/router-weights-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/**
 * A jobs.jsonl outcome row in the shape the recovery suite for
 * router.weight-proposals.v1 uses: lane/model/tier/work_class/phase
 * fields the outcome fold resolves — MERGED holds, CLOSED resolves
 * merged:false, VERIFIED leaves merged:null (unknown, never a failure).
 */
const event = (job: string, lane: string, workClass: string, phase: string | null): string =>
  J({ job, lane, model: 'synthetic-model', tier: 'work', work_class: workClass, ...(phase ? { phase } : {}) });
const mergedRows = (n: number, lane: string, workClass: string, prefix = 'm'): string[] =>
  Array.from({ length: n }, (_, i) => event(`${prefix}-${lane}-${workClass}-${i}`, lane, workClass, 'MERGED'));
const closedRows = (n: number, lane: string, workClass: string, prefix = 'c'): string[] =>
  Array.from({ length: n }, (_, i) => event(`${prefix}-${lane}-${workClass}-${i}`, lane, workClass, 'CLOSED'));
const unknownRows = (n: number, lane: string, workClass: string, prefix = 'u'): string[] =>
  Array.from({ length: n }, (_, i) => event(`${prefix}-${lane}-${workClass}-${i}`, lane, workClass, 'VERIFIED'));

describe('routerWeightBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'router-weights-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDir(name: string, ledger?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger.join('\n') + '\n');
    return dir;
  }
  const ashlar = (): string => {
    const dir = join(home, 'ashlr');
    return dir;
  };
  const opts = (dir: string, extra: Partial<RouterWeightsItemsOptions> = {}): RouterWeightsItemsOptions => ({
    repo: 'ashlrai/phantom', runsDir: dir, ashlarDir: ashlar(), authorityEvidence: [], ...extra,
  });

  it('emits one item per material proposal and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      ...mergedRows(20, 'codex', 'judgment'),
      ...closedRows(20, 'claude', 'bulk'),
      // Below the fold's 20-known-outcome floor: refused, never an item.
      ...mergedRows(5, 'devin', 'standard', 'few'),
      // merged:null outcomes are unknown evidence, never a proposal group.
      ...unknownRows(20, 'cursor', 'judgment', 'unk'),
    ]);
    const items = await routerWeightBacklogItems(opts(dir));
    expect(items).toHaveLength(2);
    const up = items.find((i) => i.prompt.includes("'judgment'") && i.prompt.includes("'codex'"))!;
    const down = items.find((i) => i.prompt.includes("'bulk'") && i.prompt.includes("'claude'"))!;
    expect(up).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'router-weights' });
    expect(up!.id).toMatch(/^fleet-router-weights-[0-9a-f]{16}$/);
    expect(validBacklogItem(up)).not.toBeNull();
    expect(up!.title).toContain('judgment/codex');
    expect(up!.prompt).toContain('0.5');
    expect(up!.prompt).toContain('proposed');
    expect(up!.prompt).toContain('20 known outcomes');
    expect(up!.prompt).toContain('phm fleet router-weights');
    expect(up!.prompt).toContain('no weights.json');
    expect(up!.prompt).toContain('no-change');
    expect(down!.prompt).toContain('under-merges');
    expect(down!.title).toContain('below');
  });

  it('emits nothing below the materiality bar or for another repository', async () => {
    // 2 merged + 2 closed on one group: known=4 >= minSamples override,
    // held-merge rate exactly 0.5 → shift 0 → 'proposed' but not material.
    const flat = await runsDir('runs-flat', [
      ...mergedRows(2, 'codex', 'judgment', 'f-m'),
      ...closedRows(2, 'codex', 'judgment', 'f-c'),
    ]);
    expect(await routerWeightBacklogItems(opts(flat, { minSamples: 2 }))).toEqual([]);

    const dir = await runsDir('runs-repo', mergedRows(20, 'codex', 'judgment'));
    expect(await routerWeightBacklogItems(opts(dir, { repo: 'ashlrai/other' }))).toEqual([]);
    expect(await routerWeightBacklogItems(opts(dir, { repo: 'AshlrAI/Phantom' }))).toHaveLength(1);
  });

  it('emits nothing for a missing or unreadable ledger', async () => {
    const empty = await runsDir('runs-empty');
    expect(await routerWeightBacklogItems(opts(empty))).toEqual([]);
    expect(await routerWeightBacklogItems(opts(join(home, 'no-such')))).toEqual([]);
    // A directory where the ledger should be is 'not-file', never 'read'.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'jobs.jsonl'), { recursive: true });
    expect(await routerWeightBacklogItems(opts(notFile))).toEqual([]);
  });

  it('honours the materiality bar, item limit and stable ids', async () => {
    const dir = await runsDir('runs-many', [
      ...mergedRows(20, 'codex', 'judgment'),
      ...closedRows(20, 'claude', 'bulk'),
      ...closedRows(20, 'devin', 'standard'),
    ]);
    const o = opts(dir);
    const first = await routerWeightBacklogItems(o);
    const second = await routerWeightBacklogItems(o);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first.length).toBeGreaterThan(1);
    const limited = await routerWeightBacklogItems(opts(dir, { limit: 1 }));
    expect(limited).toHaveLength(1);
    // A raised materiality bar above the capped 0.1 shift emits nothing.
    expect(await routerWeightBacklogItems(opts(dir, { minShift: 0.2 }))).toEqual([]);
    expect(ROUTER_WEIGHTS_MIN_SHIFT).toBeGreaterThan(0);
    expect(ROUTER_WEIGHTS_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('appends router-weight items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      ...mergedRows(20, 'codex', 'judgment'),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const weightItems = first.items.filter((i) => i.id.startsWith('fleet-router-weights-'));
    expect(weightItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(weightItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-router-weights-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-router-weights-'))).toHaveLength(1);
  });
});
