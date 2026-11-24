import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SKILL_OUTCOME_ADVERSE_RECURRING,
  SKILL_OUTCOME_MAX_ITEMS,
  SKILL_OUTCOME_RECORD_LIMIT,
  SKILL_OUTCOME_WINDOW_HOURS,
  skillOutcomeBacklogItems,
} from '../src/core/improve/skill-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';
import { recordSkillCard, type SkillCardCorpusReadResult } from '../src/core/fleet/skill-records.js';
import type { SkillCard } from '../src/core/types.js';
import type {
  TrajectorySkillOutcomeRow,
  TrajectorySkillOutcomeSummary,
} from '../src/core/autonomy/trajectory-records.js';

vi.mock('../src/core/improve/skill-outcome-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/skill-outcome-backlog.js')>();
  return { ...actual, skillOutcomeBacklogItems: vi.fn(actual.skillOutcomeBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/skill-outcome-backlog.js')>(
  '../src/core/improve/skill-outcome-backlog.js',
)).skillOutcomeBacklogItems;
const feedMock = vi.mocked(skillOutcomeBacklogItems);

const REPO = 'ashlrai/phantom';

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  return {
    schemaVersion: 1,
    skillId: 'skill.focused-verify',
    revision: 1,
    ts: '2026-07-10T12:00:00.000Z',
    name: 'Verify focused tests',
    summary: 'Run the focused contract before broader verification.',
    status: 'verified',
    source: 'verified-proposal',
    ...overrides,
  };
}

function corpus(
  cards: SkillCard[],
  sourceState: SkillCardCorpusReadResult['sourceState'] = 'healthy',
): SkillCardCorpusReadResult {
  return {
    cards,
    sourceState,
    sourcePresent: sourceState !== 'missing',
    filesScanned: cards.length,
    unreadableFiles: 0,
    invalidRows: 0,
    bytesScanned: 0,
    limitExceeded: false,
  };
}

function outcomeRow(
  skillId: string,
  skillRevision: number,
  realized: TrajectorySkillOutcomeRow['realized'],
  selections = 6,
): TrajectorySkillOutcomeRow {
  return {
    skillId,
    skillRevision,
    selections,
    outcomes: { merged: selections },
    realized,
  };
}

function summary(perSkill: TrajectorySkillOutcomeRow[]): TrajectorySkillOutcomeSummary {
  return {
    skills: new Set(perSkill.map((row) => row.skillId)).size,
    selections: perSkill.reduce((total, row) => total + row.selections, 0),
    perSkill,
  };
}

const recurring = { reverted: 2, regressed: 1 };

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-skill-outcome-backlog-'));
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('skillOutcomeBacklogItems', () => {
  it('emits one valid item per live skill revision at the recurring adverse bar', async () => {
    const items = await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes: summary([outcomeRow('skill.focused-verify', 1, recurring)]),
      corpus: corpus([card()]),
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^skill-outcome-[0-9a-f]{16}$/);
    expect(item.title).toContain('Verify focused tests');
    expect(item.title).toContain('rev 1');
    expect(item.area).toBe('skill-outcomes');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('skill.focused-verify');
    expect(item.prompt).toContain('revision 1');
    expect(item.prompt).toContain('reverted 2, regressed 1, followed-up 0');
    expect(item.prompt).toContain('merged 6');
    expect(item.prompt).toContain('association evidence, not proven causation');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('~/.ashlr/skills/cards');
  });

  it('counts followed-up outcomes toward the same adverse bar', async () => {
    const items = await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes: summary([outcomeRow('skill.focused-verify', 1, { 'followed-up': SKILL_OUTCOME_ADVERSE_RECURRING })]),
      corpus: corpus([card()]),
    });
    expect(items).toHaveLength(1);
  });

  it('stays quiet below the recurring bar and on missing realized tallies', async () => {
    for (const realized of [{ reverted: 2 }, { regressed: 1, 'followed-up': 1 }, undefined]) {
      const items = await skillOutcomeBacklogItems({
        repo: REPO,
        outcomes: summary([outcomeRow('skill.focused-verify', 1, realized)]),
        corpus: corpus([card()]),
      });
      expect(items).toEqual([]);
    }
  });

  it('withholds on a null projection and on degraded or missing corpora', async () => {
    const outcomes = summary([outcomeRow('skill.focused-verify', 1, recurring)]);
    expect(await skillOutcomeBacklogItems({ repo: REPO, outcomes: null, corpus: corpus([card()]) })).toEqual([]);
    expect(await skillOutcomeBacklogItems({ repo: REPO, outcomes, corpus: corpus([card()], 'degraded') })).toEqual([]);
    expect(await skillOutcomeBacklogItems({ repo: REPO, outcomes, corpus: corpus([], 'missing') })).toEqual([]);
  });

  it('emits only while the exact observed revision is still the live card', async () => {
    const outcomes = summary([outcomeRow('skill.focused-verify', 1, recurring)]);
    // Superseded: corpus newest revision is 2, so revision 1's adverse history was already replaced.
    expect(await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes,
      corpus: corpus([card({ revision: 2, ts: '2026-07-11T12:00:00.000Z' })]),
    })).toEqual([]);
    // Withdrawn states are already handled; candidate and verified are live.
    for (const status of ['deprecated', 'revoked'] as const) {
      expect(await skillOutcomeBacklogItems({
        repo: REPO,
        outcomes,
        corpus: corpus([card({ status })]),
      })).toEqual([]);
    }
    for (const status of ['candidate', 'verified'] as const) {
      const items = await skillOutcomeBacklogItems({ repo: REPO, outcomes, corpus: corpus([card({ status })]) });
      expect(items).toHaveLength(1);
    }
    // A skill id with no card in a healthy corpus cannot resolve to a live revision.
    expect(await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes: summary([outcomeRow('skill.unknown', 1, recurring)]),
      corpus: corpus([card()]),
    })).toEqual([]);
  });

  it('gates on the fleet repository and orders by recorded adverse evidence', async () => {
    const outcomes = summary([
      outcomeRow('skill.b', 1, { regressed: 3 }, 4),
      outcomeRow('skill.a', 1, recurring, 9),
      outcomeRow('skill.c', 1, { reverted: 5 }, 2),
    ]);
    const cards = [
      card({ skillId: 'skill.a', name: 'Skill A' }),
      card({ skillId: 'skill.b', name: 'Skill B' }),
      card({ skillId: 'skill.c', name: 'Skill C' }),
    ];
    expect(await skillOutcomeBacklogItems({ repo: 'ashlrai/other-repo', outcomes, corpus: corpus(cards) })).toEqual([]);
    const items = await skillOutcomeBacklogItems({ repo: REPO, outcomes, corpus: corpus(cards) });
    // skill.c: 5 adverse, skill.b: 3, skill.a: 3 (tally tie → selections desc: a 9 > b 4).
    expect(items.map((item) => item.title)).toEqual([
      expect.stringContaining('Skill C'),
      expect.stringContaining('Skill A'),
      expect.stringContaining('Skill B'),
    ]);
    const limited = await skillOutcomeBacklogItems({ repo: REPO, outcomes, corpus: corpus(cards), limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((item) => item.id)).toEqual(items.slice(0, 2).map((item) => item.id));
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await skillOutcomeBacklogItems({ repo: 'phantom', outcomes, corpus: corpus(cards) });
    expect(bare).toHaveLength(3);
    expect(bare.every((item) => item.repo === undefined)).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const opts = {
      repo: REPO,
      outcomes: summary([outcomeRow('skill.focused-verify', 1, recurring)]),
      corpus: corpus([card()]),
    };
    const first = await skillOutcomeBacklogItems(opts);
    const second = await skillOutcomeBacklogItems(opts);
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same revision keep the same id — no twin items.
    const shifted = await skillOutcomeBacklogItems({
      ...opts,
      outcomes: summary([outcomeRow('skill.focused-verify', 1, { reverted: 4, regressed: 2 }, 9)]),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('skips malformed rows without throwing', async () => {
    const items = await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes: summary([
        outcomeRow('', 1, recurring),
        outcomeRow('skill.focused-verify', 0, recurring),
        outcomeRow('skill.focused-verify', 1, recurring),
      ]),
      corpus: corpus([card()]),
    });
    expect(items).toHaveLength(1);
  });

  it('scrubs secret-shaped card names out of titles and prompts', async () => {
    const secretName = `Verify ghp_${'a'.repeat(36)} focused`;
    const items = await skillOutcomeBacklogItems({
      repo: REPO,
      outcomes: summary([outcomeRow('skill.focused-verify', 1, recurring)]),
      corpus: corpus([card({ name: secretName })]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).not.toContain('ghp_');
    expect(items[0]!.prompt).not.toContain('ghp_');
    expect(items[0]!.title + items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the real card corpus under ASHLR_HOME', async () => {
    recordSkillCard([
      card({ skillId: 'skill.live', revision: 1, name: 'Live card' }),
      card({ skillId: 'skill.live', revision: 2, ts: '2026-07-12T12:00:00.000Z', name: 'Live card v2' }),
      card({ skillId: 'skill.old', revision: 1, name: 'Old card' }),
    ]);
    const outcomes = summary([
      outcomeRow('skill.live', 1, recurring),   // superseded by revision 2: quiet
      outcomeRow('skill.live', 2, { reverted: 3 }, 8),
      outcomeRow('skill.old', 1, recurring),
    ]);
    const items = await skillOutcomeBacklogItems({ repo: REPO, outcomes });
    // skill.live rev1 skipped (superseded), skill.live rev2 emits, skill.old rev1 emits.
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toContain('Live card v2');
    expect(items[1]!.title).toContain('Old card');
  });
});

describe('skillOutcomeBacklogItems constants', () => {
  it('exposes the documented window, cohort cap and item bounds', () => {
    expect(SKILL_OUTCOME_WINDOW_HOURS).toBe(24 * 7);
    expect(SKILL_OUTCOME_RECORD_LIMIT).toBe(500);
    expect(SKILL_OUTCOME_ADVERSE_RECURRING).toBe(3);
    expect(SKILL_OUTCOME_MAX_ITEMS).toBeGreaterThan(0);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'skill-outcome-deadbeefdeadbeef',
      title: 'Learned skill sentinel keeps landing adverse post-merge outcomes',
      prompt: 'Sentinel prompt naming the trajectory skill-outcomes evidence.',
      area: 'skill-outcomes',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const skillItems = first.items.filter((item) => item.id === sentinel.id);
    expect(skillItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(skillItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
