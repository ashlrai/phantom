import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldJobReissueCells,
  JOB_REISSUE_MAX_ITEMS,
  JOB_REISSUE_MIN_FAMILIES,
  JOB_REISSUE_MIN_ROWS,
  jobReissueBacklogItems,
  parseJobReissueRow,
  type JobReissueRow,
} from '../src/core/improve/job-reissue-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const row = (from: string, to: string | null, lane = 'devin', tier = 'work', at = '2026-11-24T10:00:00.000Z'): JobReissueRow => ({
  atMs: Date.parse(at), atIso: at, from, to, lane, tier, file: to === null ? null : `RQ-PHX-${to}.md`,
});

describe('parseJobReissueRow', () => {
  it('accepts a writer-shaped row and normalizes ids', () => {
    const parsed = parseJobReissueRow({
      at: '2026-11-24T10:00:00.000Z', from: 'RQ-PHX-EXAMPLE31', to: 'EXAMPLE31R1',
      lane: 'codex-personal', tier: 'mid', file: '/runs/leader/drop/claude/RQ-PHX-EXAMPLE31R1.md',
    });
    expect(parsed).toEqual({
      atMs: Date.parse('2026-11-24T10:00:00.000Z'), atIso: '2026-11-24T10:00:00.000Z',
      from: 'EXAMPLE31', to: 'EXAMPLE31R1', lane: 'codex-personal', tier: 'mid', file: 'RQ-PHX-EXAMPLE31R1.md',
    });
  });

  it('rejects rows without a parseable at or a valid RQ-PHX source id', () => {
    expect(parseJobReissueRow({ at: 'not a date', from: 'RQ-PHX-EXAMPLE31' })).toBeNull();
    expect(parseJobReissueRow({ at: '2026-11-24T10:00:00.000Z', from: 'EXAMPLE31' })).toBeNull();
    expect(parseJobReissueRow({ at: '2026-11-24T10:00:00.000Z', from: 'RQ-PHX-bad!' })).toBeNull();
    expect(parseJobReissueRow('nope')).toBeNull();
    expect(parseJobReissueRow(null)).toBeNull();
  });

  it('degrades optional fields to null rather than disqualifying the row', () => {
    const parsed = parseJobReissueRow({ at: '2026-11-24T10:00:00.000Z', from: 'RQ-PHX-EXAMPLE31' });
    expect(parsed).toMatchObject({ from: 'EXAMPLE31', to: null, lane: null, tier: null, file: null });
    const odd = parseJobReissueRow({
      at: '2026-11-24T10:00:00.000Z', from: 'RQ-PHX-EXAMPLE31', to: 'bad id!',
      lane: '  ', tier: 42, file: '/etc/passwd',
    });
    expect(odd).toMatchObject({ to: null, lane: null, tier: null, file: null });
  });
});

describe('foldJobReissueCells', () => {
  it('unions from→to edges into one family across reissue-of-reissue rows', () => {
    const cells = foldJobReissueCells([
      row('EXAMPLE31', 'EXAMPLE31R1', 'devin', 'work', '2026-11-24T08:00:00.000Z'),
      row('EXAMPLE31R1', 'EXAMPLE31R2', 'devin', 'work', '2026-11-24T09:00:00.000Z'),
      row('EXAMPLE31', 'EXAMPLE31R3', 'claude', 'mid', '2026-11-24T10:00:00.000Z'),
      row('OTHER9', 'OTHER9R1', 'devin', 'work', '2026-11-24T10:30:00.000Z'),
    ]);
    expect(cells.chains).toHaveLength(2);
    const family = cells.chains.find((c) => c.label === 'EXAMPLE31')!;
    expect(family.members).toEqual(['EXAMPLE31', 'EXAMPLE31R1', 'EXAMPLE31R2', 'EXAMPLE31R3']);
    expect(family.rows).toBe(3);
    expect(family.fromCount).toBe(2);
    expect(family.toCount).toBe(3);
    expect(family.lanes).toEqual([{ text: 'devin', count: 2 }, { text: 'claude', count: 1 }]);
    expect(family.tiers).toEqual([{ text: 'work', count: 2 }, { text: 'mid', count: 1 }]);
    expect(family.firstSeen).toBe('2026-11-24T08:00:00.000Z');
    expect(family.lastSeen).toBe('2026-11-24T10:00:00.000Z');
    // OTHER9 is its own family — a look-alike suffix never merges families.
    expect(cells.chains.find((c) => c.label === 'OTHER9')!.rows).toBe(1);
  });

  it('counts rows whose to is unusable under their from family', () => {
    const cells = foldJobReissueCells([
      row('EXAMPLE31', null, 'devin', 'work'),
      row('EXAMPLE31', null, 'devin', 'work'),
      row('EXAMPLE31', 'EXAMPLE31R1', 'devin', 'work'),
    ]);
    expect(cells.chains).toHaveLength(1);
    expect(cells.chains[0]).toMatchObject({ rows: 3, fromCount: 1, toCount: 1 });
  });

  it('lane cells count distinct families, not rows', () => {
    const cells = foldJobReissueCells([
      // One family reissued three times on devin — a chain, not a lane pattern.
      row('FAMILYA', 'FAMILYA1', 'devin'), row('FAMILYA', 'FAMILYA2', 'devin'), row('FAMILYA', 'FAMILYA3', 'devin'),
      // Three distinct families once each on claude — the lane pattern.
      row('FAMILYB', 'FAMILYB1', 'claude'), row('FAMILYC', 'FAMILYC1', 'claude'), row('FAMILYD', 'FAMILYD1', 'claude'),
    ]);
    const claude = cells.lanes.find((l) => l.lane === 'claude')!;
    expect(claude.families).toBe(3);
    expect(claude.rows).toBe(3);
    const devin = cells.lanes.find((l) => l.lane === 'devin')!;
    expect(devin.families).toBe(1);
    expect(devin.rows).toBe(3);
  });

  it('marks unrecorded lanes unknown and flattens recorded text', () => {
    const cells = foldJobReissueCells([
      { ...row('AAA111', 'AAA111R1'), lane: null },
      { ...row('BBB222', 'BBB222R1'), lane: 'claude\n' + 'l'.repeat(100) },
      { ...row('CCC333', 'CCC333R1'), lane: null },
    ]);
    const unknown = cells.lanes.find((l) => l.lane === 'unknown')!;
    expect(unknown.families).toBe(2);
    const weird = cells.lanes.find((l) => l.lane !== 'unknown')!;
    expect(weird.lane.length).toBeLessThanOrEqual(60);
    expect(weird.lane).not.toContain('\n');
  });
});

describe('jobReissueBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-reissue-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDirWithAudit(name: string, lines: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'job-reissues.jsonl'), lines.join('\n') + '\n');
    return dir;
  }
  const audit = (from: string, to: string | null, lane = 'devin', tier = 'work', hoursAgo = 1): string =>
    J({ at: ago(hoursAgo), from: `RQ-PHX-${from}`, to, lane, tier, file: to === null ? null : `/runs/leader/drop/claude/RQ-PHX-${to}.md` });

  it('emits a chain item for a family reissued at the recurring bar', async () => {
    const dir = await runsDirWithAudit('runs-chain', [
      audit('EXAMPLE31', 'EXAMPLE31R1', 'devin', 'work', 30),
      audit('EXAMPLE31R1', 'EXAMPLE31R2', 'devin', 'work', 20),
      audit('EXAMPLE31', 'EXAMPLE31R3', 'claude', 'mid', 5),
    ]);
    const items = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-reissues' });
    expect(item!.id).toMatch(/^job-reissue-chain-[0-9a-f]{16}$/);
    expect(item!.title).toContain('EXAMPLE31');
    expect(item!.title).toContain('3');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('EXAMPLE31R2');
    expect(item!.prompt).toContain('job-reissues.jsonl');
    expect(item!.prompt).toContain('fleet-reissue');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('/runs/leader');
    expect(JOB_REISSUE_MIN_ROWS).toBe(3);
  });

  it('emits a lane item for three distinct families on one lane', async () => {
    const dir = await runsDirWithAudit('runs-lane', [
      audit('FAMILYA', 'FAMILYA1', 'claude', 'frontier', 40),
      audit('FAMILYB', 'FAMILYB1', 'claude', 'work', 30),
      audit('FAMILYC', 'FAMILYC1', 'claude', 'mid', 20),
      audit('FAMILYD', 'FAMILYD1', 'devin', 'work', 10),
    ]);
    const items = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^job-reissue-lane-[0-9a-f]{16}$/);
    expect(items[0]!.title).toContain('claude');
    expect(items[0]!.prompt).toContain('3 distinct job families');
    expect(validBacklogItem(items[0]!)).not.toBeNull();
    expect(JOB_REISSUE_MIN_FAMILIES).toBe(3);
  });

  it('emits both kinds when a chain and a lane pattern coexist', async () => {
    const dir = await runsDirWithAudit('runs-both', [
      // Chain: one family, four reissues on devin.
      audit('CHAINME', 'CHAINME1', 'devin', 'work', 50),
      audit('CHAINME', 'CHAINME2', 'devin', 'work', 40),
      audit('CHAINME1', 'CHAINME3', 'devin', 'work', 30),
      audit('CHAINME', 'CHAINME4', 'devin', 'work', 20),
      // Lane: three other families once each on claude.
      audit('LANE1A', 'LANE1A1', 'claude', 'mid', 15),
      audit('LANE2B', 'LANE2B1', 'claude', 'mid', 10),
      audit('LANE3C', 'LANE3C1', 'claude', 'mid', 5),
    ]);
    const items = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id.startsWith('job-reissue-chain-'))).toEqual([true, false]);
    expect(items[1]!.id).toMatch(/^job-reissue-lane-/);
  });

  it('emits nothing below the recurring bars or outside the window', async () => {
    const quiet = await runsDirWithAudit('runs-quiet', [
      audit('ONE1', 'ONE1R1', 'devin', 'work', 5),
      audit('TWO2', 'TWO2R1', 'devin', 'work', 6),
    ]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    // Three rows but all older than the window.
    const stale = await runsDirWithAudit('runs-stale', [
      audit('OLD1', 'OLD1R1', 'devin', 'work', 24 * 200),
      audit('OLD1', 'OLD1R2', 'devin', 'work', 24 * 199),
      audit('OLD1', 'OLD1R3', 'devin', 'work', 24 * 198),
    ]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: stale, now: new Date(NOW) })).toEqual([]);
    // A wider explicit window picks them up.
    const wide = await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: stale, now: new Date(NOW), sinceHours: 24 * 365 });
    expect(wide).toHaveLength(1);
  });

  it('emits nothing for a missing journal, malformed lines, or another repository', async () => {
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDirWithAudit('runs-mixed', [
      'not json at all',
      J({ hello: 'world' }),
      audit('MIX1', 'MIX1R1', 'devin', 'work', 3),
      audit('MIX1', 'MIX1R2', 'devin', 'work', 2),
      audit('MIX1', 'MIX1R3', 'devin', 'work', 1),
    ]);
    expect(await jobReissueBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await jobReissueBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDirWithAudit('runs-stable', [
      audit('STABLE1', 'STABLE1R1', 'devin', 'work', 9),
      audit('STABLE1', 'STABLE1R2', 'devin', 'work', 8),
      audit('STABLE1', 'STABLE1R3', 'devin', 'work', 7),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await jobReissueBacklogItems(opts);
    const second = await jobReissueBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(JOB_REISSUE_MAX_ITEMS);
    expect(await jobReissueBacklogItems({ ...opts, limit: 0 })).toHaveLength(1);
  });

  it('appends job-reissue items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, 'queue', 'job-reissues.jsonl'), [
      audit('DISC1', 'DISC1R1', 'devin', 'work', 3),
      audit('DISC1', 'DISC1R2', 'devin', 'work', 2),
      audit('DISC1', 'DISC1R3', 'devin', 'work', 1),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('job-reissue-'));
    expect(items).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('job-reissue-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('job-reissue-'))).toHaveLength(1);
  });
});
