import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIdleLanes } from '../src/cli/fleet-idle-lanes.js';

const base = { held: false, running: 4, target: 8, queued: 11 };

afterEach(() => vi.restoreAllMocks());

async function run(lanes: unknown, json = true) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const paths: string[] = [];
  const reader = vi.fn(async (path: string) => {
    paths.push(path.split('/').at(-1)!);
    if (path.endsWith('/status.json')) return JSON.stringify({ lanes });
    if (path.endsWith('/jobs.jsonl')) return '';
    throw new Error('unexpected read');
  });
  const exit = await cmdFleetIdleLanes(json ? ['--json'] : [], reader);
  const output = String(log.mock.calls.at(-1)?.[0]);
  log.mockRestore();
  return { exit, output, paths, reader };
}

describe('original #7360 idle-lane preservation at the command boundary', () => {
  it('suppresses shed-full, shed-zero, and empty queues', async () => {
    const result = await run({
      full: { ...base, running: 5, effective_target: 5 },
      zero: { ...base, running: 0, effective_target: 0 },
      empty: { ...base, queued: 0 },
      heldEmpty: { ...base, held: true, queued: 0 },
    });
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.output).lanes).toEqual([]);
    expect(result.paths).toEqual(['status.json', 'jobs.jsonl']);
  });

  it('reports actual shed room red with the effective target and exit 1 in JSON and text', async () => {
    const lanes = { room: { ...base, effective_target: 5 } };
    const json = await run(lanes);
    expect(json.exit).toBe(1);
    expect(JSON.parse(json.output).lanes).toEqual([
      { lane: 'room', status: 'red', running: 4, target: 5, queued: 11 },
    ]);
    const text = await run(lanes, false);
    expect(text.exit).toBe(1);
    expect(text.output).toBe('red: room: 4/5 running, 11 queued');
  });

  it('reports held queued work as warn even above the shed ceiling, with exit 0', async () => {
    const lanes = { held: { ...base, held: true, running: 9, effective_target: 5 } };
    const json = await run(lanes);
    expect(json.exit).toBe(0);
    expect(JSON.parse(json.output).lanes).toEqual([
      { lane: 'held', status: 'warn', running: 9, target: 5, queued: 11 },
    ]);
    const text = await run(lanes, false);
    expect(text.exit).toBe(0);
    expect(text.output).toBe('warn: held: 9/5 running, 11 queued');
  });

  it('falls back to configured target for null and malformed optional readings', async () => {
    for (const value of [null, -1, 0.5, '6', true]) {
      const result = await run({ fallback: { ...base, effective_target: value } });
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.output).lanes).toEqual([
        { lane: 'fallback', status: 'red', running: 4, target: 8, queued: 11 },
      ]);
    }
  });

  it.each(['running', 'target', 'queued'])('rejects invalid required %s with exit 2', async field => {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      const result = await run({ invalid: { ...base, [field]: value } });
      expect(result.exit).toBe(2);
      expect(JSON.parse(result.output).error).toContain('Cannot read lane status');
      expect(result.paths).toEqual(['status.json']);
    }
  });
});
