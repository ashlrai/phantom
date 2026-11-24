/** A valid but different workspace must never redirect a pending source-thread
 * notice. Reconstruct every dependency between passes so only private files
 * carry the claim, binding, baseline, sent ledger and bus across restarts. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimNoticeSlackSender } from '../src/cli/fleet-claim-notices.js';
import type { AgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendClaimThreadBinding } from '../src/core/fleet/claim-thread-binding-write.js';
import { claimNoticeFileDeps, claimNoticePaths, runClaimNoticePass } from '../src/core/fleet/claim-notice-send.js';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';

const TEAM_A = 'T000FAKEA';
const TEAM_B = 'T000FAKEB';
const CHANNEL = 'C000FAKE';
const TS = '1700000000.000001';
const OWNER = 'fake-owner';
const REPO = 'fake/repo';
const HEAD = 'abcdef1234567';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const config = (teamId: string): AgentNetworkConfig => ({
  path: 'fake-network.toml', state: 'ok', teamIdentities: [],
  slack: { bridgeId: 'slack', teamId, map: [{ topic: 'fleet.claims', channel: CHANNEL }] },
});

describe('claim notice workspace fence across restarts', () => {
  it.each([
    ['slash', `${TEAM_A}/${CHANNEL}/${TS}`],
    ['slack', `slack:${TEAM_A}:${CHANNEL}:${TS}`],
  ])('%s thread remains pending on team B and resumes on team A', async (_grammar, thread) => {
    const root = mkdtempSync(join(tmpdir(), 'claim-notice-fence-495s-'));
    chmodSync(root, 0o700);
    dirs.push(root);
    const runs = join(root, 'runs');
    const bus = join(root, 'bus');
    const coordination = join(root, 'coordination.jsonl');
    const inbox = join(bus, 'bus-inbox', 'messages.json');
    const paths = claimNoticePaths(runs);
    let now = Date.parse('2026-11-16T00:00:00Z');
    const pass = (team: string) => {
      now += 5000;
      return runClaimNoticePass({
        readBoard: () => readFleetBoard({ path: coordination, now }),
        ...claimNoticeFileDeps(runs),
        send: claimNoticeSlackSender(bus, () => config(team)),
        now: () => now,
      });
    };
    const seed = postFleetMessage({ from: 'setup', to: 'all', body: 'seed', ttlMs: 1 },
      { path: coordination, now });
    expect(seed.ok).toBe(true);
    expect(await pass(TEAM_A)).toMatchObject({ status: 'completed', baselined: true, planned: 0 });
    // An empty existing ledger lets us check byte-for-byte preservation as well
    // as absence of any fabricated receipt or sent entry.
    writeFileSync(paths.sent, '', { mode: 0o600 });
    const baseline = readFileSync(paths.prev);
    const ledger = readFileSync(paths.sent);
    const claimed = claimFleetWork({ repo: REPO, task: 'fake task', agent: OWNER },
      { path: coordination, now: ++now });
    if (!claimed.ok) throw new Error(claimed.error);
    const binding = appendClaimThreadBinding(paths.bindings, {
      claimId: claimed.value.claim.id, repo: REPO, threadKey: thread, pr: 7, head: HEAD,
    }, now);
    expect(binding.ok).toBe(true);
    const key = JSON.stringify(['ASSIGNED', REPO, claimed.value.claim.id, OWNER, claimed.value.claim.claimedAt, HEAD]);
    const claimBytes = readFileSync(coordination);
    const bindingBytes = readFileSync(paths.bindings);

    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await pass(TEAM_B);
      expect(failed).toMatchObject({ status: 'completed', planned: 1, sent: 0, failed: 1 });
      expect(failed.deliveries).toHaveLength(1);
      expect(failed.deliveries[0]).toMatchObject({ result: 'failed', reason: 'thread-ref-unusable', dedupeKey: key });
      expect(failed.deliveries[0]!.receipt).toBeUndefined();
      expect(existsSync(inbox)).toBe(false);
      expect(readFileSync(paths.prev)).toEqual(baseline);
      expect(readFileSync(paths.sent)).toEqual(ledger);
      expect(readFileSync(coordination)).toEqual(claimBytes);
      expect(readFileSync(paths.bindings)).toEqual(bindingBytes);
    }

    const resumed = await pass(TEAM_A);
    expect(resumed).toMatchObject({ status: 'completed', planned: 1, sent: 1, failed: 0 });
    expect(resumed.deliveries[0]).toMatchObject({ result: 'sent', threadKey: thread, dedupeKey: key });
    const receipt = resumed.deliveries[0]!.receipt;
    expect(receipt).toMatch(/^bus-note:claim-notice-[0-9a-f]{24}$/);
    const busBytes = readFileSync(inbox);
    const rows = (JSON.parse(busBytes.toString()) as { rows: Array<{ envelope: {
      id: string; to: string; channel_ref: string; body: { text: string; thread: string; inReplyTo: string };
    } }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.envelope).toMatchObject({
      id: receipt!.slice('bus-note:'.length), to: 'fleet.claims', channel_ref: thread,
      body: { thread: `slack:${TEAM_A}:${CHANNEL}:${TS}`, inReplyTo: key },
    });
    expect(rows[0]!.envelope.body.text).toContain(OWNER);
    const sentBytes = readFileSync(paths.sent);
    const sentRows = sentBytes.toString().trim().split('\n').map(line => JSON.parse(line) as { key: string });
    expect(sentRows.map(row => row.key)).toEqual([key]);
    expect(readFileSync(coordination)).toEqual(claimBytes);
    expect(readFileSync(paths.bindings)).toEqual(bindingBytes);

    expect(await pass(TEAM_A)).toMatchObject({ status: 'completed', planned: 0, sent: 0, failed: 0 });
    expect(readFileSync(inbox)).toEqual(busBytes);
    expect(readFileSync(paths.sent)).toEqual(sentBytes);
  });
});
