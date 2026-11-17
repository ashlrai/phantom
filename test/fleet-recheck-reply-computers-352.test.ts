/** RQ-PHX-RECHECKREPLYCOMPUTERS352 — the thread reply carries one evidence-only
 * "Computers:" line built from the verdict's tailnet evidence. Verdicts are
 * built by hand with fake names; nothing touches the real home or tailnet. */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps, type FleetRecheckTailnet } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import { formatComputersLine } from '../src/core/fleet/recheck-computers-line.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const ledger: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
};
const channel = (c: 'slack' | 'imessage'): ChannelHealth => ({
  channel: c, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

const deps: FleetRecheckDeps = {
  now: () => NOW, homeDir: () => '/home/fakeuser',
  readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
  listWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false }),
  listCoordination: () => ({ source: 'unavailable', claims: [] }),
  listLiveWorkers: () => { throw new Error('absent'); },
};

const peer = (name: string, online: boolean | 'unknown' = true) => ({ name, online, ageSeconds: 5 as number | 'unknown' });
const tailnet = (over: Partial<FleetRecheckTailnet> = {}): FleetRecheckTailnet => ({
  source: 'tailscale-status', asOf: ISO, self: 'fake-mac-a', online: 2, offline: 1, unknown: 0,
  peers: [peer('fake-mac-b'), peer('fake-mac-c'), peer('fake-mac-d', false)], reasons: [], ...over,
});

async function verdict(t: FleetRecheckTailnet | null | undefined): Promise<FleetRecheck> {
  const v = await readFleetRecheck(deps);
  return { ...v, tailnet: t };
}
const computersOf = (reply: string): string | undefined => reply.split('\n').find(l => l.startsWith('Computers:'));

describe('Computers line in the recheck reply', () => {
  it('shows counts, self, three names and +N right after Runtime', async () => {
    const t = tailnet({
      online: 3, offline: 2, unknown: 1,
      peers: [peer('fake-mac-b'), peer('fake-mac-c'), peer('fake-mac-d'), peer('fake-mac-e', false)],
    });
    const lines = formatRecheckReply(await verdict(t)).split('\n');
    const i = lines.findIndex(l => l.startsWith('Runtime:'));
    expect(lines[i + 1]).toBe(
      `Computers: 3 online, 2 offline, 1 unknown · self fake-mac-a · seen: fake-mac-b, fake-mac-c, fake-mac-d +3 · as of ${ISO} (tailnet evidence, not a claim)`,
    );
  });

  it('omits the unknown segment at 0 and the +N when nothing remains', async () => {
    const line = computersOf(formatRecheckReply(await verdict(tailnet())));
    expect(line).toBe(
      `Computers: 2 online, 1 offline · self fake-mac-a · seen: fake-mac-b, fake-mac-c, fake-mac-d · as of ${ISO} (tailnet evidence, not a claim)`,
    );
    expect(line).not.toContain('unknown');
  });

  it('says unknown when the verdict has no tailnet evidence', async () => {
    for (const t of [null, undefined]) {
      expect(computersOf(formatRecheckReply(await verdict(t)))).toBe('Computers: unknown (no tailnet evidence)');
    }
    expect(formatComputersLine(null, s => s)).toBe('Computers: unknown (no tailnet evidence)');
  });

  it('shows the first reason when the tailnet reader failed', async () => {
    const t = tailnet({ self: 'unknown', online: 0, offline: 0, unknown: 0, peers: [], reasons: ['tailnet: reader failed'] });
    expect(computersOf(formatRecheckReply(await verdict(t)))).toBe(
      `Computers: 0 online, 0 offline · self unknown · seen: none · as of ${ISO} · tailnet: reader failed (tailnet evidence, not a claim)`,
    );
  });

  it('redacts IPv4 addresses and home paths in peer names', async () => {
    const t = tailnet({ peers: [peer('fake-mac-b 100.64.1.2'), peer('/Users/fakeuser/x'), peer('fake-mac-c')] });
    const reply = formatRecheckReply(await verdict(t));
    expect(computersOf(reply)).toContain('~');
    expect(reply).not.toContain('100.64.1.2');
    expect(reply).not.toContain('/Users/fakeuser');
  });

  it('replaces routed/dispatched in peer names with [verb]', async () => {
    const t = tailnet({ peers: [peer('routed-mac'), peer('dispatched-mac'), peer('fake-mac-c')] });
    const reply = formatRecheckReply(await verdict(t));
    expect(computersOf(reply)).toContain('[verb]-mac');
    expect(reply).not.toMatch(/routed|dispatched/i);
  });

  it('drops Computers before Running job and Last verified, never the verdict line', async () => {
    const base = await verdict(tailnet());
    const full: FleetRecheck = {
      ...base,
      sections: {
        ...base.sections,
        task: { ...base.sections.task, lastVerified: {
          id: 'fake-done-1', owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1', asOf: ISO, source: 'bus-reply:fake',
        } },
      },
    };
    const withRunning = (missing: string[]): FleetRecheck => ({
      ...full,
      overall: { ...full.overall, state: 'BLOCKED', missing },
      sections: { ...full.sections, task: { ...full.sections.task, liveWorker: {
        job: 'fake-job-1', repo: 'fake-repo', lane: 'fakelane', tier: 'faketier', ageSeconds: 30, asOf: ISO, source: 'process-table',
      } } },
    } as FleetRecheck);

    const small = formatRecheckReply(withRunning(['m']));
    expect(small).toContain('Computers:');
    expect(small).toContain('Running job:');
    expect(small).toContain('Last verified:');

    // Find a verdict size where only the Computers line has to go.
    let dropped: string | undefined;
    for (let n = 1; n < 900 && dropped === undefined; n += 5) {
      const reply = formatRecheckReply(withRunning(['x'.repeat(n)]));
      if (!reply.includes('Computers:')) dropped = reply;
    }
    expect(dropped).toBeDefined();
    expect(dropped).toContain('Running job:');
    expect(dropped).toContain('Last verified:');

    // A much bigger verdict then loses Running job, then Last verified, in that order.
    const lines = (n: number) => formatRecheckReply(withRunning(['x'.repeat(n)]));
    const afterRunning = [...Array(900).keys()].map(n => lines(n)).find(r => !r.includes('Running job:'));
    expect(afterRunning).toBeDefined();
    expect(afterRunning).toContain('Last verified:');

    for (const n of [600, 700, 800, 1200]) {
      const reply = lines(n);
      expect(reply.length).toBeLessThanOrEqual(900);
      expect(reply.split('\n').pop()).toMatch(/^BLOCKED on: x+/);
    }
    const near = lines(500);
    expect(near.length).toBeLessThanOrEqual(900);
    expect(near.split('\n').pop()).toMatch(/^BLOCKED on: x+$/);
  });
});
