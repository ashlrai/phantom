import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createAppsChangesPublisher } from '../src/core/fleet/apps-changes-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { createFleetDoctorApi } from '../src/core/verse/fleet-doctor-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetDoctorReport } from '../src/cli/fleet-doctor.js';

// Recut check for PR 4023 (RQ-REBASE-PH-17): the recovered modules must keep
// their original behavior on current master, not just exist.
describe('recut-n4r3900s79 (PR 4023)', () => {
  it('apps-changes publisher normalizes events into valid ordered bus envelopes', () => {
    const root = mkdtempSync(join(tmpdir(), 'recut-n4-'));
    try {
      const publish = createAppsChangesPublisher(root);
      expect(publish({ type: 'baseline', app: 'Phantom', state: 'running', time: '2026-11-10T00:00:00.000Z' })).toBe(true);
      expect(publish({ type: 'summary', outcome: 'complete', samples: 1, transitions: 0 })).toBe(true);
      const page = listBusInboxAfter(0, 10, { root });
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') return;
      expect(page.messages).toHaveLength(2);
      const [first, second] = page.messages.map(row => row.envelope);
      expect(first!.from).toBe('apps-changes');
      expect(first!.to).toBe('leaders');
      const firstBody = first!.body as Record<string, unknown>;
      const secondBody = second!.body as Record<string, unknown>;
      expect(firstBody).toMatchObject({ kind: 'apps-changes.event.v1', type: 'baseline', app: 'Phantom', state: 'running', sequence: 1 });
      expect(secondBody).toMatchObject({ kind: 'apps-changes.event.v1', type: 'summary', outcome: 'complete', samples: 1, transitions: 0, sequence: 2 });
      expect(firstBody.invocationId).toBe(secondBody.invocationId);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fleet doctor API serves the injected report on GET and refuses POST', async () => {
    const report: FleetDoctorReport = { v: 1, generatedAt: '2026-11-10T00:00:00Z', level: 'ok', checks: [{ name: 'lanes', level: 'ok', reason: 'fresh' }] };
    const respond = () => {
      const out = { status: 0, body: '' };
      const res = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.body = b ?? ''; },
        setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
      return { out, res };
    };
    const api = createFleetDoctorApi(async () => report);
    const get = respond();
    expect(await api({} as VerseApiContext, {} as IncomingMessage, get.res, '/api/verse/fleet/doctor', 'GET')).toBe(true);
    expect(get.out.status).toBe(200);
    expect(JSON.parse(get.out.body)).toMatchObject({ level: 'ok', checks: [{ name: 'lanes' }] });
    const post = respond();
    expect(await api({} as VerseApiContext, {} as IncomingMessage, post.res, '/api/verse/fleet/doctor', 'POST')).toBe(true);
    expect(post.out.status).toBe(405);
  });
});
