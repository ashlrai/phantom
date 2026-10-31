/**
 * M32 — hermetic tests for src/core/inbox/notify-proposal.ts.
 *
 * Mocks both downstream helpers so NO real I/O or network calls fire.
 *
 * Invariants:
 *   - notifyNewProposal never throws regardless of downstream behaviour
 *   - notification line contains kind/title/id, never diff or summary
 *   - best-effort: even when both downstream calls fail, the wrapper resolves
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { notifyNewProposal } from '../src/core/inbox/notify-proposal.js';

// Mutable tracking state read by the module-level mocks.
let desktopCalls: { title: string; body: string }[] = [];
let notifyCalls: string[] = [];
let desktopReject = false;
let notifyReject = false;

function resetState() {
  desktopCalls = [];
  notifyCalls = [];
  desktopReject = false;
  notifyReject = false;
}

vi.mock('../src/core/integrations/desktop-notify.js', () => ({
  desktopNotify: vi.fn((_title: string, _body: string) => {
    // @ts-expect-error -- test mutable state
    desktopCalls.push({ title: _title, body: _body });
    if (desktopReject) return Promise.reject(new Error('desktop notify failed'));
    return Promise.resolve(true);
  }),
  desktopNotifyEnabled: vi.fn(() => true),
}));

vi.mock('../src/core/integrations/notify.js', () => ({
  notify: vi.fn((_text: string) => {
    // @ts-expect-error -- test mutable state
    notifyCalls.push(_text);
    if (notifyReject) return Promise.reject(new Error('webhook notify failed'));
    return Promise.resolve(true);
  }),
}));

function makeConfig(): AshlrConfig {
  return {
    version: 1, roots: ['/tmp/fake'], editor: 'cursor', staleDays: 30,
    categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {}, tools: {},
  } as AshlrConfig;
}

function makeProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    id: 'p-hello-world', repo: null, origin: 'swarm', kind: 'patch',
    title: 'fix the widget',
    summary: 'a longer summary that should NOT appear',
    diff: 'SECRET_DIFF_PUT_HERE_do_not_log_this',
    status: 'pending', createdAt: new Date().toISOString(), ...overrides,
  } as Proposal;
}

// Happy path: both succeed
describe('notifyNewProposal — happy path (both succeed)', () => {
  beforeEach(resetState);
  afterEach(() => { vi.clearAllMocks(); });

  it('resolves without throwing when both succeed', async () => {
    await expect(notifyNewProposal(makeProposal(), makeConfig())).resolves.toBeUndefined();
  });

  it('constructs metadata-only line (kind/title/id) and never logs diff or summary', async () => {
    await notifyNewProposal(makeProposal(), makeConfig());
    expect(desktopCalls).toHaveLength(1);
    const body = desktopCalls[0].body;
    expect(body).toContain('[patch]');
    expect(body).toContain('fix the widget');
    expect(body).toContain('p-hello-world');
    expect(body).not.toContain('SECRET_DIFF_PUT_HERE');
    expect(body).not.toContain('a longer summary');
  });
});

// Edge case: both downstream reject — wrapper never throws
describe('notifyNewProposal — edge case (both reject)', () => {
  beforeEach(() => { resetState(); desktopReject = true; notifyReject = true; });
  afterEach(() => { vi.clearAllMocks(); });

  it('never throws even when both downstream reject', async () => {
    await expect(notifyNewProposal(makeProposal(), makeConfig())).resolves.toBeUndefined();
  });
});

// Edge case: mixed success / failure — best-effort resolves
describe('notifyNewProposal — edge case (mixed)', () => {
  beforeEach(resetState);
  afterEach(() => { vi.clearAllMocks(); });

  it('resolves when desktop rejects but webhook resolves', async () => {
    desktopReject = true;
    await expect(notifyNewProposal(makeProposal(), makeConfig())).resolves.toBeUndefined();
  });

  it('resolves when webhook rejects but desktop resolves', async () => {
    notifyReject = true;
    await expect(notifyNewProposal(makeProposal(), makeConfig())).resolves.toBeUndefined();
  });

  it('constructs the line correctly for every proposal kind', async () => {
    for (const kind of ['patch' as const, 'pr' as const, 'deploy' as const, 'note' as const]) {
      await notifyNewProposal(makeProposal({ kind, title: `${kind} title` }), makeConfig());
    }
    // One call per kind — check each by index.
    const kinds: Array<Proposal['kind']> = ['patch', 'pr', 'deploy', 'note'];
    for (let i = 0; i < kinds.length; i++) {
      expect(desktopCalls[i].body).toContain(`[${kinds[i]}]`);
      expect(desktopCalls[i].body).toContain(`${kinds[i]} title`);
    }
  });
});
