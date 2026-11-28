/**
 * Missing --node refusals on the session verbs name what the store already knows.
 *
 * `phm node beat|pull|leave|renew|complete|release` all require --node, an id
 * only `phm node join` prints. On a machine that never joined, the bare
 * "Add --node <value>" fix dead-ended the first session command a new
 * contributor tries. On the standalone path the refusal now reads the store
 * once — naming the join that creates the first node, or the ids the store
 * already knows — while the pool endpoint and an unreadable store keep the
 * generic fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet, parseNodeFleetFlags, runNodeFleet, UsageError } from '../src/core/drive/nodes/commands.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { cmdNodeFleet } from '../src/cli/node-fleet.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

const SESSION_VERBS = ['beat', 'pull', 'leave', 'renew', 'complete', 'release'];

function failure(fn: () => unknown): UsageError {
  try { fn(); } catch (e) { return e as UsageError; }
  throw new Error('expected the verb to refuse');
}

const standalone = (verb: string, args: string[], nodes: DriveNodes): Record<string, unknown> =>
  runNodeFleet(verb, parseNodeFleetFlags(verb, args), nodes, () => 'unknown', { rejoinWatch: true });

describe('missing --node on session verbs names the join or the known ids', () => {
  it('an empty store points every session verb at join', () => {
    const nodes = new DriveNodes(new MemoryStore());
    for (const verb of SESSION_VERBS) {
      const err = failure(() => standalone(verb, [], nodes));
      expect(err, verb).toMatchObject({ code: 'missing-flag', message: '--node is required.', exit: 2 });
      expect(err.fix, verb).toContain('No node has joined this store yet');
      expect(err.fix, verb).toContain('phm node join --owner <scope>');
    }
  });

  it('the pool endpoint keeps the bare flag error on every session verb', () => {
    const nodes = new DriveNodes(new MemoryStore());
    for (const verb of SESSION_VERBS) {
      const err = failure(() => executeNodeFleet(verb, [], nodes));
      expect(err, verb).toMatchObject({ code: 'missing-flag', message: '--node is required.' });
      expect(err.fix, verb).toBe('Add --node <value>. Run: phm node --help');
    }
  });

  it('a populated store names the node ids it knows, sorted', () => {
    const nodes = new DriveNodes(new MemoryStore());
    executeNodeFleet('join', ['--node', 'zeta', '--owner', 'ops'], nodes);
    executeNodeFleet('join', ['--node', 'alpha', '--owner', 'ops'], nodes);
    for (const verb of SESSION_VERBS) {
      const err = failure(() => standalone(verb, [], nodes));
      expect(err, verb).toMatchObject({ code: 'missing-flag' });
      expect(err.fix, verb).toContain('this store knows nodes: alpha, zeta');
      expect(err.fix, verb).not.toContain('No node has joined');
    }
  });

  it('an expired node id is still named — it rejoins under the same id', () => {
    let t = 1_000_000;
    const nodes = new DriveNodes(new MemoryStore(), { now: () => t });
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    t += 120_000; // past the 30 s node ttl; the record stays until leave
    const err = failure(() => standalone('beat', [], nodes));
    expect(err.fix).toContain('this store knows nodes: box');
  });

  it('an unreadable store degrades to the generic fix, never claimed ids', () => {
    const nodes = new DriveNodes({ transaction: () => { throw new Error('store down'); } });
    const err = failure(() => standalone('pull', [], nodes));
    expect(err).toMatchObject({ code: 'missing-flag' });
    expect(err.fix).toBe('Add --node <value>. Run: phm node --help');
  });

  it('a present --node still validates as an id and --session keeps its own fix', () => {
    const nodes = new DriveNodes(new MemoryStore());
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    const bad = failure(() => standalone('beat', ['--node', 'bad id'], nodes));
    expect(bad).toMatchObject({ code: 'bad-node' });
    const noSession = failure(() => standalone('beat', ['--node', 'box'], nodes));
    expect(noSession).toMatchObject({ code: 'missing-flag', message: '--session is required.' });
    expect(noSession.fix).toBe('Add --session <value>. Run: phm node --help');
  });

  it('keeps the --json error envelope and text Fix line through cmdNodeFleet', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errs.push(String(line)); });
    try {
      const store = new MemoryStore();
      expect(await cmdNodeFleet('pull', ['--json'], { store })).toBe(2);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ schemaVersion: 1, command: 'pull',
        error: { code: 'missing-flag', message: '--node is required.',
          fix: expect.stringContaining('phm node join --owner <scope>') } });
      lines.length = 0;
      expect(await cmdNodeFleet('pull', [], { store })).toBe(2);
      expect(errs.at(-1)).toContain('--node is required');
      expect(errs.at(-1)).toContain('Fix:');
      expect(errs.at(-1)).toContain('No node has joined this store yet');
    } finally { vi.restoreAllMocks(); }
  });
});
