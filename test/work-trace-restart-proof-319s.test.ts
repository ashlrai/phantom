import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const id = 'RQ-FAKE-RESTART-319';
const other = 'RQ-FAKE-UNASSIGNED-319';
const message = 'plainly fake Slack message text';
const now = 1_800_000_000_000;
const iso = new Date(now).toISOString();

// Each invocation has its own module cache and exits normally before the next.
const childScript = `
import { appendBusInbox } from './src/core/fleet/bus-inbox.ts';
import { mutateBusWorkClaim } from './src/core/fleet/bus-work-claims.ts';
import { postBusReply } from './src/core/fleet/bus-reply-post.ts';
import { collectBusWorkItemEvidence } from './src/core/comms/work-item-bus-evidence.ts';
import { classifyWorkItem } from './src/core/comms/work-item-state.ts';
const [mode, root, id, other, message, clock] = process.argv.slice(1);
const now = Number(clock);
Date.now = () => now;
if (mode === 'write') {
  for (const requestId of [id, other]) {
    const result = appendBusInbox({ id: requestId, from: 'fake-slack', to: 'fake-lane', priority: 'P1',
      ttl: 10000000, body: { kind: 'work', channel: 'slack', text: message } }, { root, now: () => now });
    if (result.status !== 'posted') throw new Error('request was not posted');
  }
  const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs: 600000, root });
  if (claim.status !== 'acquired' || !claim.token) throw new Error('claim was not acquired');
} else if (mode === 'reply') {
  const result = postBusReply(id, 'fake-result-319', { verified: { artifact: 'fake-artifact-319' } },
    { root, now: () => now });
  if (result.outcome !== 'posted') throw new Error('reply was not posted');
} else {
  const read = requestId => {
    const collected = collectBusWorkItemEvidence(requestId, { root, now });
    return { ...collected, state: classifyWorkItem(collected.evidence, new Date(now).toISOString()) };
  };
  process.stdout.write(JSON.stringify({ request: read(id), other: read(other) }));
}
`;

function run(mode: string, root: string): string {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript,
    mode, root, id, other, message, String(now)], { encoding: 'utf8', timeout: 30_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

function storeBytes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${name}/`);
      else files[name] = readFileSync(join(dir, entry.name)).toString('base64');
    }
  };
  visit(root);
  return files;
}

describe('work trace survives a process restart', () => {
  it('reads the receipt-bound claim and a later artifact without mutating the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'work-trace-restart-'));
    try {
      expect(run('write', root)).toBe('');
      const before = storeBytes(root);
      const claims = JSON.parse(readFileSync(join(root, 'bus-work-claims', 'claims.json'), 'utf8'));
      const token: string = claims[0].token;
      expect(token).toBeTruthy();
      const firstOutput = run('read', root);
      expect(storeBytes(root)).toEqual(before);
      const first = JSON.parse(firstOutput);
      expect(first.request).toMatchObject({ sources: { inbox: 'found', claims: 'available' },
        evidence: { id, receivedAt: iso, owner: 'fake-owner', claimReceipt: `bus-claim:${id}:1:${now}` },
        state: { state: 'RUNNING', asOf: iso, source: `bus-work-claims lease-until ${new Date(now + 600_000).toISOString()}` } });
      expect(first.other).toMatchObject({ evidence: { id: other }, state: { state: 'RECEIVED',
        missing: ['named owner', 'durable claim receipt'] } });
      expect(first.other.evidence.owner).toBeUndefined();
      expect(first.other.evidence.claimReceipt).toBeUndefined();
      expect(run('reply', root)).toBe('');
      const afterReply = storeBytes(root);
      const secondOutput = run('read', root);
      expect(storeBytes(root)).toEqual(afterReply);
      const second = JSON.parse(secondOutput);
      expect(second.request).toMatchObject({ evidence: { id, claimReceipt: `bus-claim:${id}:1:${now}`,
        verified: { artifact: 'fake-artifact-319', source: 'bus-reply:fake-result-319', at: iso } },
        state: { state: 'VERIFIED', source: 'bus-reply:fake-result-319', asOf: iso } });
      expect(second.other.state.state).toBe('RECEIVED');
      for (const output of [firstOutput, secondOutput]) {
        expect(output).not.toContain(message);
        expect(output).not.toContain(token);
        expect(output).not.toMatch(/[a-f0-9]{64}/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
