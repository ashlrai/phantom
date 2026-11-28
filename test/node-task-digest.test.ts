/**
 * `phm node task-digest` prints the `--task-sha256` value for embedded task
 * text so `phm node enqueue --pack codex-file` never needs a platform sha256
 * tool — the same flag-value role `phm node measure` plays for --capacity.
 * The digest comes from task.ts's nodeTaskDigest under the exact embedded-task
 * rules enqueue enforces, so a printed digest is always one enqueue accepts
 * (proved against executeNodeFleet below). docs/add-a-computer.md and
 * docs/NODE-ROUTER.md show the command-substitution form.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { NODE_TASK_LIMIT, NODE_TASK_PART_LIMIT, nodeTaskDigest } from '../src/core/drive/nodes/task.js';
import { cmdNodeTaskDigest } from '../src/cli/node-task-digest.js';
import { cmdNode } from '../src/cli/node.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  return lines;
}
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);
afterEach(() => vi.restoreAllMocks());

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('nodeTaskDigest', () => {
  it('returns the sha256:<hex> flag value for valid task text', () => {
    expect(nodeTaskDigest('do the thing')).toBe(`sha256:${sha('do the thing')}`);
  });

  it('returns null for text enqueue would refuse', () => {
    expect(nodeTaskDigest('')).toBeNull();
    expect(nodeTaskDigest('   ')).toBeNull();
    expect(nodeTaskDigest('x'.repeat(NODE_TASK_LIMIT + 1))).toBeNull();
    expect(nodeTaskDigest('deploy with AKIAIOSFODNN7EXAMPLE key')).toBeNull();
  });
});

describe('phm node task-digest', () => {
  it('prints the bare sha256:<hex> value by default so --task-sha256 "$(phm node task-digest ...)" pastes it', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', 'do the thing'])).toBe(0);
    expect(lines).toEqual([`sha256:${sha('do the thing')}`]);
  });

  it('wraps the digest in the standard envelope under --json', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', 'do the thing', '--json'])).toBe(0);
    expect(lastJson(lines)).toEqual({ schemaVersion: 1, command: 'task-digest',
      taskSha256: `sha256:${sha('do the thing')}` });
  });

  it('joins repeated --task-part values in order, matching enqueue', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', 'first ', '--task-part', 'second', '--task-part=third'])).toBe(0);
    expect(lines).toEqual([`sha256:${sha('first secondthird')}`]);
  });

  it('accepts task text that begins with -- via the inline = form', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part=-- leading dash'])).toBe(0);
    expect(lines).toEqual([`sha256:${sha('-- leading dash')}`]);
  });

  it('refuses a separate-arg value that starts with -- as ambiguous, without eating --json', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'usage' } });
  });

  it('requires --task-part and refuses unknown arguments as usage', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'missing-flag' } });
    expect(await cmdNodeTaskDigest(['--task-part', 'x', '--bogus', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'usage' } });
  });

  it('enforces the same part and total limits enqueue applies', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', 'x'.repeat(NODE_TASK_PART_LIMIT + 1), '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'bad-task' } });
    // Five parts of exactly the per-part ceiling join past the 16 KiB total.
    const parts = Array.from({ length: 5 }, () => 'x'.repeat(NODE_TASK_PART_LIMIT));
    expect(await cmdNodeTaskDigest([...parts.flatMap(part => ['--task-part', part]), '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'bad-task' } });
  });

  it('refuses task text enqueue would refuse, before printing a digest', async () => {
    const lines = capture();
    expect(await cmdNodeTaskDigest(['--task-part', '   ', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'bad-task' } });
    expect(await cmdNodeTaskDigest(['--task-part', 'key AKIAIOSFODNN7EXAMPLE', '--json'])).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'task-digest', error: { code: 'bad-task' } });
  });

  it('prints a digest enqueue accepts for the same --task-part values', async () => {
    const lines = capture();
    const taskText = 'Summarize the README in one line.';
    expect(await cmdNodeTaskDigest(['--task-part', taskText, '--task-part', ' Tail.'])).toBe(0);
    const digest = lines.at(-1)!;
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    expect(executeNodeFleet('enqueue', ['--job', 'task-job', '--owner', 'o', '--pack', 'codex-file',
      '--task-part', taskText, '--task-part', ' Tail.', '--task-sha256', digest], nodes))
      .toEqual({ jobId: 'task-job', enqueued: true });
  });

  it('is reachable through the node dispatcher, scoped help and the full command list', async () => {
    const lines = capture();
    expect(await cmdNode(['task-digest', '--help'])).toBe(0);
    expect(lines.join('\n')).toContain('phm node task-digest');
    lines.length = 0;
    expect(await cmdNode(['--help'])).toBe(0);
    expect(lines.join('\n')).toContain('phm node task-digest --task-part <text>');
  });
});
