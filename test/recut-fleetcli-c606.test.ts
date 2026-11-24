import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetEmpties } from '../src/cli/fleet-empties.js';

afterEach(() => vi.restoreAllMocks());

describe('C606 fleet empties handler', () => {
  it('distinguishes missing evidence from measured zero through the injected reader', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(await cmdFleetEmpties(['--json'], async () => null, now)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ known: false });
    expect(await cmdFleetEmpties(['--json'], async () => '', now)).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      schema: 'fleet.empties.v2', known: true, finished: 0, measured: 0, total: 0,
    });
  });

  it('rejects conflicting output flags before reading evidence', async () => {
    const read = vi.fn(async () => '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetEmpties(['--json', '--human'], read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
