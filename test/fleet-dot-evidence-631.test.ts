import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDotEvidence } from '../src/cli/fleet-dot-evidence.js';
import type { DotEvidenceDeps } from '../src/core/comms/dot-evidence-packet.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const HOME = '/home/fakeuser';

function deps(over: Partial<DotEvidenceDeps> = {}): DotEvidenceDeps {
  return {
    now: () => new Date(NOW),
    readRuntime: () => ({
      host: 'fake-host', platform: 'fakeos', asOf: new Date(NOW).toISOString(), installedVersion: '1.2.3', sourceVersion: '1.2.3',
      versionDrift: false, tailnetName: 'fake-node', reasons: [],
      fleetState: { path: `${HOME}/.ashlr-runs/guardian/state.json`, mtime: new Date(NOW).toISOString(), ageSeconds: 30, stale: false },
    }),
    readTailnet: () => ({
      asOf: new Date(NOW).toISOString(), self: 'fake-node', reasons: [],
      peers: [{ name: 'peer-a', os: 'linux', online: true, lastSeen: 'x', ageSeconds: 5 }],
    }),
    readBoard: () => ({
      schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [],
      claims: [{ id: 'claim-1', repo: 'o/r', task: 'work', agent: 'agent-a', claimedAt: NOW - 1000, expiresAt: NOW + 60_000,
        leaseHash: 'lease-FAKE-0001' } as never],
    }),
    readSlack: () => ({
      asOf: new Date(NOW).toISOString(), rows: [{ channelId: 'C-FAKE', text: 'secret body', path: `${HOME}/x` } as never],
      counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 }, sources: { journal: 'ok', sends: 'ok' },
    }),
    transport: { phantomToDot: 'unverified', teammateTransport: 'available-in-source', hostQualification: 'not-observed' },
    bridgeOwner: () => 'owner-fake',
    ...over,
  };
}

async function run(d: DotEvidenceDeps, args = ['--json']) {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetDotEvidence(args, d);
  const text = out.join('\n');
  return { code, text, json: args.includes('--json') ? JSON.parse(text) : null };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet dot-evidence', () => {
  it('healthy sources: exit 0, empty missing, claim ASSIGNED', async () => {
    const { code, json } = await run(deps());
    expect(code).toBe(0);
    expect(json.schema).toBe('fleet.dot-evidence.v1');
    expect(json.missing).toEqual([]);
    expect(json.claims.claims).toEqual([expect.objectContaining({ id: 'claim-1', state: 'ASSIGNED' })]);
    expect(json.tailnet.peers[0]).toEqual({ name: 'peer-a', os: 'linux', online: true, ageSeconds: 5 });
  });

  it('claims reader throws: unavailable, reason, exit 1, message not echoed', async () => {
    const { code, text, json } = await run(deps({ readBoard: () => { throw new Error(`EACCES ${HOME}/.ashlr/secret-path`); } }));
    expect(code).toBe(1);
    expect(json.claims).toEqual({ state: 'unavailable' });
    expect(json.missing).toContain('claims-store-unreadable');
    expect(text).not.toContain('EACCES');
    expect(text).not.toContain('secret-path');
  });

  it('serialized output carries no lease, token-shaped string or home path', async () => {
    for (const args of [['--json'], []]) {
      const { text } = await run(deps(), args);
      expect(text).not.toContain('lease-FAKE-0001');
      expect(text).not.toContain('secret body');
      expect(text).not.toContain('C-FAKE');
      expect(text).not.toContain(HOME);
      expect(text).not.toMatch(/(xox[a-z]-|sk-|ghp_|[A-Za-z0-9_-]{32,})/);
    }
  });

  it('bridge owner stays unknown when no source names one', async () => {
    const { code, json } = await run(deps({ bridgeOwner: () => null }));
    expect(json.bridge.owner).toBe('unknown');
    expect(json.missing).toEqual(['bridge-owner-unknown']);
    expect(code).toBe(1);
  });

  it('human output ends with a missing line; bad args exit 2', async () => {
    const { code, text } = await run(deps(), []);
    expect(code).toBe(0);
    expect(text.split('\n').at(-1)).toBe('missing: none');
    expect((await run(deps(), ['--bogus'])).code).toBe(2);
  });
});
