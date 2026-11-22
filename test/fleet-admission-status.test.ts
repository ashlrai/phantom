import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { admissionStatus, readFleetStartStatus } from '../src/core/fleet/admission-status.js';
import { cmdFleetAdmission } from '../src/cli/fleet-admission.js';
import { createFleetMemoryApi } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const now = 1795350000 * 1000;
const fixture = (name: string) => readFile(new URL(`./fixtures/fleet-admission/${name}.json`, import.meta.url), 'utf8');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['blocked', 'settling', 'open'] as const)('projects the %s fixture and the pacing cap', async state => {
  const text = await fixture(state), report = admissionStatus(text, now);
  expect(report).toMatchObject({ state, startsPerHourCap: 12, settle_s: 300, total_running: 10, max_total_running: 48,
    load1: state === 'blocked' ? 77 : 12, load5: state === 'blocked' ? 60 : 10, owned_load1: 0.7,
    last_admit: state === 'open' ? 1795349400 : 1795349940, ts: 1795350000,
    nextStartSeconds: state === 'open' ? 0 : 240 });
  expect(report.summary).toContain('10 of 48 running');
  expect(report.summary).not.toContain('\n');
  if (state === 'blocked') expect(report.summary).toBe('starts blocked: host busy (load 77, fleet owns 0.7) · pacing window in ~4 min · 10 of 48 running');
  if (state === 'settling') expect(report.summary).toContain('next start in ~4 min');
  if (state === 'open') expect(report.summary).toContain('starts open: guard allows a start');
});

it('keeps missing, stale, future, incomplete and invalid files unknown without echoing content', async () => {
  const text = await fixture('open');
  for (const [input, time] of [[null, now], [text, now + 300_001], [text, now - 1], ['{}', now], ['[]', now], ['PRIVATE', now]] as const) {
    const report = admissionStatus(input, time);
    expect(report.state).toBe('unknown');
    expect(report.startsPerHourCap).toBeNull();
    expect(report.summary).toContain('starts unknown:');
    expect(report.summary).not.toContain('PRIVATE');
  }
  expect(admissionStatus(text, now + 300_001).reason).toContain('older than 5 min');
  expect(admissionStatus(text, now + 300_000).state).toBe('open');
  expect((await readFleetStartStatus({ read: async () => { throw Error('PRIVATE'); } })).reason).toContain('missing or unreadable');
});

it('never treats a positive settle setting alone as waiting, or a full cap as open', async () => {
  const raw = JSON.parse(await fixture('open'));
  expect(admissionStatus(JSON.stringify({ ...raw, total_running: 48 }), now).reason).toBe('running limit reached');
  expect(admissionStatus(JSON.stringify({ ...raw, why: 'PRIVATE' }), now).state).toBe('blocked');
  expect(admissionStatus(JSON.stringify({ ...raw, why: 'PRIVATE' }), now).summary).not.toContain('PRIVATE');
  expect(admissionStatus(JSON.stringify({ ...raw, settle_s: 0 }), now).startsPerHourCap).toBeNull();
});

it('serves the identical reader through default CLI, JSON and the GET-only local API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admit-panel-'));
  try {
    const path = join(dir, 'guard.json'), text = await fixture('blocked');
    await writeFile(path, text);
    vi.stubEnv('ASHLR_ADMISSION_CTL_PATH', path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetAdmission([], undefined, now)).toBe(1);
    expect(log).toHaveBeenLastCalledWith(admissionStatus(text, now).summary);
    expect(await cmdFleetAdmission(['--json'], undefined, now)).toBe(1);
    const cli = JSON.parse(log.mock.calls.at(-1)![0]);
    let body = '', code = 0;
    const res = { writeHead(status: number) { code = status; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    const api = createFleetMemoryApi({ now: () => now });
    const call = (method: string) => api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/admission', method);
    expect(await call('GET')).toBe(true);
    expect(code).toBe(200);
    expect(JSON.parse(body)).toEqual(cli);
    expect(cli).toEqual(await readFleetStartStatus({ now }));
    expect(await call('POST')).toBe(true);
    expect(code).toBe(405);
    expect(await readFile(path, 'utf8')).toBe(text);
    await rm(path);
    expect(await cmdFleetAdmission(['--json'], undefined, now)).toBe(2);
    expect(JSON.parse(log.mock.calls.at(-1)![0]).state).toBe('unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
