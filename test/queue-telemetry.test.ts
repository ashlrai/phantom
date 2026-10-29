import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { QueueEventV1 } from '../src/core/observability/queue-events.js';

const config = vi.hoisted(() => ({ telemetry: {} as AshlrConfig['telemetry'] }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => config }));
const credentialSpawn = vi.hoisted(() => vi.fn(() => { throw new Error('credential subprocess forbidden'); }));
vi.mock('node:child_process', () => ({ spawn: credentialSpawn, spawnSync: credentialSpawn }));

import { cmdTelemetry } from '../src/cli/telemetry.js';
import { buildQueueTrace } from '../src/core/observability/otlp.js';
import { getQueueSink, localTelemetryDir } from '../src/core/observability/telemetry-sink.js';

const fixture = new URL('./fixtures/queue-events/replay.json', import.meta.url);
const event: QueueEventV1 = {
  job_id: 'RQ-QUEUE-1', pr: null, station: 'work', pool: 'codex-cmp', tier: 'work',
  enter_ts: '2026-10-26T12:00:00.000Z', exit_ts: null,
};
const cfg = (): AshlrConfig => config as AshlrConfig;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'queue-telemetry-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('ASHLR_PULSE_TOKEN', '');
  config.telemetry = {};
  credentialSpawn.mockClear();
});
afterEach(() => {
  expect(credentialSpawn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('queue telemetry existing sink path', () => {
  it('persists a named event with exactly the wire properties in its own local stream', async () => {
    expect(await getQueueSink(cfg()).emit([{ ...event, prompt: 'private task content' } as QueueEventV1])).toMatchObject({ ok: true, sink: 'local' });
    const files = readdirSync(localTelemetryDir());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^queue-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const record = JSON.parse(readFileSync(join(localTelemetryDir(), files[0]), 'utf8'));
    expect(record).toEqual({ event: 'queue.v1', properties: event });
  });

  it('does no local IO for an empty batch', async () => {
    expect(await getQueueSink(cfg()).emit([])).toEqual({ sink: 'local', ok: true, detail: 'no events' });
    expect(readdirSync(home)).toEqual([]);
  });

  it('reports a local write error without disclosing its path or exception', async () => {
    writeFileSync(join(home, '.ashlr'), 'not a directory');
    expect(await getQueueSink(cfg()).emit([event])).toEqual({ sink: 'local', ok: false, detail: 'queue telemetry write failed' });
  });

  it('uses existing OTLP credentials and never places credentials or content in the payload', async () => {
    config.telemetry.pulse = 'https://telemetry.example.test/v1/traces';
    vi.stubEnv('ASHLR_PULSE_TOKEN', 'synthetic-queue-test-credential');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetch);
    const events = [event, { ...event, pr: 42, exit_ts: '2026-10-26T12:01:00.000Z' }];
    expect(await getQueueSink(cfg()).emit(events)).toEqual({ sink: 'otlp', ok: true, detail: 'HTTP 202' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, request] = fetch.mock.calls[0];
    expect(endpoint).toBe(config.telemetry.pulse);
    expect(request.headers.Authorization).toBe('Bearer synthetic-queue-test-credential');
    expect(request.redirect).toBe('error');
    expect(request.body).not.toContain('synthetic-queue-test-credential');
    const spans = JSON.parse(request.body).resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((span: { name: string }) => span.name)).toEqual(['queue.v1', 'queue.v1']);
    expect(spans[0].startTimeUnixNano).toBe('1793016000000000000');
    expect(Object.fromEntries(spans[1].attributes.map((attr: { key: string; value: unknown }) => [attr.key, attr.value]))).toEqual({
      'event.name': { stringValue: 'queue.v1' }, job_id: { stringValue: 'RQ-QUEUE-1' }, pr: { intValue: '42' },
      station: { stringValue: 'work' }, pool: { stringValue: 'codex-cmp' }, tier: { stringValue: 'work' },
      enter_ts: { stringValue: event.enter_ts }, exit_ts: { stringValue: events[1].exit_ts },
    });
  });

  it('preserves sink selection and makes missing remote credentials an explicit failure', async () => {
    config.telemetry.pulse = 'https://telemetry.example.test/v1/traces';
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await getQueueSink(cfg(), false).emit([event])).toEqual({ sink: 'otlp', ok: false, detail: 'PAT unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await getQueueSink(cfg()).emit([event])).toMatchObject({ sink: 'local', ok: true });
  });

  it('keeps remote failure output value blind', async () => {
    config.telemetry.pulse = 'https://telemetry.example.test/v1/traces';
    vi.stubEnv('ASHLR_PULSE_TOKEN', 'synthetic-queue-test-credential');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic-queue-test-credential')));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await getQueueSink(cfg()).emit([event])).toEqual({ sink: 'otlp', ok: false, detail: 'telemetry request failed' });
    expect(stderr.mock.calls.flat().join('')).not.toContain('synthetic-queue-test-credential');
  });

  it('builds point boundaries without inventing PRs, exits, usage or spend', () => {
    const spans = buildQueueTrace([event]).resourceSpans[0].scopeSpans[0].spans;
    expect(spans[0].endTimeUnixNano).toBe(spans[0].startTimeUnixNano);
    expect(spans[0].attributes.map(attr => attr.key)).toEqual(['event.name', 'job_id', 'station', 'pool', 'tier', 'enter_ts']);
  });
});

describe('telemetry queue-replay CLI', () => {
  it('replays the checked-in fixture through the actual local sink, in order', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdTelemetry(['queue-replay', fixture.pathname, '--json'])).toBe(0);
    const expected = JSON.parse(readFileSync(fixture, 'utf8'));
    const report = JSON.parse(String(stdout.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({ ok: true, sink: 'local', events: expected.length });
    const records = readFileSync(join(localTelemetryDir(), readdirSync(localTelemetryDir())[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toEqual(expected.map((properties: QueueEventV1) => ({ event: 'queue.v1', properties })));
  });

  it.each([[], ['--unknown'], ['one.json', 'two.json']])('rejects invalid replay arguments %j', async (...args) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdTelemetry(['queue-replay', ...args, '--json'])).toBe(2);
    expect(readdirSync(home)).toEqual([]);
  });

  it.each(['{}', '[]', 'not-json', JSON.stringify([event, { ...event, prompt: 'private' }]), JSON.stringify(Array(1001).fill(event)), ' '.repeat(256 * 1024 + 1)])('rejects malformed or unbounded fixtures before any emission (%#)', async contents => {
    const file = join(home, 'bad.json'); writeFileSync(file, contents);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdTelemetry(['queue-replay', file, '--json'])).not.toBe(0);
    expect(readdirSync(home)).toEqual(['bad.json']);
  });

  it('reports unavailable credentials rather than claiming replay delivery', async () => {
    config.telemetry.pulse = 'https://telemetry.example.test/v1/traces';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cmdTelemetry(['queue-replay', fixture.pathname, '--json'])).toBe(1);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)![0]))).toMatchObject({ ok: false, sink: 'otlp', detail: 'PAT unavailable' });
  });
});
