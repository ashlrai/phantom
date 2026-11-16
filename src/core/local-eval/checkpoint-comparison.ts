/** Bounded offline replay: context retention diagnostics, never provider usage or GAIA claims. */
import { z } from 'zod';
import type { ChatMessage } from '../types.js';
import { buildCheckpointContext, checkpointDraftSchema, normalizeCheckpoint } from '../run/checkpoints.js';
import { conservativeRequestTokenReservation } from '../run/model-call-authority.js';

export const MAX_CHECKPOINT_REPLAY_BYTES = 1024 * 1024;
const text = z.string().min(1).max(8192);
const fixtureSchema = z.object({
  task_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  objective: text,
  system_instructions: text,
  fresh_repo_state: text,
  fixed_interval: z.number().int().min(1).max(64),
  turns: z.array(z.object({
    prompt: text,
    assistant: z.string().max(8192),
    tool_event: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), name: text, result: z.string().max(65536) }).strict().optional(),
    fixed_summary: text.optional(),
    checkpoint: checkpointDraftSchema.optional(),
  }).strict()).min(2).max(64),
  assertions: z.object({ contains: z.array(text).min(1).max(64), excludes: z.array(text).max(64) }).strict(),
}).strict();

export type CheckpointReplayFixture = z.infer<typeof fixtureSchema>;
export interface CheckpointStrategyResult {
  strategy: 'fixed-interval' | 'checkpoint-resume';
  input_tokens: number;
  requests: number;
  resets: number;
  outcome: 'passed' | 'failed';
  assertions: { passed: number; total: number };
}
export interface CheckpointComparison {
  schema_version: 1;
  task_id: string;
  mode: 'scripted-replay';
  token_basis: 'conservative-request-reservation-v1';
  outcome_basis: 'final-request-context-assertions';
  strategies: [CheckpointStrategyResult, CheckpointStrategyResult];
}

function validateFixture(value: unknown): CheckpointReplayFixture {
  // Bound serialized input before parsing nested checkpoint objects. Errors never echo source data.
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { throw new Error('Invalid checkpoint replay fixture'); }
  if (bytes > MAX_CHECKPOINT_REPLAY_BYTES) throw new Error('Checkpoint replay fixture exceeds byte limit');
  const parsed = fixtureSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid checkpoint replay fixture');
  const fixture = parsed.data;
  const ids = new Set<string>();
  let checkpoints = 0;
  for (const [index, turn] of fixture.turns.entries()) {
    if (turn.checkpoint && turn.checkpoint.objective !== fixture.objective) throw new Error('Replay checkpoint objective differs from task');
    if (turn.tool_event) {
      if (ids.has(turn.tool_event.id)) throw new Error('Duplicate replay tool event');
      ids.add(turn.tool_event.id);
    }
    const hasNext = index + 1 < fixture.turns.length;
    if (hasNext && (index + 1) % fixture.fixed_interval === 0 && !turn.fixed_summary) {
      throw new Error('Missing fixed-interval replay summary');
    }
    if (hasNext && turn.checkpoint) checkpoints++;
  }
  if (!checkpoints || fixture.fixed_interval >= fixture.turns.length) throw new Error('Replay requires both strategy boundaries');
  return fixture;
}

/** Both arms receive identical scripted events; only their retained context differs. */
export function compareCheckpointReplay(value: unknown, env: NodeJS.ProcessEnv = process.env): CheckpointComparison {
  if (env['PHANTOM_CHECKPOINTS'] !== '1') throw new Error('PHANTOM_CHECKPOINTS=1 is required');
  const fixture = validateFixture(value);
  const run = (strategy: CheckpointStrategyResult['strategy']): CheckpointStrategyResult => {
    let messages: ChatMessage[] = [
      { role: 'system', content: fixture.system_instructions },
      { role: 'user', content: `Objective:\n${fixture.objective}\n\nFresh repository state:\n${fixture.fresh_repo_state}` },
    ];
    let input_tokens = 0, resets = 0, revision = 0;
    let finalContext = '';
    const evidenceRefs: string[] = [];
    for (const [index, turn] of fixture.turns.entries()) {
      messages.push({ role: 'user', content: turn.prompt });
      input_tokens += conservativeRequestTokenReservation(messages);
      finalContext = messages.map(message => message.content).join('\n');
      const event = turn.tool_event;
      messages.push({ role: 'assistant', content: turn.assistant,
        ...(event ? { toolCalls: [{ id: event.id, name: event.name, arguments: {} }] } : {}) });
      if (event) {
        messages.push({ role: 'tool', content: event.result, name: event.name, toolCallId: event.id });
        evidenceRefs.push(event.id);
      }
      if (index + 1 === fixture.turns.length) continue;
      if (strategy === 'checkpoint-resume' && turn.checkpoint) {
        const checkpoint = normalizeCheckpoint(turn.checkpoint, evidenceRefs, ++revision, '2026-01-01T00:00:00.000Z');
        messages = buildCheckpointContext(checkpoint, fixture.fresh_repo_state, fixture.system_instructions);
        resets++;
      } else if (strategy === 'fixed-interval' && (index + 1) % fixture.fixed_interval === 0) {
        messages = [messages[0]!, messages[1]!, { role: 'user', content: `Fixed-interval summary:\n${turn.fixed_summary!}` }];
        resets++;
      }
    }
    const checks = [
      ...fixture.assertions.contains.map(value => finalContext.includes(value)),
      ...fixture.assertions.excludes.map(value => !finalContext.includes(value)),
    ];
    const passed = checks.filter(Boolean).length;
    return { strategy, input_tokens, requests: fixture.turns.length, resets,
      outcome: passed === checks.length ? 'passed' : 'failed', assertions: { passed, total: checks.length } };
  };
  return { schema_version: 1, task_id: fixture.task_id, mode: 'scripted-replay',
    token_basis: 'conservative-request-reservation-v1', outcome_basis: 'final-request-context-assertions',
    strategies: [run('fixed-interval'), run('checkpoint-resume')] };
}

/** RQ-AGL-EVAL-1 condition D hook. Caller owns repetitions and independent real-task checking. */
export function runCheckpointConditionD(fixture: unknown, env: NodeJS.ProcessEnv = process.env) {
  return { evaluation: 'RQ-AGL-EVAL-1' as const, condition: 'D' as const, comparison: compareCheckpointReplay(fixture, env) };
}
