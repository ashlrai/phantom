/**
 * Job shape for the coding-CLI router. Jev may raise complexity, context or
 * latency. Risk is escalate-only: a model answer cannot make the job safer
 * than the heuristic. Context is measured from the text and can only grow.
 */

import type { TypeSafeAnswer, TypeSafeChoiceQuestion } from '../classify/typesafe-client.js';
import { decide } from './decide.js';
import { JOB_BANDS, JOB_CONTEXT_BANDS, JOB_LATENCIES } from './registry.js';
import type { DecideOptions, Decision, Interpretation } from './types.js';

export type JobBand = (typeof JOB_BANDS)[number];
export type JobLatency = (typeof JOB_LATENCIES)[number];
export type JobContextBand = (typeof JOB_CONTEXT_BANDS)[number];

export interface JobShape {
  complexity: JobBand;
  risk: JobBand;
  contextTokens: number;
  latency: JobLatency;
  source: 'heuristic' | 'jev';
}

export type JobShapeAsk = (
  kind: 'job-shape',
  state: string,
  questions: Readonly<Record<string, TypeSafeChoiceQuestion>>,
  opts: DecideOptions<JobShape>,
) => Promise<Decision<JobShape>>;

const CONTEXT_CAP = 200_000;
const CONTEXT_TOKENS: Readonly<Record<JobContextBand, number>> = {
  small: 2_000,
  medium: 16_000,
  large: 100_000,
};
const BAND_RANK: Readonly<Record<JobBand, number>> = { low: 0, medium: 1, high: 2 };

const RISK_HIGH = /\b(security|credential|credentials|auth|merge|secret|secrets|token|vulnerability)\b/i;
const COMPLEX_HIGH = /\b(architecture|migration|migrate|redesign)\b/i;
const LATENCY_NOW = /\b(urgent|asap|immediately|now)\b/i;

function band(value: string | undefined): JobBand | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

function choice(answer: TypeSafeAnswer | undefined): string | null {
  return answer?.type === 'choice' ? answer.choice : null;
}

export function jobShapeHeuristic(text: string): JobShape {
  const body = typeof text === 'string' ? text : '';
  const length = Math.min(CONTEXT_CAP, body.length);
  let complexity: JobBand = 'low';
  if (COMPLEX_HIGH.test(body) || length >= 8_000) complexity = 'high';
  else if (length >= 800) complexity = 'medium';
  return {
    complexity,
    risk: RISK_HIGH.test(body) ? 'high' : 'low',
    contextTokens: length,
    latency: LATENCY_NOW.test(body) ? 'interactive' : 'batch',
    source: 'heuristic',
  };
}

function questions(): Record<string, TypeSafeChoiceQuestion> {
  const bandCriteria = {
    low: 'Small, local, or mechanical.',
    medium: 'Ordinary coding work.',
    high: 'Large, subtle, or high-leverage.',
  };
  return {
    complexity: { type: 'choice', instructions: 'How hard is this job?', criteria: bandCriteria },
    risk: {
      type: 'choice',
      instructions: 'How much security or merge risk does this job carry? Do not lower a risk the text already states.',
      criteria: {
        low: 'No credential, auth, secret, or merge concern.',
        medium: 'Some care, short of a security or merge change.',
        high: 'Security, credentials, auth, secrets, or merge.',
      },
    },
    context: {
      type: 'choice',
      instructions: 'How large is the context this job needs?',
      criteria: { small: 'A short edit.', medium: 'A few files.', large: 'A wide change.' },
    },
    latency: {
      type: 'choice',
      instructions: 'Does the operator need this immediately?',
      criteria: { interactive: 'Urgent or interactive.', batch: 'Can wait.' },
    },
  };
}

function interpret(answers: Readonly<Record<string, TypeSafeAnswer>>, measured: number): Interpretation<JobShape> | undefined {
  const complexity = band(choice(answers['complexity']) ?? undefined);
  const risk = band(choice(answers['risk']) ?? undefined);
  const context = choice(answers['context']);
  const latency = choice(answers['latency']);
  if (!complexity || !risk || (context !== 'small' && context !== 'medium' && context !== 'large')) return undefined;
  if (latency !== 'interactive' && latency !== 'batch') return undefined;
  const confidences = [answers['complexity'], answers['risk'], answers['context'], answers['latency']]
    .map((answer) => (answer && 'confidence' in answer ? answer.confidence : 0));
  return {
    value: {
      complexity,
      risk,
      contextTokens: Math.max(measured, CONTEXT_TOKENS[context]),
      latency,
      source: 'jev',
    },
    confidence: Math.min(...confidences),
    label: `${complexity}/${risk}/${context}/${latency}`,
  };
}

function tighten(base: JobShape, heard: JobShape): JobShape {
  const risk = BAND_RANK[heard.risk] >= BAND_RANK[base.risk] ? heard.risk : base.risk;
  return {
    complexity: heard.complexity,
    risk,
    contextTokens: Math.max(base.contextTokens, Math.min(CONTEXT_CAP, heard.contextTokens)),
    latency: heard.latency,
    source: 'jev',
  };
}

/** Classify one job. Never throws. An injected ask is for tests. */
export async function classifyJob(text: string, deps?: { ask?: JobShapeAsk }): Promise<JobShape> {
  const heuristic = jobShapeHeuristic(text);
  if (typeof text !== 'string' || text.trim() === '') return heuristic;
  const ask = deps?.ask ?? decide;
  try {
    const decision = await ask('job-shape', text.slice(0, 3_000), questions(), {
      fallback: heuristic,
      interpret: (answers) => interpret(answers, heuristic.contextTokens),
      escalateOnly: (value) => BAND_RANK[value.risk] ?? 0,
    });
    if (decision.path !== 'jev') return heuristic;
    return tighten(heuristic, decision.value);
  } catch {
    return heuristic;
  }
}
