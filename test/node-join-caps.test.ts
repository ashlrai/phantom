/**
 * `phm node join --caps` honesty: an explicit --caps that names no capability
 * (`--caps ""`, `--caps ","`, a script's `--caps "$EMPTY"`) is refused on the
 * standalone CLI path instead of silently joining a node that advertises zero
 * work caps where a bare join would have auto-detected this machine's
 * sign-ins. The pool wire still accepts an empty --caps: a lane-less worker
 * legitimately joins with none.
 */
import { describe, expect, it, vi } from 'vitest';
import { DriveNodes, type NodesState, type NodesStore } from '../src/core/drive/nodes/index.js';
import { executeNodeFleet } from '../src/core/drive/nodes/commands.js';
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

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(String(line)); });
  return lines;
}

describe('standalone join --caps that names nothing', () => {
  it('refuses an empty --caps with a bad-caps usage error instead of silently advertising none', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // `--caps "$EMPTY"` from a script is a mistake, not a deliberate empty
      // advertisement: joining anyway would leave a node that can never take
      // a lane job where a bare join would have auto-detected sign-ins.
      for (const empty of ['', ',', ' , ']) {
        const deps = { store, phmVersion: () => '9.9.9',
          providerLanes: () => { throw new Error('the sign-in probe must not run'); } };
        expect(await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--caps', empty, '--json'], deps)).toBe(2);
        const out = JSON.parse(lines.at(-1)!);
        expect(out).toMatchObject({ command: 'join', error: { code: 'bad-caps' } });
        expect(out.error.message).toContain('--caps needs at least one capability');
        expect(out.error.fix).toContain('Omit --caps');
      }
      expect(store.state.nodes).toEqual([]);
      // Text mode names the flag and the fix on stderr.
      expect(await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--caps', ''], { store })).toBe(2);
      expect(lines.at(-1)!).toContain('--caps needs at least one capability');
    } finally { vi.restoreAllMocks(); }
  });

  it('the pool wire still accepts an empty --caps: a lane-less worker legitimately joins with none', () => {
    const store = new MemoryStore();
    const nodes = new DriveNodes(store, { now: () => 1_000, nodeTtlMs: 100, leaderTtlMs: 20, claimTtlMs: 40 });
    const joined = executeNodeFleet('join', ['--node', 'worker', '--owner', 'o', '--caps', ''], nodes);
    expect(joined['nodeId']).toBe('worker');
    expect(joined['caps']).toEqual([]);
  });
});
