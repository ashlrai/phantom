#!/usr/bin/env -S npx tsx
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuplicateTaskIdError, taskReadyFrontier } from '../../src/core/fleet/task-ready-frontier.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';

const MAX_BYTES = 1024 * 1024;
const usage = 'Usage: npx tsx examples/agents/task-frontier.ts --file snapshot.json\nExample snapshot.json: {"tasks":[{"id":"fake-a"},{"id":"fake-b","dependsOn":["fake-a"]}],"completed":["fake-a"]}';
type Task = { id: string; dependsOn?: string[] };
type Dependencies = { read?: typeof readStableRegularFile; write?: (text: string) => void };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function snapshot(value: unknown): { tasks: Task[]; completed: string[] } | null {
  if (!record(value) || Object.keys(value).some(key => key !== 'tasks' && key !== 'completed') ||
      !Array.isArray(value.tasks) || !Array.isArray(value.completed) || !value.completed.every(id)) return null;
  const tasks: Task[] = [];
  for (const task of value.tasks) {
    if (!record(task) || Object.keys(task).some(key => key !== 'id' && key !== 'dependsOn') || !id(task.id) ||
        (Object.hasOwn(task, 'dependsOn') && (!Array.isArray(task.dependsOn) || !task.dependsOn.every(id)))) return null;
    tasks.push(Object.hasOwn(task, 'dependsOn') ? { id: task.id, dependsOn: task.dependsOn as string[] } : { id: task.id });
  }
  return { tasks, completed: value.completed as string[] };
}

/** Read one explicit snapshot and emit a read-only frontier query result. */
export function runTaskFrontier(args: readonly string[], deps: Dependencies = {}): number {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: object, code: number) => { write(`${JSON.stringify(value)}\n`); return code; };
  const fail = (code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status: 'error', error: { code, message } }, exit);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return emit({ schemaVersion: 1, usage }, 0);
  const file = args[1];
  if (args.length !== 2 || args[0] !== '--file' || !file?.trim() || file.startsWith('-') || file.includes('\0')) {
    return fail('USAGE', usage, 2);
  }
  let value: unknown;
  try {
    const absolute = resolve(file);
    const read = (deps.read ?? readStableRegularFile)(absolute, {
      anchorPath: dirname(absolute), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES,
    });
    if (!read.ok) {
      const invalid = ['unsafe-file', 'unsafe-path', 'per-file-byte-limit', 'byte-limit'].includes(read.reason);
      return fail(invalid ? 'INVALID_FILE' : 'READ_FAILED', 'Snapshot could not be read safely.', invalid ? 2 : 1);
    }
    if (Buffer.byteLength(read.text, 'utf8') > MAX_BYTES) return fail('INVALID_FILE', 'Snapshot is too large.', 2);
    try { value = JSON.parse(read.text) as unknown; }
    catch { return fail('INVALID_JSON', 'Snapshot must be valid JSON.', 2); }
  } catch {
    return fail('READ_FAILED', 'Snapshot could not be read safely.', 1);
  }
  const input = snapshot(value);
  if (!input) return fail('INVALID_SNAPSHOT', 'Expected tasks and completed arrays with nonblank string IDs.', 2);
  try {
    const readyIds = taskReadyFrontier(input.tasks, input.completed);
    const ready = new Set(readyIds);
    const completed = new Set(input.completed);
    const taskIds = new Set(input.tasks.map(task => task.id));
    const blockedIds = input.tasks.filter(task => !completed.has(task.id) && !ready.has(task.id)).map(task => task.id);
    const unknownCompletedIds = [...completed].filter(taskId => !taskIds.has(taskId));
    const unresolvedDependencyIds = [...new Set(input.tasks.flatMap(task => task.dependsOn ?? []))]
      .filter(taskId => !taskIds.has(taskId) && !completed.has(taskId));
    return emit({ schemaVersion: 1, status: 'ready', readyIds, blockedIds, unknownCompletedIds, unresolvedDependencyIds }, 0);
  } catch (error) {
    if (error instanceof DuplicateTaskIdError) return fail('DUPLICATE_TASK_ID', 'Duplicate task IDs make the snapshot ambiguous.', 1);
    return fail('QUERY_FAILED', 'Could not calculate the task frontier.', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runTaskFrontier(process.argv.slice(2));
}
