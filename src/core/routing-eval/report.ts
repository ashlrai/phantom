/**
 * Scores a routing-eval corpus through routeComplexity. No network, no keys,
 * and no model completion: the stub is accepted and not called.
 */
import {
  COMPLEXITY_ESCALATION_REASONS,
  type ComplexityEscalationReason,
  type ComplexityRouteInput,
} from '../routing/policy.js';
import type { InferenceTier } from '../routing/tiers.js';
import { complexityPathIsTier1, routeComplexity, stubModelClient } from './bind.js';
import { FRONTIER_EVAL_PRICE_TABLE, frontierEstimateMicros } from './prices.js';

export const ROUTING_EVAL_CORPUS_SCHEMA = 'phantom-routing-eval-corpus/v1';
export const ROUTING_EVAL_REPORT_SCHEMA = 'phantom-routing-eval/v1';

const MAX_OUTPUT_TOKENS = 100_000;

export interface RoutingEvalTask extends ComplexityRouteInput {
  expectedTier: InferenceTier;
  /** Output tokens assumed if this task had gone to the frontier reference. */
  assumedOutputTokens: number;
}

export interface RoutingEvalCorpus {
  schema: typeof ROUTING_EVAL_CORPUS_SCHEMA;
  tasks: RoutingEvalTask[];
}

export interface RoutingEvalMismatch {
  id: string;
  expectedTier: InferenceTier;
  actualTier: InferenceTier;
  reasons: ComplexityEscalationReason[];
}

export interface RoutingEvalInvariantViolation {
  id: string;
  detail: string;
}

export interface RoutingEvalReport {
  schema: typeof ROUTING_EVAL_REPORT_SCHEMA;
  fixtureCount: number;
  routedLocal: number;
  routedFrontier: number;
  /** Fraction routed local, four decimal places. */
  shareRoutedLocal: string;
  correct: number;
  /** Fraction matching expectedTier, four decimal places. */
  accuracy: string;
  mismatches: RoutingEvalMismatch[];
  /** Tasks that carried each reason. A task can add to more than one count. */
  escalationReasons: Partial<Record<ComplexityEscalationReason, number>>;
  frontierDollarsAvoided: {
    label: typeof FRONTIER_EVAL_PRICE_TABLE.label;
    note: string;
    model: typeof FRONTIER_EVAL_PRICE_TABLE.model;
    usdPerMillionInputTokens: number;
    usdPerMillionOutputTokens: number;
    localInputTokens: number;
    localOutputTokens: number;
    /** Decimal USD from integer micros. Six places. */
    usd: string;
  };
  modelCalls: number;
  invariantViolations: RoutingEvalInvariantViolation[];
}

function evalError(message: string): Error {
  return new Error(`routing eval: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ratio4(numerator: number, denominator: number): string {
  if (denominator === 0) return '0.0000';
  const scaled = Math.floor((numerator * 10_000 + Math.floor(denominator / 2)) / denominator);
  const whole = Math.floor(scaled / 10_000);
  const frac = String(scaled % 10_000).padStart(4, '0');
  return `${whole}.${frac}`;
}

function usdFromMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000).padStart(6, '0');
  return `${whole}.${frac}`;
}

function readExpectedTier(value: unknown, id: string): InferenceTier {
  if (value === 'local' || value === 'frontier') return value;
  throw evalError(`${id}: expectedTier must be local or frontier`);
}

function readOutputTokens(value: unknown, id: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_OUTPUT_TOKENS) {
    return value;
  }
  throw evalError(`${id}: assumedOutputTokens must be an integer from 0 to ${MAX_OUTPUT_TOKENS}`);
}

function parseTask(value: unknown, index: number): RoutingEvalTask {
  if (!isRecord(value)) throw evalError(`task ${index} must be an object`);
  const id = typeof value['id'] === 'string' ? value['id'] : `#${index}`;
  const expectedTier = readExpectedTier(value['expectedTier'], id);
  const assumedOutputTokens = readOutputTokens(value['assumedOutputTokens'], id);
  const task: RoutingEvalTask = {
    id,
    taskKind: typeof value['taskKind'] === 'string' ? value['taskKind'] : '',
    touchedPaths: Array.isArray(value['touchedPaths']) ? value['touchedPaths'] as string[] : [],
    contextTokens: typeof value['contextTokens'] === 'number' ? value['contextTokens'] : Number.NaN,
    priorVerifyFailures: typeof value['priorVerifyFailures'] === 'number' ? value['priorVerifyFailures'] : Number.NaN,
    expectedTier,
    assumedOutputTokens,
  };
  if (typeof value['role'] === 'string') task.role = value['role'];
  if (typeof value['mainMerge'] === 'boolean') task.mainMerge = value['mainMerge'];
  if (typeof value['inferenceHost'] === 'string') task.inferenceHost = value['inferenceHost'];
  if (Array.isArray(value['importsTier1'])) task.importsTier1 = value['importsTier1'] as string[];
  return task;
}

/** Read a parsed corpus object. Throws on a shape the scorer cannot trust. */
export function parseRoutingEvalCorpus(value: unknown): RoutingEvalCorpus {
  if (!isRecord(value)) throw evalError('corpus must be an object');
  if (value['schema'] !== ROUTING_EVAL_CORPUS_SCHEMA) {
    throw evalError(`schema must be ${ROUTING_EVAL_CORPUS_SCHEMA}`);
  }
  if (!Array.isArray(value['tasks'])) throw evalError('tasks must be an array');
  const tasks = value['tasks'].map((task, index) => parseTask(task, index));
  if (tasks.length < 30 || tasks.length > 60) {
    throw evalError(`tasks must hold 30 to 60 records, found ${tasks.length}`);
  }
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw evalError(`${task.id}: duplicate id`);
    seen.add(task.id);
  }
  return { schema: ROUTING_EVAL_CORPUS_SCHEMA, tasks };
}

function invariantDetail(task: RoutingEvalTask, tier: InferenceTier, loopback: boolean): string | null {
  if (tier !== 'local') return null;
  if (task.role === 'merge') return 'merge role routed local';
  if (task.role === 'credential') return 'credential role routed local';
  if (task.mainMerge === true) return 'main merge routed local';
  const importsTier1 = task.importsTier1 ?? [];
  if (task.touchedPaths.some((path) => complexityPathIsTier1(path, importsTier1))) {
    return 'Tier-1 path routed local';
  }
  if (!loopback) return 'local decision is not loopback';
  return null;
}

/** Score every task. The returned modelCalls count is from the stub this function creates. */
export function evaluateRoutingCorpus(corpus: RoutingEvalCorpus): RoutingEvalReport {
  const stub = stubModelClient();
  const mismatches: RoutingEvalMismatch[] = [];
  const invariantViolations: RoutingEvalInvariantViolation[] = [];
  const reasonCounts = new Map<ComplexityEscalationReason, number>();
  let routedLocal = 0;
  let localInputTokens = 0;
  let localOutputTokens = 0;

  for (const task of corpus.tasks) {
    const decision = routeComplexity(task, stub.client);
    if (decision.tier === 'local') {
      routedLocal += 1;
      localInputTokens += task.contextTokens;
      localOutputTokens += task.assumedOutputTokens;
    }
    for (const reason of decision.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    if (decision.tier !== task.expectedTier) {
      mismatches.push({
        id: task.id,
        expectedTier: task.expectedTier,
        actualTier: decision.tier,
        reasons: decision.reasons,
      });
    }
    const detail = invariantDetail(task, decision.tier, decision.localInference?.loopback === true);
    if (detail) invariantViolations.push({ id: task.id, detail });
  }

  const escalationReasons: Partial<Record<ComplexityEscalationReason, number>> = {};
  for (const reason of COMPLEXITY_ESCALATION_REASONS) {
    const count = reasonCounts.get(reason);
    if (count) escalationReasons[reason] = count;
  }

  const fixtureCount = corpus.tasks.length;
  const micros = frontierEstimateMicros(localInputTokens, localOutputTokens);
  return {
    schema: ROUTING_EVAL_REPORT_SCHEMA,
    fixtureCount,
    routedLocal,
    routedFrontier: fixtureCount - routedLocal,
    shareRoutedLocal: ratio4(routedLocal, fixtureCount),
    correct: fixtureCount - mismatches.length,
    accuracy: ratio4(fixtureCount - mismatches.length, fixtureCount),
    mismatches,
    escalationReasons,
    frontierDollarsAvoided: {
      label: FRONTIER_EVAL_PRICE_TABLE.label,
      note: 'Not a bill and not a live price. Input and output tokens of tasks routed local, priced with the rates below.',
      model: FRONTIER_EVAL_PRICE_TABLE.model,
      usdPerMillionInputTokens: FRONTIER_EVAL_PRICE_TABLE.usdPerMillionInputTokens,
      usdPerMillionOutputTokens: FRONTIER_EVAL_PRICE_TABLE.usdPerMillionOutputTokens,
      localInputTokens,
      localOutputTokens,
      usd: usdFromMicros(micros),
    },
    modelCalls: stub.calls(),
    invariantViolations,
  };
}
