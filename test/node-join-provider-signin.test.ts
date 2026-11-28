/**
 * `phm node join` names provider CLIs that are installed but not signed in.
 *
 * The bare join's sign-in probe advertises only lanes whose CLI answered its
 * status command 0; every other provider was dropped silently, so a machine
 * with codex installed but never logged in read "no sign-ins detected" —
 * indistinguishable from having nothing installed. The probe now keeps each
 * provider's verdict (`probeProviderStates`), and the join reply reports the
 * installed-but-not-signed-in ones under `providerSignIn` with the verdict
 * (`signed-out` is the CLI's own refusal, `unknown` a check that could not
 * complete) plus, in text mode, the provider's login command and the re-join
 * that advertises the lane. Providers with no allowlisted binary stay
 * unlisted, 'ok' providers are the autoCaps themselves, and an explicit
 * --caps skips the probe entirely.
 */
import { describe, expect, it, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import type { ProviderProbe } from '../src/core/drive/nodes/worker.js';
import { probeProviderBinaries, probeProviderStates } from '../src/core/drive/nodes/worker.js';
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

const version = () => '9.9.9';
const codexOk: ProviderProbe = { provider: 'codex', binary: '/opt/homebrew/bin/codex', signIn: 'ok' };
const claudeFailed: ProviderProbe = { provider: 'claude', binary: '/opt/homebrew/bin/claude', signIn: 'failed' };
const codexAbsent: ProviderProbe = { provider: 'codex', binary: null, signIn: 'absent' };

describe('probeProviderStates', () => {
  const deps = { home: '/nonexistent-home', execPath: '/nonexistent/node' };

  it('keeps each provider verdict: ok and failed', () => {
    const run = vi.fn((command: string) => ({ status: command.endsWith('/codex') ? 0 : 1 })) as unknown as typeof spawnSync;
    const executable = (path: string) => path.endsWith('/codex') || path.endsWith('/claude');
    const states = probeProviderStates(run, { ...deps, executable });
    expect(states).toEqual([
      { provider: 'codex', binary: expect.stringContaining('/codex'), signIn: 'ok' },
      { provider: 'claude', binary: expect.stringContaining('/claude'), signIn: 'failed' },
    ]);
    // The status commands each provider's own CLI documents, on the resolved binary only.
    expect(vi.mocked(run).mock.calls.map(c => [String(c[0]).split('/').pop(), c[1]])).toEqual([
      ['codex', ['login', 'status']], ['claude', ['auth', 'status', '--json']]]);
  });

  it('reports absent without running the check, and unknown when the check cannot complete', () => {
    const run = vi.fn(() => ({ status: null })) as unknown as typeof spawnSync;
    // Only claude exists; its status check is killed (status null) — unknown, never a verdict.
    const executable = (path: string) => path.endsWith('/claude');
    const states = probeProviderStates(run, { ...deps, executable });
    expect(states).toEqual([
      { provider: 'codex', binary: null, signIn: 'absent' },
      { provider: 'claude', binary: expect.stringContaining('/claude'), signIn: 'unknown' },
    ]);
    expect(vi.mocked(run).mock.calls).toHaveLength(1);
    expect(String(vi.mocked(run).mock.calls[0]![0])).toContain('/claude');
  });

  it('probeProviderBinaries still advertises exactly the ok providers', () => {
    const run = vi.fn((command: string) => ({ status: command.endsWith('/codex') ? 0 : 1 })) as unknown as typeof spawnSync;
    const executable = () => true;
    expect(probeProviderBinaries(run, { ...deps, executable })).toEqual({ codex: expect.stringContaining('/codex') });
    const states = probeProviderStates(run, { ...deps, executable });
    expect(states.map(s => s.signIn)).toEqual(['ok', 'failed']);
  });
});

describe('join providerSignIn reply', () => {
  it('names an installed-but-signed-out provider with its login fix in JSON and text', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      const deps = {
        store, phmVersion: version, probeAuth: () => 'missing' as const,
        providerStates: () => [codexAbsent, claudeFailed], installedClis: () => [],
      };
      expect(await cmdNodeFleet('join', ['--node', 'm-json', '--owner', 'acme', '--json'], deps)).toBe(0);
      const reply = JSON.parse(lines.at(-1)!);
      expect(reply.autoCaps).toEqual([]);
      expect(reply.providerSignIn).toEqual({ claude: 'signed-out' });
      // The binary path never rides the reply — verdicts only.
      expect(JSON.stringify(reply)).not.toContain('/opt/homebrew');
      lines.length = 0;
      expect(await cmdNodeFleet('join', ['--node', 'm-text', '--owner', 'acme'], deps)).toBe(0);
      const text = lines.at(-1)!;
      expect(text).toContain('claude is installed but not signed in');
      expect(text).toContain('`claude auth login`');
      expect(text).toContain('join again');
      expect(text).not.toContain('codex is installed');
    } finally { vi.restoreAllMocks(); }
  });

  it('reports an unverifiable sign-in check as unknown, never signed-out', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      const unknownClaude: ProviderProbe = { provider: 'claude', binary: '/opt/homebrew/bin/claude', signIn: 'unknown' };
      expect(await cmdNodeFleet('join', ['--node', 'm-unknown-json', '--owner', 'acme', '--json'],
        { store, phmVersion: version, providerStates: () => [codexOk, unknownClaude], installedClis: () => [] })).toBe(0);
      const reply = JSON.parse(lines.at(-1)!);
      expect(reply.autoCaps).toEqual(['codex']);
      expect(reply.providerSignIn).toEqual({ claude: 'unknown' });
      lines.length = 0;
      expect(await cmdNodeFleet('join', ['--node', 'm-unknown-text', '--owner', 'acme'],
        { store, phmVersion: version, providerStates: () => [codexOk, unknownClaude], installedClis: () => [] })).toBe(0);
      expect(lines.at(-1)!).toContain('claude is installed but its sign-in check could not complete');
    } finally { vi.restoreAllMocks(); }
  });

  it('omits providerSignIn when every provider is ok or absent, and on explicit --caps', async () => {
    const lines = capture();
    try {
      const store = new MemoryStore();
      expect(await cmdNodeFleet('join', ['--node', 'm-ok-json', '--owner', 'acme', '--json'],
        { store, phmVersion: version, providerStates: () => [codexOk, codexAbsent], installedClis: () => [] })).toBe(0);
      expect(JSON.parse(lines.at(-1)!)['providerSignIn']).toBeUndefined();
      lines.length = 0;
      // An explicit --caps skips the sign-in probe entirely: no providerStates
      // seam is consulted and the reply carries no providerSignIn.
      const states = vi.fn(() => [claudeFailed]);
      expect(await cmdNodeFleet('join', ['--node', 'm-caps', '--owner', 'acme', '--caps', 'build', '--json'],
        { store, phmVersion: version, providerStates: states, installedClis: () => [] })).toBe(0);
      const reply = JSON.parse(lines.at(-1)!);
      expect(reply.providerSignIn).toBeUndefined();
      expect(reply.autoCaps).toBeUndefined();
      expect(states).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});
