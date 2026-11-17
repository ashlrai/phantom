import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

it('keeps delivered Slack evidence separate from runtime and durable claims reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-518s-'));
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  const ledger = join(root, 'coordination.jsonl');
  const prior = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  const at = '2024-11-07T18:00:00.000Z';
  const sourceAt = '2024-11-07T17:59:59.000Z';
  const thread = '1731000000.000100';
  const channel = 'C0FAKE0001';
  const requestId = fakeRequestId('518s');
  try {
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true });
    mkdirSync(stateRoot);
    writeFileSync(join(runsDir, 'slack-bridge', 'journal.jsonl'), JSON.stringify({
      at: '2024-11-07T17:59:30.000Z', decision: 'ingested', bus: 'posted', channelId: channel, threadTs: thread,
      messageTs: '1731000010.000100', requestId,
    }) + '\n');
    writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
      [replyKey(requestId)]: { channel, thread, state: 'sent', ts: '1731002390.000100' },
    } }));
    const evidence = readSlackEvidenceBundle(thread, { runsDir, stateRoot, now: () => new Date(at), maxAgeSeconds: 60 });
    expect(evidence.counts.answered).toBe(1);
    expect(evidence.freshness?.verdict).toBe('fresh');
    expect(evidence.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
    process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
    writeFileSync(ledger, 'private-task-518s\n', { mode: 0o600 });
    const read = (available: boolean) => readFleetBridgeCheck({
      now: () => Date.parse(at),
      runtime: () => available
        ? { host: 'fake-host', asOf: sourceAt, lastFleetStateRead: { ageSeconds: 1 } }
        : { status: 'unavailable', asOf: sourceAt, lastFleetStateRead: { ageSeconds: 1 } },
      peers: () => ({ status: 'ok', asOf: sourceAt }),
    });
    const blocked = await read(false);
    expect(blocked.verdict).toBe('BLOCKED');
    expect(blocked.missing).toEqual(expect.arrayContaining(['runtime', 'claims']));
    expect(blocked.claims.live).toBeNull();
    writeFileSync(ledger, '');
    const repaired = await read(true);
    expect(repaired.verdict).toBe('READY');
    expect(repaired.claims.live).toBe(0);
    const reply = formatBridgeCheckReply(repaired, new Date(at));
    expect(reply).toContain(`fleet-runtime ${sourceAt}`);
    expect(reply).toContain(`peer-ledger ${sourceAt}`);
    expect(reply).toContain('Reachability only; this is not an assignment or claim.');
    for (const forbidden of ['private-task-518s', 'ASSIGNED', 'RUNNING', 'VERIFIED']) expect(reply).not.toContain(forbidden);
  } finally {
    if (prior === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    else process.env['PHANTOM_FLEET_LEDGER_PATH'] = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
