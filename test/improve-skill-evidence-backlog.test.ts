import { describe, expect, it, vi } from 'vitest';
import type { SkillCard, SkillUseEvent } from '../src/core/types.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import type { SkillCardCorpusReadResult, SkillUseEventReadResult } from '../src/core/fleet/skill-records.js';
import {
  SKILL_EVIDENCE_WINDOW_HOURS,
  skillEvidenceBacklogItems,
} from '../src/core/improve/skill-evidence-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';

vi.mock('../src/core/improve/skill-evidence-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/skill-evidence-backlog.js')>();
  return { ...actual, skillEvidenceBacklogItems: vi.fn(actual.skillEvidenceBacklogItems) };
});

const feedMock = vi.mocked(skillEvidenceBacklogItems);

const REPO = 'ashlrai/phantom';

function card(overrides: Partial<SkillCard> = {}): SkillCard {
  const unsigned: SkillCard = {
    schemaVersion: 1,
    skillId: 'skill.verify-typescript',
    revision: 1,
    ts: '2026-07-10T12:00:00.000Z',
    name: 'Verify TypeScript changes',
    summary: 'Run focused typecheck and tests before broader verification.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['typescript', 'verification'],
    taskKinds: ['typescript-change'],
    commandKinds: ['typecheck', 'test'],
    verification: {
      passed: true,
      commandKinds: ['typecheck', 'test'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 3,
    },
    proposalId: 'proposal-fixture',
    labelBasis: 'post-merge-credit-release-v1',
    ...overrides,
  };
  const signed = attestSkillCard(unsigned);
  return signed ?? unsigned;
}

function corpus(overrides: Partial<SkillCardCorpusReadResult> = {}): SkillCardCorpusReadResult {
  return {
    cards: [],
    sourceState: 'healthy',
    sourcePresent: true,
    filesScanned: 3,
    unreadableFiles: 0,
    invalidRows: 0,
    bytesScanned: 4096,
    limitExceeded: false,
    ...overrides,
  };
}

function useEvents(overrides: Partial<SkillUseEventReadResult> = {}): SkillUseEventReadResult {
  return {
    events: [],
    sourceState: 'healthy',
    sourcePresent: true,
    eventState: 'none',
    ...overrides,
  };
}

const degradedUses = (): SkillUseEventReadResult => useEvents({
  eventState: 'degraded',
  sourceState: 'degraded',
  events: [{ eventId: 'e1' } as SkillUseEvent],
});

const conflictedCorpus = (): SkillCardCorpusReadResult => corpus({
  cards: [
    card({ skillId: 'skill.conflict', revision: 2, name: 'First current value' }),
    card({ skillId: 'skill.conflict', revision: 2, name: 'Second current value' }),
  ],
});

describe('skillEvidenceBacklogItems', () => {
  it('emits the cards cell on a degraded corpus read with the recorded counters', async () => {
    const items = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({
        sourceState: 'degraded',
        cards: [],
        filesScanned: 7,
        unreadableFiles: 2,
        invalidRows: 5,
        limitExceeded: true,
      }),
      useEvents: useEvents(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^skill-evidence-[0-9a-f]{16}$/);
    expect(items[0]!.title).toContain('degraded');
    expect(items[0]!.title).toContain('2 unreadable');
    expect(items[0]!.title).toContain('5 invalid');
    expect(items[0]!.area).toBe('skill-evidence');
    expect(items[0]!.priority).toBe(3);
    expect(items[0]!.repo).toBe(REPO);
    expect(items[0]!.prompt).toContain('readSkillCardCorpus');
    expect(items[0]!.prompt).toContain('blocked-corpus-degraded');
    expect(items[0]!.prompt).toContain('owner-only');
  });

  it('stays quiet on a missing or healthy quiet corpus and clean use read', async () => {
    expect(await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({ sourceState: 'missing', sourcePresent: false, filesScanned: 0 }),
      useEvents: useEvents({ sourceState: 'missing', sourcePresent: false }),
    })).toEqual([]);
    expect(await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({ cards: [card()] }),
      useEvents: useEvents({ eventState: 'present' }),
    })).toEqual([]);
  });

  it('emits the cards-conflict cell when a healthy corpus hides conflicting revisions', async () => {
    const items = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({
        cards: [
          card({ skillId: 'skill.conflict', revision: 1 }),
          card({ skillId: 'skill.conflict', revision: 2, name: 'First current value' }),
          card({ skillId: 'skill.conflict', revision: 2, name: 'Second current value' }),
          card({ skillId: 'skill.quiet', revision: 1 }),
        ],
      }),
      useEvents: useEvents(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('conflicting');
    expect(items[0]!.prompt).toContain('quarantines');
    expect(items[0]!.prompt).toContain('inspectCurrentCards');
  });

  it('does not emit a conflict cell on a degraded corpus read', async () => {
    const items = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({
        sourceState: 'degraded',
        // Even if a caller hands back cards with a degraded read, the
        // cards cell owns the verdict and conflicts stay uninspected.
        cards: [
          card({ skillId: 'skill.conflict', revision: 2, name: 'First current value' }),
          card({ skillId: 'skill.conflict', revision: 2, name: 'Second current value' }),
        ],
        unreadableFiles: 1,
      }),
      useEvents: useEvents(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('corpus read degraded');
  });

  it('emits the uses cell on a degraded use-event read', async () => {
    const items = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus(),
      useEvents: degradedUses(),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^skill-evidence-[0-9a-f]{16}$/);
    expect(items[0]!.title).toContain('Skill-use ledger');
    expect(items[0]!.prompt).toContain('readSkillUseEventsWithDiagnostics');
    expect(items[0]!.prompt).toContain('readSkillTrajectoryOutcomes');
    expect(items[0]!.prompt).toContain(String(SKILL_EVIDENCE_WINDOW_HOURS));
    expect(items[0]!.prompt).toContain('eventId');
  });

  it('emits the corpus and uses cells together with distinct ids and honors the cap', async () => {
    const degraded = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({ sourceState: 'degraded', unreadableFiles: 3, invalidRows: 1 }),
      useEvents: degradedUses(),
    });
    expect(degraded).toHaveLength(2);
    expect(new Set(degraded.map((i) => i.id)).size).toBe(2);

    const conflicted = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: conflictedCorpus(),
      useEvents: degradedUses(),
    });
    expect(conflicted).toHaveLength(2);
    expect(new Set(conflicted.map((i) => i.id)).size).toBe(2);

    const capped = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: conflictedCorpus(),
      useEvents: degradedUses(),
      limit: 1,
    });
    expect(capped).toHaveLength(1);
    expect(capped[0]!.title).toContain('conflicting');
  });

  it('keeps ids stable across refreshes with shifted counts', async () => {
    const first = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({ sourceState: 'degraded', unreadableFiles: 2, invalidRows: 5 }),
      useEvents: useEvents(),
    });
    const shifted = await skillEvidenceBacklogItems({
      repo: REPO,
      corpus: corpus({ sourceState: 'degraded', unreadableFiles: 9, invalidRows: 4, filesScanned: 11 }),
      useEvents: useEvents(),
    });
    expect(first[0]!.id).toBe(shifted[0]!.id);
    expect(first[0]!.title).not.toBe(shifted[0]!.title);
  });

  it('emits only for the fleet repository', async () => {
    const degraded = corpus({ sourceState: 'degraded', unreadableFiles: 1 });
    expect(await skillEvidenceBacklogItems({ repo: 'someone/else', corpus: degraded, useEvents: useEvents() })).toEqual([]);
    expect(await skillEvidenceBacklogItems({ repo: '', corpus: degraded, useEvents: useEvents() })).toEqual([]);
    expect(await skillEvidenceBacklogItems({ repo: 'ashlrai/phantom-fork', corpus: degraded, useEvents: useEvents() })).toEqual([]);
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

  it('runs the feed during discovery with the fleet repo', async () => {
    feedMock.mockClear();
    await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
  });
});
