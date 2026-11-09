/** Work-order proposals are untrusted data; planning grants no execution or send authority. */
import { scrubSecrets } from '../util/scrub.js';

export type WorkOrderType = 'review' | 'analysis' | 'second-opinion' | 'implementation';
export interface WorkOrder {
  id: string;
  type: WorkOrderType;
  repo: string;
  task: string;
  acceptance: string;
  replyChannel: 'imessage' | 'slack' | 'bus';
}
export interface WorkOrderPlan {
  order: WorkOrder;
  destination: 'dot' | 'fleet';
  authority: 'proposal-only';
}

/** Accept only explicitly structured, bounded work; do not infer authority from a message. */
export function normalizeWorkOrder(input: unknown): WorkOrder | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'acceptance,id,replyChannel,repo,task,type') return null;
  const { id, type, repo, task, acceptance, replyChannel } = row;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) ||
      typeof type !== 'string' || !['review', 'analysis', 'second-opinion', 'implementation'].includes(type) ||
      typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.length > 200 || repo.split('/').some(part => part === '.' || part === '..') ||
      typeof task !== 'string' || typeof acceptance !== 'string' ||
      !task.trim() || !acceptance.trim() || task.length > 2000 || acceptance.length > 2000 ||
      scrubSecrets(task) !== task || scrubSecrets(acceptance) !== acceptance ||
      !['imessage', 'slack', 'bus'].includes(String(replyChannel))) return null;
  return { id, type: type as WorkOrderType, repo, task: task.trim(), acceptance: acceptance.trim(), replyChannel: replyChannel as WorkOrder['replyChannel'] };
}

/** The dot can reason about work; implementation requires a fleet executor. */
export function planWorkOrder(input: unknown): WorkOrderPlan | null {
  const order = normalizeWorkOrder(input);
  return order ? { order, destination: order.type === 'implementation' ? 'fleet' : 'dot', authority: 'proposal-only' } : null;
}
