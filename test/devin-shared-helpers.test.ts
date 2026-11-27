/**
 * Regression tests for the consolidated Devin lane helpers shared across
 * src/core/devin/* and src/cli/devin.ts.
 */
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordDevinMessageSent } from '../src/core/devin/service.js';
import { devinHome, ensureDevinDirectory, readDevinJsonFile, readDevinTask, writeDevinTask } from '../src/core/devin/store.js';
import { scrubDevinTurnText } from '../src/core/devin/turn-protocol.js';
import {
  DEVIN_BRANCH_PREFIX,
  DEVIN_TASK_SCHEMA_VERSION,
  formatDevinAcu,
  isDevinRecord,
  redactDevinKeys,
  roundDevinAcu,
  type DevinTaskV1,
} from '../src/core/devin/types.js';

function sampleTask(overrides: Partial<DevinTaskV1> = {}): DevinTaskV1 {
  const id = overrides.id ?? 'dv_20261126T1200_abc123';
  const now = '2026-11-26T12:00:00.000Z';
  return {
    v: DEVIN_TASK_SCHEMA_VERSION, id, repo: 'ashlrai/phantom', baseBranch: 'master',
    branch: `${DEVIN_BRANCH_PREFIX}${id}`, title: 'Sample task', prompt: 'Fix the helper',
    origin: 'cli', requestedBy: 'mason', sessionId: 'devin-sess123',
    sessionUrl: 'https://app.devin.ai/sessions/devin-sess123',
    state: 'blocked', stateReason: 'Devin is waiting for you.', failure: null,
    createdAt: now, launchedAt: now, updatedAt: now, session: null,
    maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null,
    ...overrides,
  };
}

beforeEach(() => { rmSync(devinHome(), { recursive: true, force: true }); });

describe('devin shared helpers', () => {
  it('isDevinRecord accepts plain objects and rejects arrays, null, and primitives', () => {
    expect(isDevinRecord({})).toBe(true);
    expect(isDevinRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], 'text', 42]) expect(isDevinRecord(value)).toBe(false);
  });

  it('roundDevinAcu and formatDevinAcu round to two decimals with singular/plural units', () => {
    expect(roundDevinAcu(1.234)).toBe(1.23);
    expect(roundDevinAcu(1.236)).toBe(1.24);
    expect(formatDevinAcu(0)).toBe('0 ACUs');
    expect(formatDevinAcu(1)).toBe('1 ACU');
    expect(formatDevinAcu(1.004)).toBe('1 ACU');
    expect(formatDevinAcu(2.5)).toBe('2.5 ACUs');
  });

  it('redactDevinKeys and scrubDevinTurnText redact cog_ tokens and bound length', () => {
    const shortToken = ['cog', 'short'].join('_');
    const longToken = ['cog', 'leakleakleakleak'].join('_');
    expect(redactDevinKeys(`key=${shortToken} and ${longToken}`)).toBe('key=[REDACTED] and [REDACTED]');
    expect(scrubDevinTurnText(`token ${shortToken} ok`)).toBe('token [REDACTED] ok');
    expect(scrubDevinTurnText('abcdef', 5)).toBe('abcd…');
  });

  it('readDevinJsonFile reads valid private files and returns undefined for missing, oversized, corrupt, or symlinked files', () => {
    const dir = ensureDevinDirectory();
    const valid = join(dir, 'ok.json');
    const bad = join(dir, 'bad.json');
    const big = join(dir, 'big.json');
    const link = join(dir, 'link.json');
    writeFileSync(valid, '{"ok":true}\n', { mode: 0o600 });
    writeFileSync(bad, '{not json', { mode: 0o600 });
    writeFileSync(big, JSON.stringify({ pad: 'x'.repeat(256) }), { mode: 0o600 });
    symlinkSync(valid, link);

    expect(readDevinJsonFile(valid, 1024)).toEqual({ ok: true });
    expect(readDevinJsonFile(join(dir, 'missing.json'), 1024)).toBeUndefined();
    expect(readDevinJsonFile(bad, 1024)).toBeUndefined();
    expect(readDevinJsonFile(big, 32)).toBeUndefined();
    expect(readDevinJsonFile(link, 1024)).toBeUndefined();
  });

  it('recordDevinMessageSent increments count and resumes blocked (and optionally expired) tasks', () => {
    const blocked = sampleTask({ state: 'blocked' });
    writeDevinTask(blocked);
    const afterFirst = recordDevinMessageSent(blocked.id, blocked);
    expect(afterFirst.messagesSent).toBe(1);
    expect(afterFirst.state).toBe('running');
    expect(afterFirst.stateReason).toBe('You replied; Devin is working again.');
    expect(readDevinTask(blocked.id)?.messagesSent).toBe(1);

    const expired = sampleTask({ id: 'dv_20261126T1201_def456', state: 'expired', messagesSent: 2 });
    writeDevinTask(expired);
    expect(recordDevinMessageSent(expired.id, expired)).toMatchObject({ messagesSent: 3, state: 'expired' });
    expect(recordDevinMessageSent(expired.id, expired, { resumeExpired: true })).toMatchObject({ messagesSent: 4, state: 'running' });
  });
});
