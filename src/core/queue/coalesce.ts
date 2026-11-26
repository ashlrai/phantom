import { createHash } from 'node:crypto';

/**
 * Coalesce small READY lines into per-repo batch jobs.
 *
 * Each READY line costs one launch slot, so a burst of one-test-case jobs for
 * the same repo wastes slots that a single batch session could use. This pure
 * function plans those batches; it never reads or writes files.
 *
 * Grouping is deliberately conservative: only lines with the same repo, pool
 * and tier join a batch (pool and tier decide who runs it, so mixing them would
 * silently reroute work), and only lines that declare `size<=` at or under
 * {@link SMALL_SIZE}. Everything else passes through byte-for-byte.
 */

export const MAX_BATCH = 8;
/** Largest declared `size<=` that still counts as a small task. */
const SMALL_SIZE = 200;

export type KeepReason = 'P0' | 'frontier' | 'fixup' | 'leader' | 'not small' | 'alone';
export interface CoalesceBatch {
  id: string; repo: string; pool: string; tier: string; priority: string;
  /** Ids of the READY lines this batch replaces, in queue order. */
  replaces: string[];
  line: string;
  prompt: string;
}
export interface CoalesceReport {
  schema: 'phantom.queue-coalesce.v1';
  batches: CoalesceBatch[];
  /** READY lines left unchanged, with the plain reason. */
  kept: Array<{ id: string; reason: KeepReason }>;
  /** Lines that look like READY lines but could not be read; kept as they are. */
  malformed: Array<{ line: number; text: string; reason: string }>;
}

interface Task {
  index: number; id: string; priority: string; pool: string; tier: string; repo: string;
  size: number | null; leader: boolean; goal: string; acceptance: string | null;
}

const READY = /^\s*-\s+READY\b/;
const ID = /^\s*-\s+READY\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=[\s(:]|$)/;
const LINE = /^\s*-\s+READY\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*\(([^)]*)\)\s*(?::\s*(\S.*?))?\s*$/;

function parse(text: string, index: number): Task | string {
  if (!ID.test(text)) return 'missing id';
  const match = LINE.exec(text);
  if (!match) return 'missing (fields)';
  if (!match[3]) return 'missing goal';
  const fields = match[2]!.split(',').map(field => field.trim());
  const value = (key: string) => fields.find(field => field.startsWith(`${key}=`))?.slice(key.length + 1).trim() || null;
  const priority = fields.find(field => /^P\d+$/.test(field)) ?? null;
  const pool = value('pool'), tier = value('tier'), repo = value('repo');
  if (!priority) return 'missing priority';
  if (!pool) return 'missing pool';
  if (!tier) return 'missing tier';
  if (!repo) return 'missing repo';
  const size = fields.map(field => /^size<=(\d+)$/.exec(field)?.[1]).find(Boolean);
  const [goal, ...rest] = match[3]!.split(/\bAcceptance\s*:\s*/i);
  return {
    index, id: match[1]!, priority, pool, tier, repo, size: size ? Number(size) : null,
    leader: value('src') === 'leader', goal: goal!.trim(), acceptance: rest.join('Acceptance: ').trim() || null,
  };
}

function keepReason(task: Task): KeepReason | null {
  if (task.priority === 'P0') return 'P0';
  if (task.tier === 'frontier') return 'frontier';
  if (/^(?:RQ-)?FIXUP/i.test(task.id)) return 'fixup';
  if (task.leader) return 'leader';
  if (task.size === null || task.size > SMALL_SIZE) return 'not small';
  return null;
}

/** Same members always give the same id, whatever their order. */
export function batchId(repo: string, ids: string[]): string {
  const hash = createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 8).toUpperCase();
  return `RQ-BATCH-${repo.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'REPO'}-${hash}`;
}

export const BATCH_RULES = [
  'Before each task, check whether the case is already covered. If it is, skip it and say so in a note.',
  'Ship whatever subset is finished; do not hold finished tasks back for unfinished ones.',
  'End with no changes only if every task is already covered.',
  'Run only the tests you touched.',
];

function buildBatch(tasks: Task[]): CoalesceBatch {
  const { repo, pool, tier } = tasks[0]!;
  const ids = tasks.map(task => task.id);
  const id = batchId(repo, ids);
  // The most urgent member sets the batch priority.
  const priority = `P${Math.min(...tasks.map(task => Number(task.priority.slice(1))))}`;
  const size = tasks.reduce((sum, task) => sum + task.size!, 0);
  const line = `- READY ${id} (${priority}, pool=${pool}, tier=${tier}, repo=${repo}, size<=${size}): ` +
    `Batch of ${tasks.length} small ${repo} tasks, replaces ${ids.join(', ')}. Checklist and rules: prompts/${id}.md`;
  const prompt = [
    `${id}: ${tasks.length} small tasks in ${repo}. Do them in one session and one change.`,
    '',
    ...tasks.flatMap((task, n) => [
      `${n + 1}. [ ] ${task.id}: ${task.goal}`,
      `   Acceptance: ${task.acceptance ?? 'not stated; use the task text.'}`,
    ]),
    '',
    'Rules:',
    ...BATCH_RULES.map(rule => `- ${rule}`),
    '',
  ].join('\n');
  return { id, repo, pool, tier, priority, replaces: ids, line, prompt };
}

/**
 * Plan batches for `text` (queue lines, any other lines allowed) and return the
 * rewritten queue: each batch line takes the place of its first member, the
 * other members are dropped, and every other line is unchanged.
 */
export function coalesceQueue(text: string): { report: CoalesceReport; output: string } {
  const lines = text.split(/(?<=\n)/);
  const report: CoalesceReport = { schema: 'phantom.queue-coalesce.v1', batches: [], kept: [], malformed: [] };
  const groups = new Map<string, Task[]>();
  const seen = new Set<string>();
  lines.forEach((raw, index) => {
    const body = raw.replace(/\r?\n$/, '');
    if (!READY.test(body)) return;
    const task = parse(body, index);
    if (typeof task === 'string') { report.malformed.push({ line: index + 1, text: body, reason: task }); return; }
    if (seen.has(task.id)) { report.malformed.push({ line: index + 1, text: body, reason: `repeated id ${task.id}` }); return; }
    seen.add(task.id);
    const reason = keepReason(task);
    if (reason) { report.kept.push({ id: task.id, reason }); return; }
    const key = JSON.stringify([task.repo.toLowerCase(), task.pool, task.tier]);
    groups.set(key, [...groups.get(key) ?? [], task]);
  });

  const replaced = new Map<number, string>();
  for (const tasks of groups.values()) {
    for (let start = 0; start < tasks.length; start += MAX_BATCH) {
      const chunk = tasks.slice(start, start + MAX_BATCH);
      // A batch of one is just the original line; leave it alone.
      if (chunk.length < 2) { report.kept.push({ id: chunk[0]!.id, reason: 'alone' }); continue; }
      const batch = buildBatch(chunk);
      report.batches.push(batch);
      const eol = /\r?\n$/.exec(lines[chunk[0]!.index]!)?.[0] ?? '\n';
      chunk.forEach((task, n) => replaced.set(task.index, n === 0 ? batch.line + eol : ''));
    }
  }
  const output = lines.map((line, index) => replaced.get(index) ?? line).join('');
  return { report, output };
}
