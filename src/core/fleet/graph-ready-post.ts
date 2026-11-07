/** Work-request delivery only; completion is explicit caller data. */
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import { MAX_BUS_BATCH_BYTES, MAX_BUS_BATCH_MESSAGES, postBusBatch } from './bus-batch-post.js';
import type { BusInboxOptions } from './bus-inbox.js';
import { taskReadyFrontier } from './task-ready-frontier.js';

export const MAX_GRAPH_POST_BYTES = MAX_BUS_BATCH_BYTES;
interface Task { id: string; dependsOn?: string[]; envelope: BusEnvelope }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,128}(?![\s\S])/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every(key => allowed.includes(key));

export function graphReadyPost(text: string, apply = false, options: BusInboxOptions = {}) {
  const invalid = { version: 1, status: 'invalid', execution: 'not-started', complete: false } as const;
  if (Buffer.byteLength(text, 'utf8') > MAX_GRAPH_POST_BYTES) return invalid;
  let input: unknown;
  try { input = JSON.parse(text); } catch { return invalid; }
  if (!record(input) || !keys(input, ['batchId', 'completed', 'tasks']) || !token(input.batchId) ||
    !Array.isArray(input.completed) || input.completed.length > 256 || !input.completed.every(token) ||
    !Array.isArray(input.tasks) || input.tasks.length > 256) return invalid;
  const completed = input.completed;
  const tasks: Task[] = [], ids = new Set<string>(), messageIds = new Set<string>();
  for (const row of input.tasks) {
    if (!record(row) || !keys(row, ['id', 'dependsOn', 'envelope']) || !token(row.id) || ids.has(row.id) ||
      (row.dependsOn !== undefined && (!Array.isArray(row.dependsOn) || row.dependsOn.length > 256 ||
        !row.dependsOn.every(token)))) return invalid;
    const checked = validateBusEnvelope(row.envelope);
    if (!checked.ok || messageIds.has(checked.value.id)) return invalid;
    ids.add(row.id); messageIds.add(checked.value.id);
    tasks.push({ id: row.id, dependsOn: row.dependsOn as string[] | undefined, envelope: checked.value });
  }
  if (completed.some(id => !ids.has(id)) || new Set(completed).size !== completed.length) return invalid;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) {
      if (!ids.has(dep) || !acyclic(dep)) return false;
    }
    visiting.delete(id); visited.add(id);
    return true;
  };
  if (!tasks.every(task => acyclic(task.id))) return invalid;
  const ready = taskReadyFrontier(tasks, completed);
  if (ready.length > MAX_BUS_BATCH_MESSAGES) return invalid;
  const envelopes = ready.map(id => byId.get(id)!.envelope);
  const batch = JSON.stringify(envelopes);
  if (Buffer.byteLength(batch, 'utf8') > MAX_BUS_BATCH_BYTES) return invalid;
  const base = { version: 1, batchId: input.batchId, execution: 'not-started', ready,
    completed, blocked: tasks.filter(task => !ready.includes(task.id) &&
      !completed.includes(task.id)).map(task => task.id) };
  if (!apply || ready.length === 0) return { ...base, status: apply ? 'complete' : 'preview',
    complete: apply, accepted: [], failure: null, unattempted: [] };
  const receipt = postBusBatch(batch, options);
  const taskForMessage = new Map(tasks.map(task => [task.envelope.id, task.id]));
  return { ...base, ...receipt,
    accepted: receipt.accepted.map(row => ({ ...row, taskId: taskForMessage.get(row.id)! })),
    failure: receipt.failure && { ...receipt.failure,
      taskId: receipt.failure.index === null ? null : ready[receipt.failure.index] },
    unattempted: receipt.unattempted.map(id => ({ id, taskId: taskForMessage.get(id)! })) };
}
