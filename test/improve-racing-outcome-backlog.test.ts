import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RACING_OUTCOME_MIN_RACES,
  racingOutcomeBacklogItems,
} from '../src/core/improve/racing-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-racing-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const racingDir = (): string => join(home, '.ashlr', 'racing');
const configPath = (): string => join(home, '.ashlr', 'config.json');

/** Enable foundry.modelRacing the way an operator would in ~/.ashlr/config.json. */
const enableRacing = async (): Promise<void> => {
  await mkdir(join(home, '.ashlr'), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify({ foundry: { modelRacing: { enabled: true } } })}\n`);
};

interface RaceOpts {
  winner?: 'local' | 'frontier' | 'tie';
  localScore?: number;
  frontierScore?: number;
  ts?: string;
  taskId?: string;
  taskTitle?: string;
  extra?: Record<string, unknown>;
}

let raceSeq = 0;
const raceLine = (opts: RaceOpts = {}): string => JSON.stringify({
  taskId: opts.taskId ?? `task-${(raceSeq++).toString(36)}`,
  taskTitle: opts.taskTitle ?? `Race task ${(raceSeq).toString(36)}`,
  localDiff: 'diff --git a/x b/x\n-local',
  frontierDiff: 'diff --git a/x b/x\n+frontier',
  localScore: opts.localScore ?? 0,
  frontierScore: opts.frontierScore ?? 0,
  winner: opts.winner ?? 'tie',
  ts: opts.ts ?? new Date(NOW_MS - HOUR_MS).toISOString(),
  ...opts.extra,
});

/** Write `count` race records into one daily journal file under the temp HOME. */
const writeRaces = async (records: readonly string[], date = '2026-11-30'): Promise<void> => {
  await mkdir(racingDir(), { recursive: true });
  await writeFile(join(racingDir(), `${date}.jsonl`), `${records.join('\n')}\n`);
};

const frontierDominant = (count: number, ts?: string): string[] =>
  Array.from({ length: count }, (_, i) => raceLine({
    winner: 'frontier', localScore: 1, frontierScore: 3 + i,
    ts, taskTitle: `frontier task ${i}`,
  }));

const localDominant = (count: number, ts?: string): string[] =>
  Array.from({ length: count }, (_, i) => raceLine({
    winner: 'local', localScore: 4, frontierScore: 1,
    ts, taskTitle: `local task ${i}`,
  }));

const allTies = (count: number, ts?: string): string[] =>
  Array.from({ length: count }, (_, i) => raceLine({
    winner: 'tie', localScore: 0, frontierScore: 0,
    ts, taskTitle: `tie task ${i}`,
  }));

describe('racingOutcomeBacklogItems', () => {
  it('emits enabled-empty only when the flag is on and a complete read finds zero records', async () => {
    // Flag off (no config): empty journal is the correct state, no item.
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);

    // Flag on, missing journal dir entirely: persistRace never ran.
    await enableRacing();
    const items = await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('racing-enabled-empty');
    expect(items[0]!.priority).toBe(3);
    expect(items[0]!.area).toBe('model-racing');
    expect(items[0]!.repo).toBe('ashlrai/phantom');
    expect(validBacklogItem(items[0]!)).not.toBeNull();
    expect(items[0]!.title).toContain('never accumulates');
    expect(items[0]!.prompt).toContain('foundry.modelRacing.enabled');
    expect(items[0]!.prompt).toContain('~/.ashlr/racing/');
    expect(items[0]!.prompt).toContain('raceTask');
    expect(items[0]!.prompt).toContain('no-change');

    // Flag on, journal dir present but only malformed lines: still zero parseable records.
    await mkdir(racingDir(), { recursive: true });
    await writeFile(join(racingDir(), '2026-11-30.jsonl'), '{not json\n\n   \n');
    const malformed = await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(malformed.map((i) => i.id)).toEqual(['racing-enabled-empty']);
  });

  it('stays quiet on enabled-empty when the read cannot prove the dataset is empty', async () => {
    await enableRacing();
    // More daily files than the read cap: the fold is incomplete, so 'never
    // accumulated' must not be claimed even though every file is empty.
    await mkdir(racingDir(), { recursive: true });
    for (let i = 0; i < 63; i++) {
      const day = String(i + 1).padStart(2, '0');
      await writeFile(join(racingDir(), `2026-01-${day}.jsonl`), '');
    }
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
  });

  it('folds an all-tie in-window dataset into the degenerate signal', async () => {
    await writeRaces(allTies(RACING_OUTCOME_MIN_RACES));
    const items = await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('racing-degenerate');
    expect(items[0]!.prompt).toContain(`${RACING_OUTCOME_MIN_RACES} race(s)`);
    expect(items[0]!.prompt).toContain("'tie'");
    expect(items[0]!.prompt).toContain('tie task');
    expect(items[0]!.prompt).toContain('no-change');
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('folds frontier- and local-dominant in-window datasets into their signals', async () => {
    await writeRaces(frontierDominant(RACING_OUTCOME_MIN_RACES));
    const frontier = await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(frontier.map((i) => i.id)).toEqual(['racing-frontier-dominant']);
    expect(frontier[0]!.prompt).toContain('frontier');
    expect(frontier[0]!.prompt).toContain('frontier task');

    await rm(racingDir(), { recursive: true, force: true });
    await writeRaces(localDominant(RACING_OUTCOME_MIN_RACES));
    const local = await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(local.map((i) => i.id)).toEqual(['racing-local-dominant']);
    expect(local[0]!.prompt).toContain('local engine won');
    expect(local[0]!.prompt).toContain('local task');
  });

  it('needs the minimum race count before a win rate means anything', async () => {
    await writeRaces(frontierDominant(RACING_OUTCOME_MIN_RACES - 1));
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
  });

  it('ignores records outside the window and future-dated records past the skew', async () => {
    const old = new Date(NOW_MS - 30 * DAY_MS).toISOString();
    const future = new Date(NOW_MS + 2 * HOUR_MS).toISOString(); // past the 1-minute skew
    await writeRaces([...frontierDominant(3, old), ...frontierDominant(3, future)]);
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    await enableRacing();
    await writeRaces(frontierDominant(RACING_OUTCOME_MIN_RACES));
    const opts = { now: new Date(NOW_MS) };
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/other', ...opts })).toEqual([]);
    expect(await racingOutcomeBacklogItems({ repo: 'ashlrai/phantom-extra', ...opts })).toEqual([]);
    expect(await racingOutcomeBacklogItems({ repo: 'phantom', ...opts })).toHaveLength(1);
    expect(await racingOutcomeBacklogItems({ repo: 'AshlrAI/Phantom', ...opts })).toHaveLength(1);
  });

  it('skips malformed lines, derives stable ids and scrubs quoted task titles', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    await mkdir(racingDir(), { recursive: true });
    const lines = [
      '{not json',
      JSON.stringify({ winner: 'frontier' }), // missing scores/ts
      ...frontierDominant(RACING_OUTCOME_MIN_RACES, undefined).map((l) => l.replace('frontier task', `task with ${token}`)),
      '',
    ];
    await writeFile(join(racingDir(), '2026-11-30.jsonl'), `${lines.join('\n')}\n`);
    const opts = { repo: 'ashlrai/phantom', now: new Date(NOW_MS) };
    const first = await racingOutcomeBacklogItems(opts);
    const second = await racingOutcomeBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe('racing-frontier-dominant');
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first[0]!.prompt).not.toContain(token);
    expect(first[0]!.prompt).toContain('[REDACTED]');
  });

  it('appends racing items through discovery and dedupes on refresh', async () => {
    await enableRacing();
    // discoverBacklog reads the journal with the real clock, so stamp the
    // records at real now — the fictional NOW_MS fixtures are for the
    // injected-clock unit tests only.
    const live = new Date().toISOString();
    await writeRaces(frontierDominant(RACING_OUTCOME_MIN_RACES, live));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const racingItems = first.items.filter((i) => i.id.startsWith('racing-'));
    expect(racingItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(racingItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('racing-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('racing-'))).toHaveLength(1);
  });
});
