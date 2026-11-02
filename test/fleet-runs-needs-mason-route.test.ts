import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_NEEDS_MASON_PATH as NEEDS } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function request(api: ReturnType<typeof createFleetRunsApi>, method: 'GET' | 'POST' = 'GET') {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = NEEDS;
  req.method = method;
  req.headers = {};
  let status = 0;
  let wire: unknown;
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { wire = JSON.parse(text); },
  } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, req, res, NEEDS, method);
  return { handled, status, wire };
}

describe('GET /api/verse/fleet/runs/needs-mason', () => {
  let runsDir: string;
  beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-needs-route-')); });
  afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

  it('returns absent when there is no file', async () => {
    const api = createFleetRunsApi({ runsDir });
    expect(await request(api)).toMatchObject({ handled: true, status: 200, wire: { v: 1, state: 'absent', items: [] } });
  });

  it('returns the open lines when the file exists', async () => {
    await writeFile(join(runsDir, 'NEEDS-MASON.md'), '- [ ] safari-import[keychain]: Approve the one-time Keychain prompt.\n- [x] fake done\n');
    const api = createFleetRunsApi({ runsDir });
    const result = await request(api);
    expect(result).toMatchObject({ handled: true, status: 200 });
    const wire = result.wire as { state: string; items: Array<{ id: string; text: string }> };
    expect(wire.state).toBe('ok');
    expect(wire.items).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{12}$/), text: 'safari-import[keychain]: Approve the one-time Keychain prompt.' }]);
  });

  it('rejects non-GET methods with 405', async () => {
    const api = createFleetRunsApi({ runsDir });
    expect(await request(api, 'POST')).toMatchObject({ handled: true, status: 405 });
  });
});
