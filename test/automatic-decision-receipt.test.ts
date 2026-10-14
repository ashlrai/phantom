import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { composeAutomaticDecisionReceipt } from '../src/core/routing/automatic-decision.js';
import type { AutomaticDecisionReceiptInput, AutomaticDecisionReceiptV1 } from '../src/core/routing/automatic-decision-types.js';
import type { SeatAdvice } from '../src/core/verse/multimodel/types.js';

// Literal oracles: no selector, formatter, alias resolver or classifier supplies gold.
const BASELINE: SeatAdvice = {
  choice: { seatId: 'acct-A', engine: 'claude', model: 'claude-opus-4', contextMode: 'expansive', contextWindow: 200000,
    label: 'PRIVATE_LABEL', local: false, note: 'PRIVATE_NOTE', tier: 'elite' },
  stay: false, why: 'PRIVATE_WHY', factors: ['PRIVATE_FACTOR'],
  alternatives: [
    { seatId: 'acct-A', engine: 'claude', model: 'claude-sonnet-4', contextMode: 'standard', contextWindow: 64000, label: 'PRIVATE_ALT', local: false, note: 'PRIVATE_ALT_NOTE' },
    { seatId: 'acct-A', engine: 'claude', model: 'claude-opus-4', contextMode: 'standard', contextWindow: 100000, label: 'PRIVATE_DUP', local: false, note: 'PRIVATE_DUP_NOTE' },
  ],
  held: [{ seatId: 'acct-B', label: 'PRIVATE_HELD_LABEL', reason: 'PRIVATE_HELD_REASON' }],
  classification: { kind: 'code', task: 'code', difficulty: 'high', size: 'large', estTokens: 25,
    label: 'PRIVATE_CLASS_LABEL', signals: ['PRIVATE_SIGNAL'], decidedBy: 'jev', confidence: 0.99, needsFrontier: 1 },
  mode: 'auto', localOnly: { on: false, reason: 'PRIVATE_LOCAL_REASON' }, routerWhy: 'PRIVATE_ROUTER_WHY',
};
const INPUT: AutomaticDecisionReceiptInput = {
  baseline: BASELINE, phase: 'execute', phaseBasis: { kind: 'prompt-intent', declaredManagerIntent: null },
  eligibilitySurface: { kind: 'interactive-chat-advice', declaredRole: null }, observedAtMs: 1000,
};
const GOLD: AutomaticDecisionReceiptV1 = {
  schemaVersion: 1, scope: 'automatic-decision-receipt', executionAuthorized: false, status: 'recommendation',
  recommendedBinding: { seatId: 'acct-A', engine: 'claude', model: 'claude-opus-4', contextMode: 'expansive', contextWindow: 200000 },
  alternatives: [
    { seatId: 'acct-A', engine: 'claude', model: 'claude-sonnet-4', contextMode: 'standard', contextWindow: 64000 },
    { seatId: 'acct-A', engine: 'claude', model: 'claude-opus-4', contextMode: 'standard', contextWindow: 100000 },
  ],
  baseline: { mode: 'auto', stay: false, localOnly: false }, held: null,
  exclusions: [{ seatId: 'acct-B', code: 'baseline-excluded' }],
  intent: { phase: 'execute', phaseBasis: { kind: 'prompt-intent', declaredManagerIntent: null },
    eligibilitySurface: { kind: 'interactive-chat-advice', declaredRole: null }, provenance: 'caller-declared' },
  correlation: { provenance: 'caller-declared', observedAtMs: 1000,
    refs: { sourceRef: null, policyRef: null, rosterRef: null, sessionRef: null, preferenceRef: null, basisRef: null } },
  classification: { scope: 'task-triage-only', kind: 'code', task: 'code', difficulty: 'high', size: 'large', estTokens: 25,
    decidedBy: 'jev', confidence: 0.99, needsFrontier: 1, fallbackCode: 'not-provided' },
  returnedSessionBinding: { state: 'unknown', value: null }, providerObservedBinding: { state: 'unknown', value: null },
  verifiedOutcome: { state: 'unknown', value: null },
  metrics: {
    quality: { state: 'unknown', value: null, code: 'not-qualified-by-receipt' },
    executionDurationMs: { state: 'unknown', value: null, code: 'not-qualified-by-receipt' },
    realizedCostUsd: { state: 'unknown', value: null, code: 'not-qualified-by-receipt' },
  },
};

function input(): AutomaticDecisionReceiptInput { return structuredClone(INPUT); }
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}

describe('pure Automatic decision receipt', () => {
  it('matches a full literal oracle without reranking aliases, modes or duplicate accounts', () => {
    expect(composeAutomaticDecisionReceipt(INPUT)).toEqual(GOLD);
  });

  it('matches the historical binding oracle with missing mode/window/model unknown', () => {
    const legacy = input();
    legacy.baseline.choice = { seatId: 'legacy', engine: 'future-engine', model: null, local: false, label: 'PRIVATE', note: 'PRIVATE' };
    legacy.baseline.alternatives = [];
    expect(composeAutomaticDecisionReceipt(legacy)).toEqual({ ...GOLD,
      recommendedBinding: { seatId: 'legacy', engine: 'future-engine', model: null, contextMode: null, contextWindow: null }, alternatives: [] });
  });

  it('matches the held privacy oracle with fixed text and ordered duplicate exclusions', () => {
    const held = input(); held.baseline.choice = null; held.baseline.alternatives = [];
    held.baseline.localOnly.on = true;
    held.baseline.held = [{ seatId: 'z', label: 'PRIVATE', reason: 'PRIVATE' }, { seatId: 'z', label: 'PRIVATE', reason: 'PRIVATE' }];
    expect(composeAutomaticDecisionReceipt(held)).toEqual({ ...GOLD, status: 'advisory-held', recommendedBinding: null, alternatives: [],
      baseline: { mode: 'auto', stay: false, localOnly: true },
      held: { code: 'baseline-held', message: 'No baseline recommendation is available.' },
      exclusions: [{ seatId: 'z', code: 'baseline-excluded' }, { seatId: 'z', code: 'baseline-excluded' }] });
  });

  it('does not copy prose, raw prompts, quota or arbitrary extra claims', () => {
    const candidate = input();
    const result = composeAutomaticDecisionReceipt(Object.assign(candidate, { prompt: 'PRIVATE_PROMPT', grant: 'PRIVATE_GRANT',
      capacity: { seats: 99 }, fallbackReason: 'PRIVATE_FALLBACK', executionAuthorized: true }));
    expect(result).toEqual(GOLD);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    // An omitted free-text getter must never be read either.
    Object.defineProperty(candidate.baseline, 'why', { get: () => { throw new Error('private prose read'); } });
    Object.defineProperty(candidate.baseline.classification, 'label', { get: () => { throw new Error('private label read'); } });
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual(GOLD);
  });

  it.each(['fresh', 'prior', 'invalid', 'future', 'expired', 'foreign', 'incomplete', 'verified', 'authorized'])('ignores self-declared %s metrics, actual binding and outcomes', (claim) => {
    const candidate = Object.assign(input(), {
      returnedSessionBinding: { state: claim, value: { model: 'promoted-model' } },
      providerObservedBinding: { state: claim, value: { model: 'promoted-model' } }, verifiedOutcome: { state: claim, value: 'success' },
      metrics: { quality: { state: claim, value: 1 }, executionDurationMs: { state: claim, value: 1 }, realizedCostUsd: { state: claim, value: 0 } },
    });
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual(GOLD);
  });

  it('retains declared persisted intent and host role without creating admission', () => {
    const candidate = input(); candidate.phase = 'replan';
    candidate.phaseBasis = { kind: 'declared-persisted-manager-intent', declaredManagerIntent: 'review' };
    candidate.eligibilitySurface = { kind: 'declared-host-role', declaredRole: 'leader' };
    candidate.refs = { sourceRef: 'sha256:abc', policyRef: 'policy.ready', rosterRef: 'roster1', sessionRef: 'session.verified', preferenceRef: 'prefs1', basisRef: 'authorized' };
    const result = composeAutomaticDecisionReceipt(candidate);
    expect(result).toEqual({ ...GOLD, intent: { phase: 'replan', phaseBasis: { kind: 'declared-persisted-manager-intent', declaredManagerIntent: 'review' },
      eligibilitySurface: { kind: 'declared-host-role', declaredRole: 'leader' }, provenance: 'caller-declared' },
      correlation: { provenance: 'caller-declared', observedAtMs: 1000,
        refs: { sourceRef: 'sha256:abc', policyRef: 'policy.ready', rosterRef: 'roster1', sessionRef: 'session.verified', preferenceRef: 'prefs1', basisRef: 'authorized' } } });
  });

  it('does not mistake future correlation time or stale-looking refs for measured freshness', () => {
    const candidate = input(); candidate.observedAtMs = 9999999999999; candidate.refs = { basisRef: 'expired:0', sessionRef: 'foreign-session' };
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD, correlation: { provenance: 'caller-declared', observedAtMs: 9999999999999,
      refs: { sourceRef: null, policyRef: null, rosterRef: null, sessionRef: 'foreign-session', preferenceRef: null, basisRef: 'expired:0' } } });
  });

  it.each([NaN, Infinity, -Infinity, -1])('keeps invalid triage/time numeric value %s unknown', value => {
    const candidate = input(); candidate.observedAtMs = value; candidate.baseline.classification.estTokens = value;
    candidate.baseline.classification.confidence = value; candidate.baseline.classification.needsFrontier = value;
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD, correlation: { ...GOLD.correlation, observedAtMs: null },
      classification: { ...GOLD.classification, estTokens: null, confidence: null, needsFrontier: null } });
  });

  it('closes probabilities above one and unsupported typed-call enum values without rerouting', () => {
    const candidate = input();
    Object.assign(candidate.baseline.classification, { kind: 'authorized', task: 'dispatch', difficulty: 'elite', size: 'huge', decidedBy: 'verified', confidence: 2, needsFrontier: 2 });
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD,
      classification: { ...GOLD.classification, kind: null, task: null, difficulty: null, size: null, decidedBy: 'unknown', confidence: null, needsFrontier: null } });
  });

  it('uses the documented absent classifier rules default and separately supplied fixed fallback code', () => {
    const candidate = input(); delete candidate.baseline.classification.decidedBy;
    candidate.classifierFallbackCode = 'local-only';
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD, classification: { ...GOLD.classification, decidedBy: 'rules', fallbackCode: 'local-only' } });
  });

  it('keeps unsupported phase, host-role and fallback declarations unknown without promotion', () => {
    const candidate = input();
    Object.assign(candidate, { phase: 'authorized', phaseBasis: { kind: 'declared-persisted-manager-intent', declaredManagerIntent: 'executed' },
      eligibilitySurface: { kind: 'verified-host-role', declaredRole: 'leader' }, classifierFallbackCode: 'PRIVATE_ERROR' });
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD, intent: {
      phase: null, phaseBasis: { kind: 'unknown', declaredManagerIntent: null },
      eligibilitySurface: { kind: 'unknown', declaredRole: null }, provenance: 'caller-declared',
    } });
  });

  it('preserves zero/one triage bounds and an exact maximum-length opaque reference', () => {
    const candidate = input(); candidate.baseline.classification.confidence = 0; candidate.baseline.classification.needsFrontier = 1;
    candidate.baseline.classification.estTokens = 0; candidate.observedAtMs = 0; candidate.refs = { sourceRef: 'x'.repeat(256) };
    const result = composeAutomaticDecisionReceipt(candidate);
    expect(result.classification).toEqual({ ...GOLD.classification, estTokens: 0, confidence: 0, needsFrontier: 1 });
    expect(result.correlation).toEqual({ ...GOLD.correlation, observedAtMs: 0, refs: { ...GOLD.correlation.refs, sourceRef: 'x'.repeat(256) } });
    expect(result.metrics).toEqual(GOLD.metrics);
  });

  it('rejects path-shaped, whitespace, overlong and unsupported refs without retaining their text', () => {
    const candidate = input(); candidate.refs = { sourceRef: '/Users/private/file', policyRef: 'policy\nsecret', rosterRef: 'x'.repeat(257), sessionRef: '', preferenceRef: 'https://private', basisRef: 'valid:1' };
    const result = composeAutomaticDecisionReceipt(candidate);
    expect(result.correlation.refs).toEqual({ sourceRef: null, policyRef: null, rosterRef: null, sessionRef: null, preferenceRef: null, basisRef: 'valid:1' });
    expect(result.recommendedBinding).toEqual(GOLD.recommendedBinding);
  });

  it('normalizes only invalid scalars, keeping optional context unknown and literal model spelling', () => {
    const candidate = input(); Object.assign(candidate.baseline.choice!, { contextMode: 'guessed', contextWindow: Infinity });
    expect(composeAutomaticDecisionReceipt(candidate).recommendedBinding).toEqual({ seatId: 'acct-A', engine: 'claude', model: 'claude-opus-4', contextMode: null, contextWindow: null });
  });

  it('copies stay and cheap-first as advisory fields only', () => {
    const candidate = input(); candidate.baseline.stay = true; candidate.baseline.mode = 'cheap-first';
    expect(composeAutomaticDecisionReceipt(candidate)).toEqual({ ...GOLD, baseline: { mode: 'cheap-first', stay: true, localOnly: false } });
  });

  it('is deterministic for clones, accepts frozen data and detaches every projected object', () => {
    const candidate = input(); const before = structuredClone(candidate); freeze(candidate);
    const result = composeAutomaticDecisionReceipt(candidate);
    expect(candidate).toEqual(before); expect(result).toEqual(composeAutomaticDecisionReceipt(structuredClone(before)));
    expect(result.recommendedBinding).not.toBe(candidate.baseline.choice);
    expect(result.alternatives).not.toBe(candidate.baseline.alternatives);
    expect(result.intent.phaseBasis).not.toBe(candidate.phaseBasis);
    result.alternatives[0].model = 'operator-display-edit';
    expect(candidate.baseline.alternatives[0].model).toBe('claude-sonnet-4');
    expect(result.metrics.quality).not.toBe(result.metrics.realizedCostUsd);
  });
});

describe('receipt browser dependency boundary', () => {
  it.each(['automatic-decision.ts', 'automatic-decision-types.ts'])('%s has only type imports and no runtime import/IO/client/clock path', file => {
    const path = fileURLToPath(new URL(`../src/core/routing/${file}`, import.meta.url));
    const source = readFileSync(path, 'utf8'); const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function inspect(node: ts.Node): void {
      if (ts.isImportDeclaration(node)) {
        expect(node.importClause?.isTypeOnly).toBe(true);
        imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      }
      if (ts.isExportDeclaration(node)) expect(node.moduleSpecifier).toBeUndefined();
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        expect(node.expression.getText(ast)).not.toMatch(/^(?:require|fetch|Date\.now|Math\.random|.*(?:readFile|writeFile|decide|adviseSeat|routeSeat|canonicalModelId))$/);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
    expect(imports).toEqual(file === 'automatic-decision.ts' ? ['./automatic-decision-types.js']
      : ['../verse/multimodel/types.js', '../verse/types.js', './types.js']);
    expect(source).not.toMatch(/node:|\bprocess\b|\blocalStorage\b|\bnew Date\b/);
  });
});
