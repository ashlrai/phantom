/**
 * `phm node join` installed-CLI candidates: a bare join's sign-in probe covers
 * only codex, claude and gh, so a community member whose agent CLIs are aider,
 * gemini or the other measured harnesses used to join with no lanes and no
 * hint that --caps takes those names. The join now also probes which community
 * agent CLI binaries are installed — file presence at allowlisted paths only,
 * never an execution, a sign-in check or a credential read — and names them in
 * the reply as --caps candidates. "Installed" is never advertised as a lane:
 * the caps list stays exactly what the sign-in probe (or an explicit --caps)
 * produced.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import { COMMUNITY_CLI_CANDIDATES, installedAgentClis } from '../src/core/drive/nodes/provider-binary.js';
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

describe('installedAgentClis', () => {
  it('names the cap of every candidate CLI whose binary is present', () => {
    // File presence only: the executable seam sees allowlisted paths and
    // answers for two of them — aider directly, cursor through its
    // cursor-agent binary name.
    const found = installedAgentClis({
      home: '/nonexistent-home', execPath: '/nonexistent/node',
      executable: path => path.endsWith('/aider') || path.endsWith('/cursor-agent'),
    });
    expect(found).toEqual(['aider', 'cursor']);
  });

  it('maps both ashlrcode install names to the one ashlrcode cap', () => {
    for (const bin of ['ac', 'ashlrcode']) {
      expect(installedAgentClis({
        home: '/nonexistent-home', execPath: '/nonexistent/node',
        executable: path => path.endsWith(`/${bin}`),
      })).toEqual(['ashlrcode']);
    }
  });

  it('covers every cloud-cli harness the capacity measurement knows except the sign-in-probed and opt-in lanes', () => {
    // With every candidate path "present" the probe returns the full list —
    // and the list must never grow codex/claude (the sign-in probe owns those
    // lanes) or local-model (local-lanes.json owns that opt-in).
    const found = installedAgentClis({ home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => true });
    expect(found).toEqual(COMMUNITY_CLI_CANDIDATES.map(c => c.cap));
    expect(found).not.toContain('codex');
    expect(found).not.toContain('claude');
    expect(found).not.toContain('local-model');
  });

  it('reports an empty list when no candidate binary is installed', () => {
    expect(installedAgentClis({ home: '/nonexistent-home', execPath: '/nonexistent/node', executable: () => false })).toEqual([]);
  });

  it('finds community CLIs at the install locations their own installers use', () => {
    // opencode's install script drops the binary in ~/.opencode/bin and a
    // `pnpm add -g` CLI lands in pnpm's global bin — outside the original
    // allowlist, where an installed CLI read as missing.
    const deps = { home: '/Users/air', execPath: '/nonexistent/node' };
    expect(installedAgentClis({ ...deps, executable: path => path === '/Users/air/.opencode/bin/opencode' }))
      .toEqual(['opencode']);
    expect(installedAgentClis({ ...deps, executable: path => path === '/Users/air/Library/pnpm/bin/gemini' }))
      .toEqual(['gemini']);
    expect(installedAgentClis({ ...deps, executable: path => path === '/Users/air/.local/share/pnpm/copilot' }))
      .toEqual(['copilot']);
    expect(installedAgentClis({ home: '/home/dev', execPath: '/nonexistent/node',
      executable: path => path === '/home/dev/.cargo/bin/goose' })).toEqual(['goose']);
  });
});

describe('standalone join installed-CLI candidates', () => {
  it('names installed community CLIs in the reply without advertising them as caps', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // The community-member case: no codex/claude/gh sign-ins, but aider and
      // gemini binaries installed. The reply names them as --caps candidates;
      // the advertised caps stay the version cap alone until the operator
      // passes --caps.
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--json'],
        { store, phmVersion: () => '9.9.9', providerLanes: () => [], installedClis: () => ['aider', 'gemini'] });
      expect(code).toBe(0);
      const out = JSON.parse(lines.at(-1)!);
      expect(out).toMatchObject({ command: 'join', autoCaps: [], installedClis: ['aider', 'gemini'], caps: ['phm-9.9.9'] });
      expect(store.state.nodes.find(n => n.nodeId === 'laptop')!.caps).toEqual(['phm-9.9.9']);
    } finally { vi.restoreAllMocks(); }
  });

  it('keeps the installed-CLI names alongside the sign-in lanes in text mode', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme'],
        { store, phmVersion: () => null, providerLanes: () => ['codex'], installedClis: () => ['aider'] });
      expect(code).toBe(0);
      const text = lines.at(-1)!;
      expect(text).toContain("Caps auto-detected from this machine's sign-ins: codex.");
      expect(text).toContain('Agent CLIs installed on this machine that --caps can advertise: aider.');
      // --caps replaces the whole advertisement, so the suggested command keeps
      // the sign-in lane the bare join already found.
      expect(text).toContain('--caps aider,codex');
    } finally { vi.restoreAllMocks(); }
  });

  it('does not claim sign-in lanes to keep when the sign-in probe found none', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // The first-run community case: no codex/claude/gh sign-ins, but aider
      // and gemini binaries installed. The suggested --caps is then just the
      // installed set — there are no sign-in lanes to keep, and the sentence
      // must not imply the join advertised some.
      const code = await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme'],
        { store, phmVersion: () => null, providerLanes: () => [], installedClis: () => ['aider', 'gemini'] });
      expect(code).toBe(0);
      const text = lines.at(-1)!;
      expect(text).toContain('No codex, claude or gh sign-ins detected');
      expect(text).toContain('Agent CLIs installed on this machine that --caps can advertise: aider, gemini.');
      expect(text).toContain('--caps aider,gemini');
      expect(text).not.toContain('keep the sign-in lanes');
    } finally { vi.restoreAllMocks(); }
  });

  it('stays silent about installed CLIs when the probe finds none or --caps was explicit', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      // An empty probe adds no field: absence already reads as "nothing to name".
      expect(await cmdNodeFleet('join', ['--node', 'laptop', '--owner', 'acme', '--json'],
        { store, phmVersion: () => null, providerLanes: () => [], installedClis: () => [] })).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('installedClis');
      // An explicit --caps is the complete manual advertisement: the installed
      // probe must not run at all.
      expect(await cmdNodeFleet('join', ['--node', 'desktop', '--owner', 'acme', '--caps', 'build', '--json'],
        { store, phmVersion: () => null,
          installedClis: () => { throw new Error('the installed-CLI probe must not run'); } })).toBe(0);
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('installedClis');
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty('autoCaps');
    } finally { vi.restoreAllMocks(); }
  });
});
