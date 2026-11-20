/**
 * The `worker-handoff` bus body contract: the exact shape
 * `ashlr fleet handoff-send --apply` and `agents bus handoff` emit, and the
 * only shape `fleet handoff-receive`/`handoff-reply` accept — exactly the
 * `kind`/`taskId`/`prompt` keys, `kind:'worker-handoff'`, a fleet job id and
 * a non-empty prompt. One definition serves the receive/reply verbs and the
 * read-side projections that list pending assignments, so they can never
 * disagree about what is receivable.
 */
import { isFleetJobId } from './runs-job-detail.js';

export interface WorkerHandoffBody { taskId: string; prompt: string }

const HANDOFF_BODY_KEYS = new Set(['kind', 'taskId', 'prompt']);

/** Exact body schema emitted by `ashlr fleet handoff-send --apply`. */
export function isWorkerHandoffBody(body: unknown): body is WorkerHandoffBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return Object.keys(record).every(key => HANDOFF_BODY_KEYS.has(key)) &&
    record['kind'] === 'worker-handoff' &&
    typeof record['taskId'] === 'string' && isFleetJobId(record['taskId']) &&
    typeof record['prompt'] === 'string' && record['prompt'].trim().length > 0;
}
