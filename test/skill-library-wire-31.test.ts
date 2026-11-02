/**
 * test/skill-library-wire-31.test.ts — M243 wire: the automerge pass's
 * realized-merge fanout recovery is the periodic sweep learnFromApplied() was
 * built for (see skill-library.ts: "expected to be called repeatedly (a
 * periodic sweep, not a one-shot at merge time)").
 *
 * This suite exercises the REAL wire end-to-end: runAutoMergePass →
 * learnFromApplied → real sanitizeSkillCard + attestPostMergeCreditSkillCard +
 * recordSkillCard → a structured SkillCard readable from the real
 * skill-records ledger under a temp HOME.
 *
 *  1. An applied proposal with verified, diff-bound evidence replayed by the
 *     pass produces exactly one structured SkillCard in the ledger.
 *  2. A rejected proposal produces none (the applied-status queue gate, not
 *     merely missing evidence).
 *  3. A throwing write-back leaves the apply (pass) result unchanged —
 *     fire-and-forget, identical contract to learnFromRejection.
 *  4. cfg.foundry.skillLibrary === false is a byte-identical no-op.
 *  5. A second pass writes no duplicate (corpus idempotency by proposalId).
 *
 * HERMETICITY (mirrors m48/m243):
 *  - HOME and ASHLR_HOME overridden to a fresh tmp dir per test.
 *  - The M47 merge gate (autoMergeProposal), the inbox store, the evidence-pack
 *    readers, and the post-merge credit release check are MOCKED — no git, no
 *    gh, no network, no LLM. The eligibility mock stands in for the real
 *    release protocol's verdict only; attestation stays real (host-local HMAC
 *    over the card's content hash, key generated under the tmp HOME).
 *  - The SkillCard ledger (skill-records.ts) is REAL: recordSkillCard
 *    delegates to the real append so the ledger assertions are end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal, SkillCard } from '../src/core/types.js';
import type { AutoMergeResult } from '../src/core/inbox/merge.js';
import type {
  AutonomyEvidencePack,
  SignedAutonomyEvidencePackV3,
} from '../src/core/autonomy/evidence-pack.js';
import { hashDiff, signProvenance, signSkillCardAttestation } from '../src/core/foundry/provenance.js';
import { skillCardContentHash } from '../src/core/fleet/skill-attestation.js';
import { POST_MERGE_CREDIT_RELEASE_LABEL } from '../src/core/fleet/post-merge-credit.js';

// ---------------------------------------------------------------------------
// HOME isolation — before any module resolves homedir()/ASHLR_HOME
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports so modules bind to the mocks.
// ---------------------------------------------------------------------------

const mockAutoMergeProposal = vi.fn();
const mockVerifyAndPersistProposal = vi.fn();
const mockEvaluateAutoMergeReadinessPreflight = vi.fn();
const mockHasCurrentVerificationBinding = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  verifyAndPersistProposal: (...args: unknown[]) => mockVerifyAndPersistProposal(...args),
  evaluateAutoMergeReadinessPreflight: (...args: unknown[]) =>
    mockEvaluateAutoMergeReadinessPreflight(...args),
  hasCurrentVerificationBinding: (...args: unknown[]) =>
    mockHasCurrentVerificationBinding(...args),
  isFrontierJudge: (judgeEngine: string | undefined) => {
    const lc = (judgeEngine ?? '').toLowerCase();
    return lc.startsWith('claude') || lc.includes('claude') || lc.startsWith('gpt-5') || lc.startsWith('codex-') || lc === 'codex';
  },
}));

let proposals: Proposal[] = [];
const mockListProposalsDetailed = vi.fn();
const mockReplayRealizedMergeFanout = vi.fn();
const mockSetStatus = vi.fn();
const mockUpdateProposalField = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: (id: string) => proposals.find((p) => p.id === id) ?? null,
  listProposalsDetailed: (...args: unknown[]) => mockListProposalsDetailed(...args),
  replayRealizedMergeFanout: (...args: unknown[]) => mockReplayRealizedMergeFanout(...args),
  setStatus: (...args: unknown[]) => mockSetStatus(...args),
  updateProposalField: (...args: unknown[]) => mockUpdateProposalField(...args),
}));

const mockNotifyFleetEvent = vi.fn();
vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: (...args: unknown[]) => mockNotifyFleetEvent(...args),
}));

vi.mock('../src/core/integrations/fleet-pulse-emit.js', () => ({
  emitMerge: vi.fn(async () => undefined),
  emitJudgeVerdict: vi.fn(async () => undefined),
}));

vi.mock('../src/core/fleet/event-bus.js', () => ({
  emit: vi.fn(async () => undefined),
}));

const mockLearnFromRejection = vi.fn();
vi.mock('../src/core/fleet/self-improve.js', () => ({
  learnFromRejection: (...args: unknown[]) => mockLearnFromRejection(...args),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

const mockReadDecisions = vi.fn(() => []);
const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'claude-opus-4-5',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
  })),
}));

const mockAppendHubEntry = vi.fn();
vi.mock('../src/core/genome/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/genome/store.js')>();
  return {
    ...actual,
    appendHubEntry: (...args: unknown[]) => mockAppendHubEntry(...args),
  };
});

const mockReadAutonomyEvidencePack = vi.fn();
const mockVerifyAutonomyEvidencePackV3 = vi.fn();
vi.mock('../src/core/autonomy/evidence-pack.js', () => ({
  readAutonomyEvidencePack: (...args: unknown[]) => mockReadAutonomyEvidencePack(...args),
  verifyAutonomyEvidencePackV3: (...args: unknown[]) => mockVerifyAutonomyEvidencePackV3(...args),
}));

const mockEvaluatePostMergeCreditRelease = vi.fn();
const mockHasReleasedPostMergeCredit = vi.fn();
vi.mock('../src/core/fleet/post-merge-credit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/post-merge-credit.js')>();
  return {
    ...actual,
    evaluatePostMergeCreditRelease: (...args: unknown[]) =>
      mockEvaluatePostMergeCreditRelease(...args),
    hasReleasedPostMergeCredit: (...args: unknown[]) => mockHasReleasedPostMergeCredit(...args),
    // Same signing boundary as the real function, gated on the mocked release
    // check: POST_MERGE_CREDIT_OPERATIONAL_RELEASE is a compile-time `false`
    // today, so the real gate can never open in any test. Content hashing and
    // HMAC attestation stay fully real.
    attestPostMergeCreditSkillCard: (card: SkillCard) => {
      try {
        if (!mockHasReleasedPostMergeCredit(card.labelBasis)) return null;
        const diffHash = card.verification?.diffHash;
        if (!card.proposalId || !diffHash) return null;
        const contentHash = skillCardContentHash(card);
        const attestation = signSkillCardAttestation({
          contentHash,
          skillId: card.skillId,
          revision: card.revision,
          proposalId: card.proposalId,
          diffHash,
        });
        return attestation ? { ...card, contentHash, attestation } : null;
      } catch {
        return null;
      }
    },
  };
});

// The SkillCard ledger itself is REAL — recordSkillCard delegates to the real
// append by default so tests assert against the actual persisted corpus.
const { mockRecordSkillCard, realRecordSkillCardRef } = vi.hoisted(() => ({
  mockRecordSkillCard: vi.fn(),
  realRecordSkillCardRef: { current: undefined as undefined | ((input: unknown) => void) },
}));
vi.mock('../src/core/fleet/skill-records.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/skill-records.js')>();
  realRecordSkillCardRef.current = actual.recordSkillCard as (input: unknown) => void;
  return {
    ...actual,
    recordSkillCard: (...args: unknown[]) => mockRecordSkillCard(...args),
  };
});

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { readSkillCards } from '../src/core/fleet/skill-records.js';
import { enroll, setKill } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TS = new Date('2026-03-01T12:00:00.000Z');
const MERGED_TS = new Date('2026-02-01T12:00:00.000Z');
const DEFAULT_DIFF = '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,4 @@\n+if (!user) return;\n const tok = user.token;';
const RELEASE_LABEL = `${POST_MERGE_CREDIT_RELEASE_LABEL}:evt-test:deadbeef`;

let defaultRepo: string;

function makeAppliedProposal(id: string, over: Partial<Proposal> = {}): Proposal {
  const diff = over.diff ?? DEFAULT_DIFF;
  const diffHash = hashDiff(diff);
  const engineModel = over.engineModel ?? 'claude:claude-opus-4-5';
  const engineTier = over.engineTier ?? 'frontier';
  const proposal = {
    id,
    repo: defaultRepo,
    origin: 'swarm',
    kind: 'patch',
    title: 'Fix null pointer in auth module',
    summary: 'Added null check before accessing user.token to prevent crash',
    status: 'applied',
    createdAt: FIXED_TS.toISOString(),
    engineTier,
    engineModel,
    diff,
    diffHash,
    verifyResult: {
      passed: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      baseBranch: 'main',
      baseHead: '1'.repeat(40),
      diffHash,
      verifiedAt: MERGED_TS.toISOString(),
      source: 'auto-merge',
    },
    realizedMerge: {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40),
      observedAt: MERGED_TS.toISOString(),
      proposalId: id,
      diffHash,
      intentAttestation: '5'.repeat(64),
      attestation: '6'.repeat(64),
    },
    ...over,
  } as unknown as Proposal;
  if (!Object.prototype.hasOwnProperty.call(over, 'provenanceSig')) {
    (proposal as Record<string, unknown>)['provenanceSig'] = signProvenance(
      engineModel,
      engineTier,
      diffHash,
    );
  }
  return proposal;
}

function makeEvidence(
  proposal: Proposal,
  overrides: Partial<AutonomyEvidencePack> = {},
): SignedAutonomyEvidencePackV3 {
  const diffHash = hashDiff(proposal.diff ?? '');
  return {
    version: 3,
    generatedAt: MERGED_TS.toISOString(),
    proposal: {
      id: proposal.id,
      repo: proposal.repo,
      kind: proposal.kind,
      status: proposal.status,
      origin: proposal.origin,
      title: proposal.title,
      createdAt: proposal.createdAt,
    },
    producer: {
      engineModel: proposal.engineModel,
      engineTier: proposal.engineTier,
    },
    diff: { hash: diffHash, files: ['src/auth.ts'], changedLines: 1 },
    target: 'main',
    trustBasis: 'evidence',
    remotePreferred: true,
    riskClass: 'low',
    gates: {
      authority: { ok: true, detail: 'authority passed' },
      provenance: { ok: true, detail: 'provenance passed' },
      verification: { ok: true, detail: 'verification passed' },
      risk: { ok: true, detail: 'risk passed' },
      scope: { ok: true, detail: 'scope passed' },
    },
    verification: {
      passed: true,
      detail: 'verification passed',
      commandKinds: ['test'],
      baseBranch: 'main',
      baseHead: '1'.repeat(40),
      diffHash,
      verifiedAt: MERGED_TS.toISOString(),
      source: 'auto-merge',
    },
    policy: {
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      reason: 'verified evidence passed',
    },
    payloadDigest: 'a'.repeat(64),
    signatureAlgorithm: 'hmac-sha256',
    signingKeyId: 'd'.repeat(64),
    signature: 'b'.repeat(64),
    sealedPackDigest: 'c'.repeat(64),
    ...overrides,
  } as SignedAutonomyEvidencePackV3;
}

function proposalRead(list: Proposal[]) {
  return {
    proposals: list,
    sourceState: 'healthy' as const,
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesDiscovered: list.length,
    filesRead: list.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  };
}

/** Prime every persisted-state read learnFromApplied performs for `proposal`. */
function primeVerified(proposal: Proposal): void {
  mockReadAutonomyEvidencePack.mockReturnValue(makeEvidence(proposal));
  mockEvaluatePostMergeCreditRelease.mockReturnValue({
    eligible: true,
    label: RELEASE_LABEL,
    reason: 'clean-window-elapsed',
  });
  mockHasReleasedPostMergeCredit.mockImplementation(
    (labelBasis: unknown) => labelBasis === RELEASE_LABEL,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wire31-home-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = tmpHome;

  mockAutoMergeProposal.mockReset();
  mockVerifyAndPersistProposal.mockReset();
  mockEvaluateAutoMergeReadinessPreflight.mockReset();
  mockHasCurrentVerificationBinding.mockReset();
  mockListProposalsDetailed.mockReset();
  mockReplayRealizedMergeFanout.mockReset();
  mockSetStatus.mockReset();
  mockUpdateProposalField.mockReset();
  mockNotifyFleetEvent.mockReset();
  mockLearnFromRejection.mockReset();
  mockJudgeProposal.mockReset();
  mockResolveFrontierJudgeClient.mockReset();
  mockReadDecisions.mockReset();
  mockRecordDecision.mockReset();
  mockAppendHubEntry.mockReset();
  mockReadAutonomyEvidencePack.mockReset();
  mockVerifyAutonomyEvidencePackV3.mockReset();
  mockEvaluatePostMergeCreditRelease.mockReset();
  mockHasReleasedPostMergeCredit.mockReset();
  mockRecordSkillCard.mockReset();

  proposals = [];
  mockListProposalsDetailed.mockImplementation(() => proposalRead(proposals));
  mockReplayRealizedMergeFanout.mockReturnValue(true);
  mockSetStatus.mockReturnValue(true);
  mockUpdateProposalField.mockReturnValue(true);
  mockNotifyFleetEvent.mockResolvedValue(undefined);
  mockAutoMergeProposal.mockImplementation(
    async (id: string) => ({ ok: false, merged: false, reason: `not-merged:${id}` }) as AutoMergeResult,
  );
  mockReadDecisions.mockReturnValue([]);
  mockAppendHubEntry.mockReturnValue(undefined);
  mockVerifyAutonomyEvidencePackV3.mockReturnValue({ ok: true, reason: 'valid signed fixture' });
  mockRecordSkillCard.mockImplementation((input: unknown) => realRecordSkillCardRef.current?.(input));

  try { setKill(false); } catch { /* ignore */ }
  defaultRepo = path.join(tmpHome, 'repo');
  fs.mkdirSync(defaultRepo, { recursive: true });
  expect(enroll(defaultRepo).ok).toBe(true);
});

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  vi.clearAllMocks();
});

// ===========================================================================
// The wire: applied proposals replayed by the pass reach learnFromApplied
// ===========================================================================

describe('skill-library wire — applied proposal writes a verified SkillCard', () => {
  it('writes exactly one structured SkillCard for an applied, verified proposal', async () => {
    const applied = makeAppliedProposal('prop-wire31-applied');
    primeVerified(applied);
    proposals = [applied];

    // autoMerge stays off: the fanout sweep — and therefore learning — runs
    // regardless of the merge opt-in, exactly like the rejection sweep.
    const out = await runAutoMergePass({ version: 1 } as AshlrConfig);

    expect(mockReplayRealizedMergeFanout).toHaveBeenCalledWith(
      applied.id,
      expect.any(Object),
      expect.any(Function),
    );
    expect(out).toMatchObject({ attempted: 0, merged: 0, results: [] });
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();

    expect(mockRecordSkillCard).toHaveBeenCalledTimes(1);
    const recorded = mockRecordSkillCard.mock.calls[0]![0] as Record<string, unknown>;
    expect(recorded['proposalId']).toBe(applied.id);
    expect(recorded['status']).toBe('verified');
    expect(recorded['source']).toBe('verified-proposal');
    expect(recorded['attestation']).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded['contentHash']).toMatch(/^[0-9a-f]{64}$/);

    // The card is actually in the ledger — a real append, readable back.
    const ledger = readSkillCards();
    expect(ledger).toHaveLength(1);
    const card = ledger[0]!;
    expect(card.proposalId).toBe(applied.id);
    expect(card.status).toBe('verified');
    expect(card.source).toBe('verified-proposal');
    expect(card.tags).toContain('m243:skill');
    expect(card.taskKinds).toContain('bug-fix');
    expect(card.commandKinds).toEqual(['test']);
    expect(card.verification?.passed).toBe(true);
    expect(card.verification?.diffHash).toBe(applied.diffHash);
    expect(card.learningSource).toBe('verified-proposal');
    expect(card.labelBasis).toBe(RELEASE_LABEL);

    // The legacy genome note accompanies the card (same write-back).
    expect(mockAppendHubEntry).toHaveBeenCalledTimes(1);
    expect(mockAppendHubEntry.mock.calls[0]![0]).toMatchObject({
      tags: expect.arrayContaining(['m243:skill', 'credit:released-v1']),
    });
  });

  it('writes no duplicate card on a later pass (corpus idempotency)', async () => {
    const applied = makeAppliedProposal('prop-wire31-idem');
    primeVerified(applied);
    proposals = [applied];

    await runAutoMergePass({ version: 1 } as AshlrConfig);
    await runAutoMergePass({ version: 1 } as AshlrConfig);

    expect(mockRecordSkillCard).toHaveBeenCalledTimes(1);
    expect(readSkillCards()).toHaveLength(1);
  });
});

describe('skill-library wire — non-applied proposals produce no card', () => {
  it('writes nothing for a rejected proposal even with merge evidence present', async () => {
    const rejected = makeAppliedProposal('prop-wire31-rejected', {
      status: 'rejected',
    } as Partial<Proposal>);
    primeVerified(rejected);
    proposals = [rejected];

    const out = await runAutoMergePass({ version: 1 } as AshlrConfig);

    // The applied-status gate keeps it out of the replay sweep entirely —
    // learnFromApplied is never reached, so no card can exist.
    expect(mockReplayRealizedMergeFanout).not.toHaveBeenCalled();
    expect(mockRecordSkillCard).not.toHaveBeenCalled();
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(readSkillCards()).toHaveLength(0);
    expect(out).toMatchObject({ attempted: 0, merged: 0, results: [] });
  });

  it('writes nothing when the release check is not eligible', async () => {
    const applied = makeAppliedProposal('prop-wire31-ineligible');
    primeVerified(applied);
    mockEvaluatePostMergeCreditRelease.mockReturnValue({
      eligible: false,
      label: null,
      reason: 'observation-window-not-elapsed',
    });
    proposals = [applied];

    const out = await runAutoMergePass({ version: 1 } as AshlrConfig);

    expect(mockReplayRealizedMergeFanout).toHaveBeenCalledTimes(1);
    expect(mockRecordSkillCard).not.toHaveBeenCalled();
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(readSkillCards()).toHaveLength(0);
    expect(out).toMatchObject({ attempted: 0, merged: 0, results: [] });
  });
});

describe('skill-library wire — fire-and-forget contract', () => {
  it('a throwing card write leaves the apply result unchanged', async () => {
    const applied = makeAppliedProposal('prop-wire31-throw');
    primeVerified(applied);
    proposals = [applied];
    mockRecordSkillCard.mockImplementation(() => {
      throw new Error('skill ledger unavailable');
    });

    const out = await runAutoMergePass({ version: 1 } as AshlrConfig);

    // The write-back attempt happened, the throw was swallowed inside
    // learnFromApplied, and the pass result is byte-identical to a clean run.
    expect(mockRecordSkillCard).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ attempted: 0, merged: 0, results: [] });
    expect(mockReplayRealizedMergeFanout).toHaveBeenCalledWith(
      applied.id,
      expect.any(Object),
      expect.any(Function),
    );
    // Independent best-effort writers are unaffected: the genome note was
    // still appended before the throwing card write, telemetry still fired.
    expect(mockAppendHubEntry).toHaveBeenCalledTimes(1);
    expect(readSkillCards()).toHaveLength(0);
  });

  it('skillLibrary:false is a byte-identical no-op through the wire', async () => {
    const applied = makeAppliedProposal('prop-wire31-flagoff');
    primeVerified(applied);
    proposals = [applied];
    const cfg = {
      version: 1,
      foundry: { skillLibrary: false },
    } as unknown as AshlrConfig;

    const out = await runAutoMergePass(cfg);

    expect(mockReplayRealizedMergeFanout).toHaveBeenCalledTimes(1);
    expect(mockRecordSkillCard).not.toHaveBeenCalled();
    expect(mockAppendHubEntry).not.toHaveBeenCalled();
    expect(readSkillCards()).toHaveLength(0);
    expect(out).toMatchObject({ attempted: 0, merged: 0, results: [] });
  });
});
