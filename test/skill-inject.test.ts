/**
 * skill-inject.test.ts — active verified-skill prompt injection.
 *
 * The injection path consumes exactly what selectVerifiedSkills returns. The
 * retrieval gate is deliberately fail-closed today (no card can prove
 * post-merge credit release), so end-to-end tests assert the honest dormant
 * state — byte-identical prompts, zero events — while unit tests pin the
 * renderer, the event builder and the ledger write for when eligibility opens.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCard } from '../src/core/types.js';
import { skillCardContentHash } from '../src/core/fleet/skill-attestation.js';
import { signSkillCardAttestation } from '../src/core/foundry/provenance.js';
import {
  prepareSkillGuidance,
  recordSkillInjections,
  renderSkillGuidanceBlock,
  SKILL_GUIDANCE_CAP_BYTES,
  withVerifiedSkillGuidance,
} from '../src/core/fleet/skill-inject.js';
import { buildSkillUseEvent } from '../src/core/fleet/skill-use-identity.js';
import { readSkillUseEvents } from '../src/core/fleet/skill-records.js';
import type { ShadowSkillSummary } from '../src/core/fleet/skill-retrieval.js';

const selectedAt = '2026-07-10T12:00:00.000Z';
const identity = { trajectoryId: 'attempt:inject-1', runId: 'run-inject-1' };

let previousHome: string | undefined;
let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-07-10T12:01:00.000Z');
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-skill-inject-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function summary(overrides: Partial<ShadowSkillSummary> = {}): ShadowSkillSummary {
  return {
    skillId: 'skill.proposal.prop-1',
    revision: 1,
    contentHash: 'a'.repeat(64),
    rank: 1,
    score: 0.9,
    name: 'Verify TypeScript changes',
    summary: 'Run focused typecheck and test commands.',
    matchedFields: new Set(['taskKinds']),
    status: 'verified',
    source: 'verified-proposal',
    labelBasis: 'post-merge-credit-release-v1',
    creditReleased: true,
    ...overrides,
  } as ShadowSkillSummary;
}

/** A fully-formed verified card — still ineligible: credit release is unproven. */
function verifiedCard(): SkillCard {
  const unsigned = {
    schemaVersion: 1,
    skillId: 'skill.proposal.prop-1',
    revision: 1,
    ts: selectedAt,
    name: 'Verify TypeScript changes',
    summary: 'Run focused typecheck and test commands.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['credit:released-v1', 'typescript'],
    taskKinds: ['typescript-change'],
    commandKinds: ['typecheck'],
    verification: {
      passed: true,
      commandKinds: ['typecheck'],
      diffHash: 'a'.repeat(64),
      evidenceCount: 2,
    },
    proposalId: 'proposal-inject-1',
    labelBasis: 'post-merge-credit-release-v1',
  } as const;
  const contentHash = skillCardContentHash(unsigned as unknown as SkillCard);
  const attestation = signSkillCardAttestation({
    contentHash,
    skillId: unsigned.skillId,
    revision: unsigned.revision,
    proposalId: unsigned.proposalId,
    diffHash: unsigned.verification.diffHash,
  });
  if (!attestation) throw new Error('failed to sign fixture card');
  return { ...(unsigned as unknown as SkillCard), contentHash, attestation };
}

describe('renderSkillGuidanceBlock', () => {
  it('renders nothing for an empty or missing selection', () => {
    expect(renderSkillGuidanceBlock([])).toBe('');
    expect(renderSkillGuidanceBlock(undefined)).toBe('');
    expect(renderSkillGuidanceBlock(null)).toBe('');
  });

  it('renders ranked skills as a bounded markdown block', () => {
    const block = renderSkillGuidanceBlock([
      summary(),
      summary({ skillId: 'skill.proposal.prop-2', rank: 2, name: 'Second skill', summary: 'Backup guidance.' }),
    ]);
    expect(block).toContain('## Verified learned skills for this task');
    expect(block).toContain('- Verify TypeScript changes: Run focused typecheck and test commands.');
    expect(block).toContain('- Second skill: Backup guidance.');
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(SKILL_GUIDANCE_CAP_BYTES);
  });

  it('drops skills that do not fit whole under the cap', () => {
    const huge = summary({ summary: 'x'.repeat(400) });
    const block = renderSkillGuidanceBlock([huge, summary({ skillId: 'skill.proposal.prop-2', rank: 2 })], 300);
    // The oversized first skill ends the list; the smaller second is never reached.
    expect(block).toBe('');
    const partial = renderSkillGuidanceBlock([summary(), huge], 300);
    expect(partial).toContain('Verify TypeScript changes');
    expect(partial).not.toContain('xxxx');
  });
});

describe('recordSkillInjections', () => {
  it('appends active/injected events bound to the dispatch identity', () => {
    recordSkillInjections([summary()], identity, selectedAt, { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' });
    const events = readSkillUseEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trajectoryId: 'attempt:inject-1',
      runId: 'run-inject-1',
      skillId: 'skill.proposal.prop-1',
      mode: 'active',
      stage: 'injected',
      outcome: 'unknown',
      selectedAt,
      routeSnapshot: { skillMode: 'active' },
    });
  });

  it('is replay-stable and records nothing for an empty selection', () => {
    recordSkillInjections([], identity, selectedAt);
    recordSkillInjections(undefined, identity, selectedAt);
    expect(readSkillUseEvents()).toEqual([]);
  });
});

describe('buildSkillUseEvent', () => {
  it('distinguishes active/injected events from shadow/selected', () => {
    const base = {
      identity,
      selectedAt,
      skill: { skillId: 'skill.proposal.prop-1', revision: 1, contentHash: 'a'.repeat(64), rank: 1, score: 0.9 },
      route: { backend: 'codex', tier: 'frontier', model: 'gpt-5.5' },
    } as const;
    const injected = buildSkillUseEvent({ ...base, mode: 'active', stage: 'injected' });
    const selected = buildSkillUseEvent({ ...base, mode: 'shadow', stage: 'selected' });
    expect(injected?.mode).toBe('active');
    expect(injected?.stage).toBe('injected');
    expect(injected?.eventId).not.toBe(selected?.eventId);
    expect(injected?.routeSnapshot?.skillMode).toBe('active');
  });
});

describe('withVerifiedSkillGuidance', () => {
  const item = { title: 'Verify TypeScript changes', detail: 'Run the typecheck.', source: 'test', tags: ['typescript'] };
  const prompt = 'Implement the bounded change.';

  it('fails closed: an unattested-release verified card leaves the prompt byte-identical', () => {
    const cards = [verifiedCard()];
    const prepared = prepareSkillGuidance(cards, { title: item.title, tags: item.tags });
    expect(prepared.block).toBe('');
    const out = withVerifiedSkillGuidance(prompt, item, cards, 'run-inject-1', { selectedAt });
    expect(out).toBe(prompt);
    expect(readSkillUseEvents()).toEqual([]);
  });

  it('fails closed on malformed card input without throwing', () => {
    const out = withVerifiedSkillGuidance(prompt, item, [null, 42, 'garbage'], 'run-inject-1');
    expect(out).toBe(prompt);
    expect(readSkillUseEvents()).toEqual([]);
  });
});
