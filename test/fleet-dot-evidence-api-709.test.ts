import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { DotEvidenceDeps } from '../src/core/comms/dot-evidence-packet.js';
import { DOT_HANDOFF_SUMMARY } from '../src/cli/fleet-dot-handoff.js';
import {
  createFleetDotEvidenceApi, DOT_EVIDENCE_TRANSPORT, VERSE_FLEET_DOT_EVIDENCE_PATH as PATH,
} from '../src/core/verse/fleet-dot-evidence-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');

function deps(owner: string | null): DotEvidenceDeps {
  return {
    now: () => NOW,
    readRuntime: () => ({
      host: 'fake-host-a', platform: 'fakeos', asOf: NOW.toISOString(), installedVersion: '1.0.0', sourceVersion: '1.0.0',
      versionDrift: false, tailnetName: 'fake-node', reasons: [],
      fleetState: { path: '/fake/state.json', mtime: NOW.toISOString(), ageSeconds: 10, stale: false },
    }),
    readTailnet: () => ({ asOf: NOW.toISOString(), self: 'fake-node', reasons: [], peers: [] }),
    readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [], claims: [] }),
    readSlack: () => ({
      asOf: NOW.toISOString(), rows: [], counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
      sources: { journal: 'ok', sends: 'ok' },
    }),
    transport: DOT_EVIDENCE_TRANSPORT,
    bridgeOwner: () => owner,
  };
}

async function call(api: ApiModule, method = 'GET', path = PATH) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url: path } as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('dot-evidence route', () => {
  it('GET returns v1, authority none and the packet with the injected owner', async () => {
    const api = createFleetDotEvidenceApi({ now: () => NOW, resolveOwner: async () => 'agent-fake-1', packetDeps: deps });
    const r = await call(api);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toMatchObject({ v: 1, authority: 'none', generatedAt: NOW.toISOString() });
    expect(r.body.packet.bridge.owner).toBe('agent-fake-1');
    expect(r.body.packet.runtime.host).toBe('fake-host-a');
    expect(r.body.packet.missing).toEqual([]);
  });
  it('reports owner unknown when the resolver finds none', async () => {
    const api = createFleetDotEvidenceApi({ now: () => NOW, resolveOwner: async () => null, packetDeps: deps });
    const r = await call(api);
    expect(r.body.packet.bridge.owner).toBe('unknown');
    expect(r.body.packet.missing).toContain('bridge-owner-unknown');
  });
  it('answers 405 for non-GET and ignores other paths', async () => {
    const api = createFleetDotEvidenceApi({ resolveOwner: async () => null, packetDeps: deps });
    expect(await call(api, 'POST')).toMatchObject({ handled: true, status: 405 });
    expect((await call(api, 'GET', '/api/verse/other')).handled).toBe(false);
  });
  it('degrades to all-unavailable without echoing the thrown message', async () => {
    const api = createFleetDotEvidenceApi({
      now: () => NOW, resolveOwner: async () => 'agent-fake-1',
      packetDeps: () => { throw new Error('secret-boom /home/fake/.ashlr'); },
    });
    const r = await call(api);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('secret-boom');
    expect(r.text).not.toContain('/home/fake');
    const p = r.body.packet;
    for (const k of ['runtime', 'tailnet', 'claims', 'slack']) expect(p[k]).toEqual({ state: 'unavailable' });
    expect(p.bridge.owner).toBe('unknown');
    expect(p.missing.length).toBeGreaterThan(0);
  });
  it('is routed by the runtime-identity family, not hostReach', async () => {
    const dotEvidence = vi.fn<ApiModule>(async () => true);
    const hostReach = vi.fn<ApiModule>(async () => true);
    const api = createFleetRuntimeIdentityApi({ dotEvidence, hostReach });
    await call(api, 'GET', PATH);
    expect(dotEvidence).toHaveBeenCalledOnce();
    expect(hostReach).not.toHaveBeenCalled();
  });
  it('keeps the copied transport strings equal to DOT_HANDOFF_SUMMARY.transport', () => {
    const t = DOT_HANDOFF_SUMMARY.transport;
    expect(DOT_EVIDENCE_TRANSPORT).toEqual({
      phantomToDot: t.phantomToDot, teammateTransport: t.teammateTransport, hostQualification: t.hostQualification,
    });
  });
});
