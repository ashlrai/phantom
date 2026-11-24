import { createHash } from 'node:crypto';
import { scrubSecrets } from '../../util/scrub.js';

export interface EmbeddedNodeTask { text: string; sha256: string }
export const NODE_TASK_LIMIT = 16 * 1024;

export function validNodeTask(value: unknown): value is EmbeddedNodeTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as EmbeddedNodeTask;
  return Object.keys(task).sort().join() === 'sha256,text' && typeof task.text === 'string' &&
    !!task.text.trim() && Buffer.byteLength(task.text) <= NODE_TASK_LIMIT &&
    Buffer.from(task.text, 'utf8').toString('utf8') === task.text && scrubSecrets(task.text) === task.text &&
    typeof task.sha256 === 'string' && createHash('sha256').update(task.text).digest('hex') === task.sha256;
}

export function nodeTaskArgs(task: EmbeddedNodeTask | undefined): string[] {
  if (task === undefined) return [];
  if (!validNodeTask(task)) throw new Error('Invalid embedded node task');
  const args = ['--task-sha256', `sha256:${task.sha256}`];
  let part = '';
  for (const point of task.text) {
    if (part.length + point.length > 4000) {
      args.push(`--task-part=${part}`);
      part = '';
    }
    part += point;
  }
  if (part) args.push(`--task-part=${part}`);
  return args;
}
