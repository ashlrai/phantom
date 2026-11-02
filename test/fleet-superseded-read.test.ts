import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { readSuperseded, VERSE_FLEET_SUPERSEDED_PATH, type SupersededReadV1 } from '../src/core/fleet/superseded-read.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';

const open = (number: number, title = 'original', mergeStateStatus = 'DIRTY') => ({ number, title, mergeStateStatus });

// The module-scope 60 s cache is shared across this file, so each test injects
// a now() at least an hour away from every other test's cached read.
describe('readSuperseded', () => {
  it('pins the path the Merges pane and phone poll', () => {
    expect(VERSE_FLEET_SUPERSEDED_PATH).toBe('/api/verse/fleet/runs/superseded');
  });

  it('maps matched pairs, counts open DIRTY PRs and stamps v 1', async () => {
    const tick = Date.parse('2026-11-01T01:00:00Z');
    const gh = vi.fn<CloudGh>(async args => ({
      ok: true, stderr: '',
      stdout: JSON.stringify(args.includes('open')
        ? [open(2461), open(22, 'clean', 'CLEAN')]
        : [{ number: 2505, title: 'recut RQ-PHX-FAKE1' }]),
    }));
    const read = await readSuperseded({
      gh,
      prompts: async () => new Map([['RQ-PHX-FAKE1', 'Rebuild PR #2461.']]),
      now: () => new Date(tick),
    });
    expect(read).toEqual({
      v: 1, generatedAt: new Date(tick).toISOString(), source: 'ok', openDirty: 1,
      pairs: [{ open: 2461, openTitle: 'original', openState: 'DIRTY', mergedBy: 2505, mergedTitle: 'recut RQ-PHX-FAKE1', jobId: 'RQ-PHX-FAKE1' }],
    });
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls.every(([args]) =>
      args[0] === 'pr' && args[1] === 'list' && args.includes('--repo') && args.includes('ashlrai/phantom'))).toBe(true);
  });

  it.each(['failed', 'thrown', 'invalid'] as const)('reports gh %s as unavailable without throwing', async failure => {
    const tick = Date.parse('2026-11-01T03:00:00Z');
    const gh: CloudGh = async () => {
      if (failure === 'thrown') throw new Error('fake failure');
      return { ok: failure !== 'failed', stdout: 'invalid', stderr: 'fake failure' };
    };
    const read = await readSuperseded({ gh, prompts: async () => new Map(), now: () => new Date(tick) });
    expect(read).toMatchObject({ v: 1, source: 'unavailable', pairs: [], openDirty: 0 });
  });

  it('serves the last good read for 60 seconds without calling gh again', async () => {
    let tick = Date.parse('2026-11-01T05:00:00Z');
    const gh = vi.fn<CloudGh>(async args => ({
      ok: true, stderr: '',
      stdout: JSON.stringify(args.includes('open') ? [open(2461)] : [{ number: 2505, title: 'RQ-PHX-FAKE2' }]),
    }));
    const deps = { gh, prompts: async () => new Map([['RQ-PHX-FAKE2', 'PR #2461']]), now: () => new Date(tick) };
    const first = await readSuperseded(deps);
    expect(first.source).toBe('ok');
    tick += 30_000;
    expect(await readSuperseded(deps)).toBe(first);
    expect(gh).toHaveBeenCalledTimes(2);
    tick += 31_000;
    await readSuperseded(deps);
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it('scrubs secrets out of titles before they leave the module', async () => {
    const tick = Date.parse('2026-11-01T07:00:00Z');
    const gh: CloudGh = async args => ({
      ok: true, stderr: '',
      stdout: JSON.stringify(args.includes('open')
        ? [open(2461, `original ghp_${'a'.repeat(36)}`)]
        : [{ number: 2505, title: 'RQ-PHX-FAKE3' }]),
    });
    const read = await readSuperseded({ gh, prompts: async () => new Map([['RQ-PHX-FAKE3', 'PR #2461']]), now: () => new Date(tick) });
    expect(read.source).toBe('ok');
    expect(JSON.stringify(read)).not.toContain('ghp_');
  });

  it('reports unavailable when prompts cannot be read instead of an empty report', async () => {
    const tick = Date.parse('2026-11-01T09:00:00Z');
    const gh: CloudGh = async args => ({ ok: true, stderr: '', stdout: JSON.stringify(args.includes('open') ? [open(2461)] : []) });
    const read = await readSuperseded({ gh, prompts: async () => { throw new Error('fake failure'); }, now: () => new Date(tick) });
    expect(read).toMatchObject({ source: 'unavailable', pairs: [] });
  });
});

const TOKEN = 'superseded-test-token';
async function get(api: ReturnType<typeof createFleetRunsApi>, path: string): Promise<{ handled: boolean; status: number; wire: Record<string, unknown> | null }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = path;
  req.method = 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, path, 'GET');
  return { handled, status, wire };
}

describe('GET /api/verse/fleet/runs/superseded', () => {
  it('serves the injected read as JSON 200 with v 1', async () => {
    const payload: SupersededReadV1 = {
      v: 1, generatedAt: '2026-11-01T11:00:00.000Z', source: 'ok', openDirty: 1,
      pairs: [{ open: 2461, openTitle: 'original', openState: 'DIRTY', mergedBy: 2505, mergedTitle: 'recut RQ-PHX-FAKE1', jobId: 'RQ-PHX-FAKE1' }],
    };
    const { handled, status, wire } = await get(createFleetRunsApi({ readSuperseded: async () => payload }), VERSE_FLEET_SUPERSEDED_PATH);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(wire).toMatchObject({ v: 1, source: 'ok', openDirty: 1, pairs: [{ open: 2461, mergedBy: 2505, jobId: 'RQ-PHX-FAKE1' }] });
  });

  it('answers an unavailable read with the same wire shape', async () => {
    const { status, wire } = await get(createFleetRunsApi({ readSuperseded: async () => { throw new Error('fake failure'); } }), VERSE_FLEET_SUPERSEDED_PATH);
    expect(status).toBe(200);
    expect(wire).toMatchObject({ v: 1, source: 'unavailable', pairs: [], openDirty: 0 });
  });

  it('leaves other paths to the next module', async () => {
    const { handled } = await get(createFleetRunsApi({ readSuperseded: async () => { throw new Error('unreached'); } }), '/api/verse/fleet/other');
    expect(handled).toBe(false);
  });
});
