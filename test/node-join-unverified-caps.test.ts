/**
 * `phm node join --caps` unverified-CLI honesty: an explicit --caps is the
 * operator's manual advertisement — the sign-in probe a bare join pays
 * already required each lane's binary, so only a hand-written cap list can
 * name an agent CLI this machine does not have. The join now checks file
 * presence at the allowlisted install locations for every advertised cap
 * that names a known agent CLI (codex, claude and the community harnesses)
 * and names the ones it cannot find under `unverifiedCaps` — jobs requiring
 * them would route here and cannot run. Presence only: a miss warns, it
 * never refuses the join, and a hit still says nothing about sign-in.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import { unverifiedCliCaps } from '../src/core/drive/nodes/provider-binary.js';
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

describe('unverifiedCliCaps', () => {
  it('names advertised caps whose agent CLI has no binary, sorted and deduped', () => {
    // Presence answers per allowlisted path: aider and cursor-agent exist,
    // codex and gemini do not. Non-CLI caps are never checked.
    const missing = unverifiedCliCaps(
      ['gemini', 'build', 'codex', 'aider', 'cursor', 'gh', 'pack:codex-file', 'phm-9.9.9', 'gemini'],
      { home: '/nonexistent-home', execPath: '/nonexistent/node',
        executable: path => path.endsWith('/aider') || path.endsWith('/cursor-agent') });
    expect(missing).toEqual(['codex', 'gemini']);
  });

  it('resolves community caps through their candidate bin names', () => {
    // The cursor cap's CLI binary is cursor-agent, not cursor: a hit on the
    // bin name verifies the cap.
    expect(unverifiedCliCaps(['cursor'], {
      home: '/nonexistent-home', execPath: '/nonexistent/node',
      executable: path => path.endsWith('/cursor-agent'),
    })).toEqual([]);
    expect(unverifiedCliCaps(['cursor'], {
      home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false,
    })).toEqual(['cursor']);
  });

  it('checks codex and claude through the provider allowlist', () => {
    expect(unverifiedCliCaps(['codex', 'claude'], {
      home: '/nonexistent-home', execPath: '/nonexistent/node',
      executable: path => path.endsWith('/codex'),
    })).toEqual(['claude']);
  });

  it('returns an empty list when every named CLI is present or no cap names one', () => {
    expect(unverifiedCliCaps(['codex', 'aider'], {
      home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => true,
    })).toEqual([]);
    expect(unverifiedCliCaps(['build', 'gh', 'omlx', 'local-model', 'custom-lane'], {
      home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false,
    })).toEqual([]);
  });
});

describe('standalone join unverified advertised caps', () => {
  it('names explicit --caps agent CLIs with no binary under unverifiedCaps without refusing the join', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // The false-advertisement case: --caps codex on a machine with no codex
      // binary. The join still succeeds — the warning names the cap, it does
      // not block it — and the recorded advertisement is unchanged.
      const code = await cmdNodeFleet('join',
        ['--node', 'laptop', '--owner', 'acme', '--caps', 'build,codex,gemini', '--json'],
        { store, phmVersion: () => '9.9.9',
          cliBinaryDeps: { home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false } });
      expect(code).toBe(0);
      const out = JSON.parse(lines.at(-1)!);
      expect(out).toMatchObject({ command: 'join', unverifiedCaps: ['codex', 'gemini'] });
      // The version cap merges in but is not a CLI claim, so it is never flagged.
      expect(out.caps).toEqual(['build', 'codex', 'gemini', 'phm-9.9.9']);
      expect(store.state.nodes.find(n => n.nodeId === 'laptop')!.caps).toEqual(['build', 'codex', 'gemini', 'phm-9.9.9']);
    } finally { vi.restoreAllMocks(); }
  });

  it('stays silent when every advertised CLI cap has a binary', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join',
        ['--node', 'laptop', '--owner', 'acme', '--caps', 'build,codex,aider', '--json'],
        { store, phmVersion: () => null,
          cliBinaryDeps: { home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => true } });
      expect(code).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('unverifiedCaps');
    } finally { vi.restoreAllMocks(); }
  });

  it('never checks caps that name no agent CLI', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // build, gh and custom names carry no CLI claim: even with every
      // binary "absent" the field stays out of the reply. gh keeps its own
      // auth verdict path instead.
      const code = await cmdNodeFleet('join',
        ['--node', 'laptop', '--owner', 'acme', '--caps', 'build,gh,custom-lane', '--json'],
        { store, phmVersion: () => null, probeAuth: () => 'ok',
          cliBinaryDeps: { home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false } });
      expect(code).toBe(0);
      const out = JSON.parse(lines.at(-1)!);
      expect(out).not.toHaveProperty('unverifiedCaps');
      expect(out.ghAuth).toBe('ok');
    } finally { vi.restoreAllMocks(); }
  });

  it('prints the warning in text mode', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join',
        ['--node', 'laptop', '--owner', 'acme', '--caps', 'codex'],
        { store, phmVersion: () => null,
          cliBinaryDeps: { home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false } });
      expect(code).toBe(0);
      const text = lines.at(-1)!;
      expect(text).toContain('Advertised caps with no agent CLI found on this machine: codex');
      expect(text).toContain('jobs that require them will route here and cannot run');
    } finally { vi.restoreAllMocks(); }
  });

  it('does not run the check on a bare join — sign-in lanes already required their binaries', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // providerLanes is the bare-join probe seam: its lanes are treated as
      // sign-in verified, so the CLI-presence check must not run at all —
      // the executable seam throws if it is consulted.
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--json'],
        { store, phmVersion: () => null, providerLanes: () => ['codex'],
          cliBinaryDeps: { executable: () => { throw new Error('the CLI check must not run on a bare join'); } } });
      expect(code).toBe(0);
      const out = JSON.parse(lines.at(-1)!);
      expect(out).toMatchObject({ autoCaps: ['codex'], caps: ['codex'] });
      expect(out).not.toHaveProperty('unverifiedCaps');
    } finally { vi.restoreAllMocks(); }
  });
});
