/**
 * Missing --owner refusals name what the store already knows.
 *
 * `phm node status` (and the other scoped verbs) require --owner; on a machine
 * that never joined, the bare "Add --owner <value>" fix dead-ended the first
 * command a new contributor runs. The refusal now reads the store once and
 * names the scopes present — or the join that creates the first — while an
 * unreadable store degrades to the generic fix rather than claiming scopes.
 */
import { describe, expect, it, vi } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet, UsageError } from '../src/core/drive/nodes/commands.js';
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

function failure(fn: () => unknown): UsageError {
  try { fn(); } catch (e) { return e as UsageError; }
  throw new Error('expected the verb to refuse');
}

describe('missing --owner names the store scopes or the join', () => {
  it('an empty store points status/list at join and explains the scope on join', () => {
    const nodes = new DriveNodes(new MemoryStore());
    for (const verb of ['status', 'list']) {
      const err = failure(() => executeNodeFleet(verb, [], nodes));
      expect(err).toMatchObject({ code: 'missing-flag', message: '--owner is required.', exit: 2 });
      expect(err.fix).toContain('No owner scope exists in this store yet');
      expect(err.fix).toContain('phm node join --owner <scope>');
    }
    const join = failure(() => executeNodeFleet('join', ['--node', 'x'], nodes));
    expect(join).toMatchObject({ code: 'missing-flag' });
    expect(join.fix).toContain('--owner <scope>');
    expect(join.fix).toContain('label your jobs carry');
    expect(join.fix).not.toContain('store knows');
  });

  it('a populated store names every known scope, sorted and deduped', () => {
    const nodes = new DriveNodes(new MemoryStore());
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops,acme'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'personal'], nodes);
    executeNodeFleet('join', ['--node', 'laptop', '--owner', 'acme'], nodes);
    for (const verb of ['status', 'list', 'enqueue', 'withdraw', 'result']) {
      const args = verb === 'status' || verb === 'list' ? [] : ['--job', 'j1'];
      const err = failure(() => executeNodeFleet(verb, args, nodes));
      expect(err, verb).toMatchObject({ code: 'missing-flag' });
      expect(err.fix, verb).toContain('this store knows: acme, ops, personal');
    }
    const join = failure(() => executeNodeFleet('join', ['--node', 'third'], nodes));
    expect(join.fix).toContain('this store knows: acme, ops, personal');
  });

  it('keeps each verb its own check order: enqueue still names --job first', () => {
    const nodes = new DriveNodes(new MemoryStore());
    executeNodeFleet('join', ['--node', 'box', '--owner', 'acme'], nodes);
    const bare = failure(() => executeNodeFleet('enqueue', [], nodes));
    expect(bare).toMatchObject({ code: 'missing-flag', message: '--job is required.' });
    const noOwner = failure(() => executeNodeFleet('enqueue', ['--job', 'j2'], nodes));
    expect(noOwner).toMatchObject({ code: 'missing-flag', message: '--owner is required.' });
    expect(noOwner.fix).toContain('acme');
  });

  it('an unreadable store degrades to the generic fix, never claimed scopes', () => {
    const nodes = new DriveNodes({ transaction: () => { throw new Error('store down'); } });
    const err = failure(() => executeNodeFleet('status', [], nodes));
    expect(err).toMatchObject({ code: 'missing-flag' });
    expect(err.fix).toBe('Add --owner <scope>. Run: phm node --help');
  });

  it('plan keeps --owner optional and --owner present still validates as before', () => {
    const nodes = new DriveNodes(new MemoryStore());
    executeNodeFleet('join', ['--node', 'box', '--owner', 'acme'], nodes);
    expect(executeNodeFleet('plan', [], nodes)).toEqual({ routes: [] });
    // A present-but-malformed --owner is still bad usage, not the missing-flag fix.
    const bad = failure(() => executeNodeFleet('status', ['--owner', 'bad id'], nodes));
    expect(bad).toMatchObject({ code: 'bad-owner', exit: 2 });
  });

  it('keeps the --json error envelope and text Fix line through cmdNodeFleet', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { errs.push(String(line)); });
    try {
      const store = new MemoryStore();
      expect(await cmdNodeFleet('status', ['--json'], { store })).toBe(2);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ schemaVersion: 1, command: 'status',
        error: { code: 'missing-flag', message: '--owner is required.',
          fix: expect.stringContaining('phm node join --owner <scope>') } });
      lines.length = 0;
      expect(await cmdNodeFleet('status', [], { store })).toBe(2);
      expect(errs.at(-1)).toContain('--owner is required');
      expect(errs.at(-1)).toContain('Fix:');
      expect(errs.at(-1)).toContain('phm node join --owner <scope>');
    } finally { vi.restoreAllMocks(); }
  });
});
