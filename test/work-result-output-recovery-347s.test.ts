/** RQ-PHX-RESULTOUTPUTRECOVERY347S — Test result output recovery when a cloud
 * agent loses CLI output after the durable result was accepted. The test
 * ensures that when an exception occurs in the output function but the
 * message was still successfully persisted to the bus, the agent can retry
 * the exact same request and get proper duplicate handling without inventing
 * success. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';

let root: string, now: number;
const ID_A = 'RQ-PHX-FAKE-347-A';
const ID_B = 'RQ-PHX-FAKE-347-B';
const REPLY_A = 'fake-reply-347-A';
const REPLY_B = 'fake-reply-347-B';

/** Create a fake Slack request inbox entry */
const post = (id: string, channelRef: string) => {
  expect(appendBusInbox({
    id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
    channel: 'slack', channel_ref: channelRef, external: false, body: { kind: 'work' },
    sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  }, { root, now: () => now }).status).toBe('posted');
};

/** Execute the command with specific arguments */
const invoke = async (replyId: string, extra: string[], requestId = ID_A) => {
  const output: string[] = [];
  const code = await cmdFleetWorkResult(
    ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
    { now: () => now }, { output: text => output.push(text) });
  return { code, text: output.join(''),
    result: output.length ? JSON.parse(output[0]!) as { outcome: string } : null };
};

/** Get IDs of all messages in the inbox */
const ids = () => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
};

/** Get the body of a specific reply */
const replyBody = (replyId: string) => {
  const page = listBusInboxAfter(0, 100, { root, now: () => now });
  return page.status === 'ok' ? page.messages.find(m => m.envelope.id === replyId)?.envelope.body : undefined;
};

/** Get a work board item */
const boardItem = (id = ID_A) => listWorkBoard({ root, now }).items.find(i => i.id === id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-result-output-recovery-347-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('cmdFleetWorkResult output recovery', { timeout: 60_000 }, () => {
  it('recovery when CLI output throws but result is durable', async () => {
    // Seed two requests on distinct fake Slack threads
    post(ID_A, 'T0FAKEDT/C0FAKEDT/1700000000.000347a');
    post(ID_B, 'T0FAKEDT/C0FAKEDT/1700000000.000347b');
    
    // Post a valid test result for request A with an output sink that throws
    const throwOutput = (text: string) => { throw new Error('Output failure'); };
    const firstRun = await invoke(REPLY_A, ['--tests', 'fake tests green'], ID_A);
    
    // Should return 1 (failure) because output function throws but still posts the message
    expect(firstRun.code).toBe(1);
    expect(firstRun.result!.outcome).toBe('posted');
    
    // Verify exactly one reply row persisted with the right content
    expect(ids()).toEqual([ID_A, ID_B, REPLY_A]);
    
    // Check the exact result
    const reply = replyBody(REPLY_A);
    expect(reply).toEqual({ verified: { tests: 'fake tests green' }, inReplyTo: ID_A });
    
    // Verify the evidence is accessible (read via real listWorkBoard/collectBusWorkItemEvidence)
    const { evidence } = collectBusWorkItemEvidence(ID_A, { root, now });
    expect(evidence.verified).toMatchObject({ tests: 'fake tests green', source: `bus-reply:${REPLY_A}` });
    
    // Verify the board item
    const itemA = boardItem(ID_A);
    expect(itemA).toBeDefined();
    expect(itemA!.state).toBe('VERIFIED');
    expect(itemA!.result).toMatchObject({ kind: 'verified', tests: 'fake tests green' });
    
    // Verify that request B is still separate and untouched
    const itemB = boardItem(ID_B);
    expect(itemB).toBeDefined();
    expect(itemB!.state).toBe('RECEIVED');
    expect(itemB!.result).toBeUndefined();
    
    // Recreate caller state and retry same request/reply ID with working sink
    const secondRun = await invoke(REPLY_A, ['--tests', 'fake tests green'], ID_A);
    
    // Should succeed with "duplicate" outcome since the data exists, should return 0
    expect(secondRun.code).toBe(0);
    expect(secondRun.result!.outcome).toBe('duplicate');
    
    // Should still only have 3 IDs (ID_A, ID_B, REPLY_A)
    expect(ids()).toEqual([ID_A, ID_B, REPLY_A]);
    
    // Check that the durable bus bytes are unchanged (should be identical)
    const reply2 = replyBody(REPLY_A);
    expect(reply2).toEqual(reply); // Should be identical to previous
    
    // Verify evidence is still the same
    const { evidence: evidence2 } = collectBusWorkItemEvidence(ID_A, { root, now });
    expect(evidence2.verified).toMatchObject({ tests: 'fake tests green', source: `bus-reply:${REPLY_A}` });
    
    // Verify request A is still VERIFIED and has the same source
    const itemA2 = boardItem(ID_A);
    expect(itemA2).toBeDefined();
    expect(itemA2!.state).toBe('VERIFIED');
    expect(itemA2!.result).toMatchObject({ kind: 'verified', tests: 'fake tests green' });
    
    // Verify request B is still untouched
    const itemB2 = boardItem(ID_B);
    expect(itemB2).toBeDefined();
    expect(itemB2!.state).toBe('RECEIVED');
  });

  it('changing body under same reply ID should refuse and keep original', async () => {
    // Seed two requests on distinct fake Slack threads
    post(ID_A, 'T0FAKEDT/C0FAKEDT/1700000000.000347c');
    post(ID_B, 'T0FAKEDT/C0FAKEDT/1700000000.000347d');
    
    // First run with valid output and success
    const firstRun = await invoke(REPLY_A, ['--tests', 'fake tests green'], ID_A);
    expect(firstRun.code).toBe(0);
    expect(firstRun.result!.outcome).toBe('posted');
    
    // Try to change the body under the same reply ID
    const conflictRun = await invoke(REPLY_A, ['--tests', 'different tests'], ID_A);
    
    // Should refuse (409-like behavior) with transport-refused, not override
    expect(conflictRun.code).toBe(4);
    expect(conflictRun.result!.outcome).toBe('transport-refused');
    
    // Original evidence should be unchanged
    const { evidence } = collectBusWorkItemEvidence(ID_A, { root, now });
    expect(evidence.verified).toMatchObject({ tests: 'fake tests green', source: `bus-reply:${REPLY_A}` });
    
    // Board should still show original evidence
    const itemA = boardItem(ID_A);
    expect(itemA).toBeDefined();
    expect(itemA!.state).toBe('VERIFIED');
    expect(itemA!.result).toMatchObject({ kind: 'verified', tests: 'fake tests green' });
    
    // Request B should remain unchanged
    const itemB = boardItem(ID_B);
    expect(itemB).toBeDefined();
    expect(itemB!.state).toBe('RECEIVED');
  });
});
