#!/usr/bin/env -S npx tsx
/**
 * Usage: npx tsx examples/agents/task-wave-plan.ts --file snapshot.json
 * Snapshot: {"tasks":[{"id":"fake-a","dependsOn":[]}],"completed":[]}.
 * This is hypothetical planning only: waves are not actual completions,
 * worker capacity, or dispatch authorization. External blockers are direct
 * dependencies absent from both the supplied task list and completed IDs.
 * Results describe only the supplied snapshot, whose freshness is unknown.
 */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuplicateTaskIdError, taskReadyFrontier } from '../../src/core/fleet/task-ready-frontier.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';

const MAX_BYTES = 1024 * 1024;
const MAX_TASKS = 2000;
const USAGE = 'Usage: npx tsx examples/agents/task-wave-plan.ts --file snapshot.json';
type Task = { id: string; dependsOn?: string[] };
type Snapshot = { tasks: Task[]; completed: string[] };
export type TaskWavePlanDependencies = {
  read?: typeof readStableRegularFile;
  write?: (text: string) => void;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim().length > 0);
}
function snapshot(value: unknown): Snapshot | null {
  if (!record(value) || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS || !ids(value.completed)) return null;
  const tasks: Task[] = [];
  for (const task of value.tasks) {
    if (!record(task) || typeof task.id !== 'string' || !task.id.trim() ||
      (task.dependsOn !== undefined && !ids(task.dependsOn))) return null;
    tasks.push({ id: task.id, dependsOn: task.dependsOn as string[] | undefined });
  }
  return { tasks, completed: value.completed };
}

/** Read a bounded snapshot and emit a hypothetical plan without changing state. */
export function runTaskWavePlan(args: readonly string[], deps: TaskWavePlanDependencies = {}): number {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  const emit = (value: object, code: number): number => {
    write(`${JSON.stringify({ schema: 'task-wave-plan.v1', ...value })}\n`);
    return code;
  };
  const fail = (error: string, code = 2) => emit({ status: 'error', error }, code);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return emit({ usage: USAGE }, 0);
  const file = args[1];
  if (args.length !== 2 || args[0] !== '--file' || !file?.trim() || file.startsWith('-') || file.includes('\0')) {
    return fail('invalid-arguments');
  }
  let text: string;
  try {
    const path = resolve(file);
    const result = (deps.read ?? readStableRegularFile)(path, {
      anchorPath: dirname(path), maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES,
    });
    if (!result.ok) return fail('file-unavailable', 1);
    text = result.text;
  } catch { return fail('file-unavailable', 1); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return fail('file-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return fail('invalid-json'); }
  const input = snapshot(parsed);
  if (!input) return fail('invalid-snapshot');

  const completed = [...input.completed];
  const done = new Set(completed);
  const waves: string[][] = [];
  try {
    while (true) {
      const wave = taskReadyFrontier(input.tasks, completed);
      if (wave.length === 0) break;
      waves.push(wave);
      for (const id of wave) { completed.push(id); done.add(id); }
    }
  } catch (error) {
    if (error instanceof DuplicateTaskIdError) return fail('duplicate-task-id');
    throw error;
  }
  const taskIds = new Set(input.tasks.map(task => task.id));
  const unresolved = input.tasks.filter(task => !done.has(task.id)).map(task => ({
    id: task.id,
    missingExternalDependencies: [...new Set((task.dependsOn ?? []).filter(id => !taskIds.has(id) && !done.has(id)))],
  }));
  return emit({
    status: 'ok',
    notice: 'HYPOTHETICAL PLANNING ONLY: waves are not actual completions, worker capacity, or dispatch authorization.',
    waves,
    maximumPotentialParallelism: waves.reduce((maximum, wave) => Math.max(maximum, wave.length), 0),
    unresolved,
  }, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runTaskWavePlan(process.argv.slice(2));
}
