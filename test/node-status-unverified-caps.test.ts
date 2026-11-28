/**
 * `phm node status`/`list` re-check advertised agent-CLI caps live.
 *
 * The join's `unverifiedCaps` reply is a one-shot field — nothing stores it —
 * so an advertised cap whose CLI binary is missing would read as ready forever.
 * Status re-runs the same file-presence check (allowlisted paths only, nothing
 * executed, no sign-in or credential read) and names the caps it cannot back
 * as `unverified-caps=<cap>` on the node's line, so "is my node ready" stays
 * honest weeks after the join and reflects a CLI installed or removed since.
 * Text only: the --json view stays the scope-filtered projection.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import type { ProviderBinaryDeps } from '../src/core/drive/nodes/provider-binary.js';
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

/** Binary presence answer per path suffix: only the named CLIs "exist". */
const binaries = (...names: string[]): ProviderBinaryDeps => ({
  home: '/nonexistent-home', execPath: '/nonexistent/node',
  executable: path => names.some(name => path.endsWith(`/${name}`)),
});
const none: ProviderBinaryDeps = { home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false };
/** A real version on every call keeps the self-update drift tag off the node lines. */
const version = () => '3.30.89';
/** The single node line out of a multi-line status render. */
const nodeLine = (text: string, id: string): string =>
  text.split('\n').find(l => l.startsWith(`node ${id} `)) ?? '';

describe('status/list unverified advertised caps', () => {
  it('names advertised agent-CLI caps with no binary on the node line', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // node-a advertises aider (no binary) and build; node-b advertises codex
      // (binary present) and a custom cap.
      expect(await cmdNodeFleet('join', ['--node', 'a', '--owner', 'acme', '--caps', 'aider,build', '--json'],
        { store, phmVersion: version, cliBinaryDeps: binaries() })).toBe(0);
      expect(await cmdNodeFleet('join', ['--node', 'b', '--owner', 'acme', '--caps', 'codex,custom-lane', '--json'],
        { store, phmVersion: version, cliBinaryDeps: binaries('codex') })).toBe(0);
      lines.length = 0;
      expect(await cmdNodeFleet('status', ['--owner', 'acme'],
        { store, phmVersion: version, cliBinaryDeps: binaries('codex') })).toBe(0);
      const text = lines.at(-1)!;
      expect(nodeLine(text, 'a')).toContain('caps=aider,build,phm-3.30.89 unverified-caps=aider');
      expect(nodeLine(text, 'b')).toContain('caps=codex,custom-lane,phm-3.30.89');
      expect(nodeLine(text, 'b')).not.toContain('unverified-caps');
    } finally { vi.restoreAllMocks(); }
  });

  it('re-checks live: a cap installed after join stops flagging, one removed starts', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // Join while the gemini binary is present: the join reply is clean.
      expect(await cmdNodeFleet('join', ['--node', 'g', '--owner', 'acme', '--caps', 'gemini', '--json'],
        { store, phmVersion: version, cliBinaryDeps: binaries('gemini') })).toBe(0);
      expect(JSON.parse(lines.at(-1)!)['unverifiedCaps']).toBeUndefined();
      lines.length = 0;
      // Status probes again: the binary is now gone, so the same cap flags.
      expect(await cmdNodeFleet('status', ['--owner', 'acme'],
        { store, phmVersion: version, cliBinaryDeps: none })).toBe(0);
      expect(nodeLine(lines.at(-1)!, 'g')).toContain('caps=gemini,phm-3.30.89 unverified-caps=gemini');
      lines.length = 0;
      // And back: binary restored, the flag clears — proof it is not stored state.
      expect(await cmdNodeFleet('list', ['--owner', 'acme'],
        { store, phmVersion: version, cliBinaryDeps: binaries('gemini') })).toBe(0);
      expect(nodeLine(lines.at(-1)!, 'g')).toContain('caps=gemini,phm-3.30.89');
      expect(nodeLine(lines.at(-1)!, 'g')).not.toContain('unverified-caps');
    } finally { vi.restoreAllMocks(); }
  });

  it('never flags caps that name no agent CLI, even with every binary absent', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      expect(await cmdNodeFleet('join', ['--node', 'w', '--owner', 'acme', '--caps', 'build,gh,pack:codex-file,custom-lane', '--json'],
        { store, phmVersion: version, cliBinaryDeps: none, probeAuth: () => 'ok' })).toBe(0);
      lines.length = 0;
      expect(await cmdNodeFleet('status', ['--owner', 'acme'],
        { store, phmVersion: version, cliBinaryDeps: none, probeAuth: () => 'ok' })).toBe(0);
      const line = nodeLine(lines.at(-1)!, 'w');
      expect(line).toContain('caps=');
      expect(line).not.toContain('unverified-caps');
    } finally { vi.restoreAllMocks(); }
  });

  it('leaves the --json view as the pure scope-filtered projection', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      expect(await cmdNodeFleet('join', ['--node', 'a', '--owner', 'acme', '--caps', 'aider', '--json'],
        { store, phmVersion: version, cliBinaryDeps: none })).toBe(0);
      lines.length = 0;
      expect(await cmdNodeFleet('status', ['--owner', 'acme', '--json'],
        { store, phmVersion: version, cliBinaryDeps: none })).toBe(0);
      const parsed = JSON.parse(lines.at(-1)!);
      expect(parsed.nodes[0].caps).toContain('aider');
      expect(JSON.stringify(parsed)).not.toContain('unverified');
    } finally { vi.restoreAllMocks(); }
  });
});
