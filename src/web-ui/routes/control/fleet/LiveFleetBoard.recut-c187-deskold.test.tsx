/**
 * recut-c187-deskold — coverage for the #4083 (RQ-SWE3-RESBAR-VERIFY-1) recut:
 * the Live Fleet board resolves lane → provider marks through the shared
 * providerEngine helper from ProviderLogo instead of a local copy, so local /
 * ollama lanes get the 'local' mark the deleted copy never returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { LiveFleetBoard } from './LiveFleetBoard.js';

const lane = (name: string, remainingPct: number | null = 50) => ({
  lane: name, liveJobs: 1, queueDepth: 0,
  credit: { state: 'observed', remainingPct, observedAt: '2026-11-10T00:00:00Z' },
});
const lanes = (...names: string[]) => ({
  generatedAt: '2026-11-11T00:00:00Z',
  sources: { queue: { state: 'healthy' }, usage: { state: 'healthy' }, budgets: { state: 'healthy' } },
  lanes: names.map((name) => lane(name)),
});
const activity = { ts: '2026-11-11T00:00:00Z', recentActionsSource: { sourceState: 'healthy' }, recentMergesSourceQuality: { sourceState: 'healthy' }, recentActions: [], recentMerges: [] };
const verified = {
  v: 1, schema: 'fleet.verified-completion.v1', generatedAt: '2026-11-11T00:00:00Z',
  sourceState: 'healthy', scanned: 0, dropped: 0, truncated: false, windowMs: 86_400_000,
  eligible: 0, verified: 0, failed: 0, pending: 0, rate: null,
  claims: { published: 0, batchMembers: 0, outcomes: 0 }, completedUnpublished: 0,
  duplicates: { multiPrJobs: 0, sharedPrUrls: 0 }, falseCompletions: 0, unauthorizedActions: 0,
  byLane: {}, detail: { falseCompletionJobs: [], multiPrJobs: [], sharedPrUrls: [], unauthorizedJobs: [] },
};
const respond = (url: string, laneNames: string[]) =>
  url.includes('/lanes') ? lanes(...laneNames) : url.includes('verified-completion') ? verified : activity;

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('LiveFleetBoard provider marks (recut from #4083)', () => {
  it('marks a local lane with the shared local mark the deleted copy lacked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url, ['local'])))));
    const { container } = render(<LiveFleetBoard />);
    expect(await screen.findByRole('meter', { name: 'local quota remaining' })).toBeInTheDocument();
    expect(container.querySelector('[data-provider="local"]')).toBeInTheDocument();
  });

  it('marks an ollama-suffixed lane the same way, without inventing a provider for unknown lanes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url, ['ollama-vision', 'terra'])))));
    const { container } = render(<LiveFleetBoard />);
    expect(await screen.findByRole('meter', { name: 'ollama-vision quota remaining' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-provider="local"]')).toHaveLength(1);
    expect(container.querySelector('[data-provider="terra"]')).not.toBeInTheDocument();
  });

  it('keeps substring matching for the hosted lanes, e.g. codex-personal → codex', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(respond(url, ['devin', 'codex-personal', 'claude-api', 'grok'])))));
    const { container } = render(<LiveFleetBoard />);
    expect(await screen.findByRole('meter', { name: 'devin quota remaining' })).toBeInTheDocument();
    for (const engine of ['devin', 'codex', 'claude', 'grok']) {
      expect(container.querySelector(`[data-provider="${engine}"]`)).toBeInTheDocument();
    }
  });
});
