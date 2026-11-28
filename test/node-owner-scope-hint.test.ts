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

describe('an --owner the store does not know names the scopes it does', () => {
  async function statusText(store: MemoryStore, args: string[]): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdNodeFleet('status', args, { store })).toBe(0);
      return lines.at(-1)!;
    } finally { vi.restoreAllMocks(); }
  }

  it('status on an unknown scope names known scopes and still offers join', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'personal'], nodes);
    const out = await statusText(store, ['--owner', 'acme']);
    expect(out).toContain('This store knows: ops, personal');
    expect(out).toContain('phm node join --owner acme');
    expect(out).toContain('No nodes joined in this scope.');
  });

  it('list annotates the same way, and a known scope prints no scope hint', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdNodeFleet('list', ['--owner', 'typo'], { store })).toBe(0);
      expect(lines.at(-1)).toContain('This store knows: ops');
      lines.length = 0;
      expect(await cmdNodeFleet('status', ['--owner', 'ops'], { store })).toBe(0);
      expect(lines.at(-1)).toContain('node box');
      expect(lines.at(-1)).not.toContain('This store knows');
    } finally { vi.restoreAllMocks(); }
  });

  it('an empty store and a multi-scope request keep the plain join line / hint once', async () => {
    const empty = new MemoryStore();
    const bare = await statusText(empty, ['--owner', 'acme']);
    expect(bare).toContain('Join this computer: phm node join --owner acme');
    expect(bare).not.toContain('This store knows');
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    const multi = await statusText(store, ['--owner', 'acme,personal']);
    expect(multi).toContain('This store knows: ops —');
    expect(multi).toContain('phm node join --owner acme,personal');
  });

  it('the --json view stays the pure scope-filtered projection', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'personal'], nodes);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdNodeFleet('status', ['--owner', 'acme', '--json'], { store })).toBe(0);
      const parsed = JSON.parse(lines.at(-1)!);
      expect(Object.keys(parsed).sort()).toEqual(['command', 'jobs', 'nodes', 'owners', 'routes', 'schemaVersion']);
      expect(parsed.nodes).toEqual([]);
      expect(parsed.jobs).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });
});

describe('plan on an empty queue names the scopes the store knows', () => {
  async function planText(store: MemoryStore, args: string[]): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdNodeFleet('plan', args, { store })).toBe(0);
      return lines.at(-1)!;
    } finally { vi.restoreAllMocks(); }
  }

  it('a mistyped --owner is named alongside the scopes the store knows', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'personal'], nodes);
    // j1 sits completed-free but pending under 'personal': plan --owner typo
    // has no jobs, so the note must not invite an enqueue under 'typo' alone.
    const out = await planText(store, ['--owner', 'typo']);
    expect(out).toContain("No jobs queued in owner 'typo'.");
    expect(out).toContain('This store knows: ops, personal.');
    expect(out).toContain('phm node enqueue --job <id> --owner typo');
  });

  it('a scope with a node but no jobs keeps the plain enqueue line', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'personal'], nodes);
    // 'ops' is a real scope (it owns a node); an empty queue under it is not a
    // mistyped scope, so no "store knows" correction is printed.
    const out = await planText(store, ['--owner', 'ops']);
    expect(out).toBe("No jobs queued in owner 'ops'. Enqueue one: phm node enqueue --job <id> --owner ops");
  });

  it('a bare plan names the one known scope as a runnable enqueue target', async () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    const out = await planText(store, []);
    expect(out).toBe('No jobs queued in any owner scope. This store knows: ops. Enqueue one: phm node enqueue --job <id> --owner ops');
  });

  it('an empty store and the --json view stay unchanged', async () => {
    const store = new MemoryStore();
    const bare = await planText(store, ['--owner', 'acme']);
    expect(bare).toBe("No jobs queued in owner 'acme'. Enqueue one: phm node enqueue --job <id> --owner acme");
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const populated = new MemoryStore();
      const nodes = new DriveNodes(populated);
      executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
      expect(await cmdNodeFleet('plan', ['--owner', 'typo', '--json'], { store: populated })).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).toEqual({ schemaVersion: 1, command: 'plan', routes: [] });
    } finally { vi.restoreAllMocks(); }
  });
});

describe('unrouted-job join fixes carry --watch on the standalone path', () => {
  // One live node under 'ops' and two unrouted jobs: j1 has no node in its
  // owner scope at all (the join fix), j2 has a node that lacks its cap (the
  // caps fix, which names no join command).
  function seed(): { store: MemoryStore; nodes: DriveNodes } {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store);
    executeNodeFleet('join', ['--node', 'box', '--owner', 'ops'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j1', '--owner', 'acme'], nodes);
    executeNodeFleet('enqueue', ['--job', 'j2', '--owner', 'ops', '--requires', 'build'], nodes);
    return { store, nodes };
  }
  const fixOf = (out: Record<string, unknown>, jobId: string): string | undefined =>
    (out['routes'] as { jobId: string; fix?: string }[]).find(r => r.jobId === jobId)?.fix;

  it('the pool endpoint keeps the bare join hint; the standalone path adds --watch', () => {
    const { nodes } = seed();
    // executeNodeFleet is the SSH/pool endpoint: rejoinWatch stays unset, so
    // the fix keeps the bare join — pool joins release their probe session and
    // `join --watch` is refused there.
    const pooled = executeNodeFleet('plan', ['--owner', 'acme'], nodes);
    expect(fixOf(pooled, 'j1')).toBe("No live node belongs to owner 'acme'. Run: phm node join --owner acme");

    // runNodeFleet with rejoinWatch is the standalone CLI path: the same fix
    // ends in --watch so the pasted join also holds the session live.
    const local = runNodeFleet('plan', parseNodeFleetFlags('plan', ['--owner', 'acme']), nodes, () => 'unknown', { rejoinWatch: true });
    expect(fixOf(local, 'j1')).toBe("No live node belongs to owner 'acme'. Run: phm node join --owner acme --watch");
  });

  it('status and list carry the same hint; a fix naming no join is untouched', () => {
    const { nodes } = seed();
    for (const verb of ['status', 'list'] as const) {
      const out = runNodeFleet(verb, parseNodeFleetFlags(verb, ['--owner', 'acme,ops']), nodes, () => 'unknown', { rejoinWatch: true });
      expect(fixOf(out, 'j1'), verb).toContain('phm node join --owner acme --watch');
      // The caps fix names no join command, so it is never rewritten.
      expect(fixOf(out, 'j2'), verb).toBe("No node owned by 'ops' advertises build. Rejoin a node with --caps including them.");
    }
  });

  it('status text shows the watch hint on the pending job line end to end', async () => {
    const { store } = seed();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      expect(await cmdNodeFleet('status', ['--owner', 'acme'], { store })).toBe(0);
      expect(lines.at(-1)).toContain("job j1 pending — No live node belongs to owner 'acme'. Run: phm node join --owner acme --watch");
    } finally { vi.restoreAllMocks(); }
  });
});
