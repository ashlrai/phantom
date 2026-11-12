/** RQ-PHX-REDTYPEFIXC172: carry #5133's merge-identity work onto master.
 * The source PR's Quick typecheck failed on authority drift: its test was a
 * Tier-1 test (merge stem + a mock of Tier-1 autopilot/github) with no
 * generated CODEOWNERS entry. This suite pins the carried behavior — the
 * fleet registry entry, the convention export name, and the pure merge
 * classifier — importing the modules so their types compile under test. */
import { describe, expect, it } from 'vitest';

import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { cmdFleetMergeIdentity } from '../src/cli/fleet-merge-identity.js';
import { bareLogin, classifyMerge, parseMergeNode, summarizeMerges, type MergeRecord } from '../src/core/prs/merge-identity.js';

describe('fleet merge-identity wiring', () => {
  it('is registered in the generated subcommand registry', () => {
    expect(FLEET_SUBCOMMAND_LOADERS['merge-identity']).toBeTypeOf('function');
  });

  it('resolves through the convention naming rule to the shipped export', async () => {
    const resolved = resolveFleetSubcommand('merge-identity');
    expect(resolved).toEqual({ module: './fleet-merge-identity.js', exportName: 'cmdFleetMergeIdentity' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['merge-identity']!();
    expect(loaded['cmdFleetMergeIdentity']).toBe(cmdFleetMergeIdentity);
  });
});

describe('merge identity behavior', () => {
  const QUEUE = { login: 'github-merge-queue', type: 'Bot' };
  const enqueued: MergeRecord = {
    number: 42,
    mergedAt: '2026-11-10T12:00:00Z',
    mergedBy: QUEUE,
    enqueuer: { login: 'mason', type: 'User' },
  };

  it('credits a merge-queue merge to the enqueuer, not the queue relay', () => {
    expect(classifyMerge(enqueued)).toEqual({
      number: 42,
      mergedAt: '2026-11-10T12:00:00Z',
      class: 'human',
      actor: 'mason',
      via: 'queue-enqueuer',
    });
  });

  it('parses a GraphQL search node and summarizes the window', () => {
    const record = parseMergeNode({
      number: 42,
      mergedAt: '2026-11-10T12:00:00Z',
      mergedBy: { __typename: 'Bot', login: 'github-merge-queue' },
      timelineItems: { nodes: [{ enqueuer: { __typename: 'User', login: 'mason' } }] },
    });
    expect(record).toEqual(enqueued);
    const summary = summarizeMerges([enqueued], { repo: 'ashlrai/phantom', since: '2026-11-01' });
    expect(summary.counts).toEqual({ automation: 0, human: 1, unknown: 0 });
    expect(bareLogin('Ashlr-Release[bot]')).toBe('ashlr-release');
  });
});
