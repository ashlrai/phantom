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

/** Build the embedded task a whole-text source becomes — the `--task-file`
 * payload or stdin on the enqueue CLI. The digest is computed here so the
 * caller never runs sha256sum by hand, and the store's own validity rules are
 * applied before any argv exists. The thrown Error names the broken rule so
 * the CLI can quote it in a usage error. */
export function embeddedTaskFromText(text: string): EmbeddedNodeTask {
  const task: EmbeddedNodeTask = { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
  if (validNodeTask(task)) return task;
  const reason = !text.trim() ? 'the text is empty'
    : Buffer.byteLength(text, 'utf8') > NODE_TASK_LIMIT ? `the text exceeds ${NODE_TASK_LIMIT} bytes`
    : scrubSecrets(text) !== text ? 'the text contains a secret-shaped string'
    : 'the text is not valid UTF-8';
  throw new Error(`Invalid embedded node task: ${reason}.`);
}
