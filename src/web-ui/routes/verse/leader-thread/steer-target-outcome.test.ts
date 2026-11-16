import { describe, expect, it } from 'vitest';
import { steerTargetId, steerTargetOutcome, type SteerTargetJobFacts } from './steer-target-outcome.js';

const ENTRY = 'steer @RQ-PHX-FIX now, then watch it';
const ID = 'RQ-PHX-FIX';
const PR = 'https://github.com/ashlrai/phantom/pull/1234';

describe('steerTargetId', () => {
  it('reads the entry\'s first @RQ target with the steer box parser', () => {
    expect(steerTargetId(ENTRY)).toBe(ID);
    expect(steerTargetId('aim @RQ-ONE and @RQ-TWO')).toBe('RQ-ONE');
  });
  it('is null when the entry names no target', () => {
    expect(steerTargetId('ship the judge fix first')).toBeNull();
    expect(steerTargetId('email@RQ-PHX-FIX is not a mention')).toBeNull();
  });
});

describe('steerTargetOutcome', () => {
  it('returns null for an entry with no @RQ-id', () => {
    expect(steerTargetOutcome('ship the fix', { detail: { state: 'running', prUrl: null, launchedAt: null } })).toBeNull();
  });

  it('reports a merged job with its PR number and link', () => {
    const outcome = steerTargetOutcome(ENTRY, { trace: { state: 'merged', url: PR } });
    expect(outcome).toEqual({ id: ID, stage: 'merged', text: `${ID} merged as #1234`, href: PR });
  });

  it('reports a merge seen in the last-hour merges read', () => {
    const outcome = steerTargetOutcome(ENTRY, { merged: { number: 77, href: 'https://github.com/ashlrai/phantom/pull/77' } });
    expect(outcome).toEqual({ id: ID, stage: 'merged', text: `${ID} merged as #77`, href: 'https://github.com/ashlrai/phantom/pull/77' });
  });

  it('keeps merged text honest when no PR number is recorded', () => {
    const outcome = steerTargetOutcome(ENTRY, { trace: { state: 'merged', url: null } });
    expect(outcome).toEqual({ id: ID, stage: 'merged', text: `${ID} merged` });
  });

  it('never links a non-GitHub url', () => {
    const outcome = steerTargetOutcome(ENTRY, { trace: { state: 'merged', url: 'https://forge.example/ashlrai/phantom/pull/9' } });
    expect(outcome).toEqual({ id: ID, stage: 'merged', text: `${ID} merged` });
  });

  it('reports a published job as finished with the PR open', () => {
    const facts: SteerTargetJobFacts = { detail: { state: 'published', prUrl: PR, launchedAt: null } };
    expect(steerTargetOutcome(ENTRY, facts)).toEqual({ id: ID, stage: 'open-pr', text: `${ID} finished, PR #1234 open`, href: PR });
  });

  it('reads an open PR from the pending publishes read', () => {
    const outcome = steerTargetOutcome(ENTRY, { pending: { href: 'https://github.com/ashlrai/phantom/pull/88' } });
    expect(outcome).toEqual({ id: ID, stage: 'open-pr', text: `${ID} finished, PR #88 open`, href: 'https://github.com/ashlrai/phantom/pull/88' });
  });

  it('reports a published job with no PR as ended empty', () => {
    const outcome = steerTargetOutcome(ENTRY, { detail: { state: 'published', prUrl: null, launchedAt: null } });
    expect(outcome).toEqual({ id: ID, stage: 'empty', text: `${ID} ended empty` });
  });

  it('reports an archived job as failed without inventing a reason', () => {
    const outcome = steerTargetOutcome(ENTRY, { detail: { state: 'archived', prUrl: null, launchedAt: null } });
    expect(outcome).toEqual({ id: ID, stage: 'failed', text: `${ID} failed: no publish result` });
  });

  it('reports a running job with its launch wall time', () => {
    const outcome = steerTargetOutcome(ENTRY, { detail: { state: 'running', prUrl: null, launchedAt: '2026-11-10T14:30:00Z' } });
    expect(outcome?.stage).toBe('running');
    expect(outcome?.text).toMatch(/^RQ-PHX-FIX still running \(since .+\)$/);
  });

  it('reads a live worker row as running even before the detail answers', () => {
    const outcome = steerTargetOutcome(ENTRY, { live: { launchedAt: '2026-11-10T14:30:00Z' } });
    expect(outcome?.stage).toBe('running');
    expect(outcome?.text).toMatch(/^RQ-PHX-FIX still running \(since .+\)$/);
  });

  it('lets a live run beat stale recorded history', () => {
    const facts: SteerTargetJobFacts = {
      trace: { state: 'merged', url: PR },
      live: { launchedAt: null },
      detail: { state: 'running', prUrl: null, launchedAt: null },
    };
    expect(steerTargetOutcome(ENTRY, facts)).toEqual({ id: ID, stage: 'running', text: `${ID} still running` });
  });

  it('says no outcome is recorded for an unknown job', () => {
    expect(steerTargetOutcome(ENTRY, { detail: { state: 'unknown', prUrl: null, launchedAt: null } }))
      .toEqual({ id: ID, stage: 'unknown', text: `${ID}: no outcome recorded yet` });
    expect(steerTargetOutcome(ENTRY, null))
      .toEqual({ id: ID, stage: 'unknown', text: `${ID}: no outcome recorded yet` });
    expect(steerTargetOutcome(ENTRY, { trace: { state: 'launched', url: null } }))
      .toEqual({ id: ID, stage: 'unknown', text: `${ID}: no outcome recorded yet` });
    expect(steerTargetOutcome(ENTRY, { trace: { state: 'queued', url: null } }))
      .toEqual({ id: ID, stage: 'unknown', text: `${ID}: no outcome recorded yet` });
  });
});
