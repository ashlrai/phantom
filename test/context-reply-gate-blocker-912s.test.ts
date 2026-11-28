import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { runContextReply } from '../src/core/fleet/context-result-bus.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

vi.mock('../src/core/fleet/context-worker-run.js', () => ({ runContextWorker: vi.fn() }));
import { runContextWorker } from '../src/core/fleet/context-worker-run.js';

const now = 1_700_000_000_000;
const diagnostic = 'private-fake-diagnostic-marker';
let root = '';
afterEach(() => { vi.resetAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it.each([
  ['fail', 0, true, 'BLOCKED', 'Fix the failed local gate and rerun verification.'],
  ['error', 0, true, 'BLOCKED', 'Restore the local gate and rerun verification.'],
  ['pass', 0, true, 'VERIFIED', undefined],
  ['unchecked', 0, false, 'RECEIVED', undefined],
  ['skipped', 7, true, 'RECEIVED', undefined],
] as const)('publishes %s evidence to the work board', async (verdict, exit, check, state, dependency) => {
  root = mkdtempSync(join(tmpdir(), 'gate-blocker-'));
  const busRoot = join(root, 'bus');
  const request = { id: 'request', from: 'requester', to: 'worker', priority: 'P1', ttl: 60000, body: { kind: 'work' } };
  const snapshot = join(root, 'snapshot');
  const prompt = join(root, 'prompt');
  const requestFile = join(root, 'request');
  writeFileSync(snapshot, '{}'); writeFileSync(prompt, 'prompt'); writeFileSync(requestFile, JSON.stringify(request));
  expect(appendBusInbox(request, { root: busRoot, now: () => now }).status).toBe('posted');
  vi.mocked(runContextWorker).mockResolvedValue(exit);
  const exec = vi.fn(async (command: string, args: string[]) => ({
    ok: !(verdict === 'fail' && args.includes('--noEmit')),
    stdout: command === 'git' ? 'a'.repeat(40) : diagnostic, stderr: diagnostic,
  }));
  const result = await runContextReply({ snapshot, prompt, requestFile, replyId: 'reply', argv: ['fake'],
    ...(check ? { check: {} } : {}) }, { gate: { exec, appendMetric: async () => {},
      ...(verdict === 'error' ? { now: () => { throw new Error(diagnostic); } } : {}) } },
  { root: busRoot, now: () => now + 1 });
  expect(result.replyReceipt.status).toBe('posted');
  expect(result.verification).toBe(verdict === 'unchecked' ? undefined : verdict);
  expect(result.workerExit).toEqual({ status: 'returned', exitCode: exit });
  expect(result.exitCode).toBe(exit || (verdict === 'fail' || verdict === 'error' ? 1 : 0));
  const { evidence } = collectBusWorkItemEvidence('request', { root: busRoot, now: now + 1 });
  expect(classifyWorkItem(evidence, new Date(now + 1).toISOString())).toMatchObject({ state,
    ...(dependency || verdict === 'pass' ? { source: 'bus-reply:reply' } : {}) });
  if (dependency) expect(evidence.blocker).toMatchObject({ dependency, source: 'bus-reply:reply' });
  else expect(evidence.blocker).toBeUndefined();
  if (verdict === 'pass') expect(evidence.verified).toMatchObject({ tests: 'local-gate pass', source: 'bus-reply:reply' });
  else expect(evidence.verified).toBeUndefined();
  if (!check || exit !== 0) expect(exec).not.toHaveBeenCalled();
  expect(readFileSync(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8')).not.toContain(diagnostic);
});
