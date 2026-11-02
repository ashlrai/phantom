import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCodexSessionUsages, CODEX_USAGE_STALE_MS, type CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { FleetRunsV1 } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => '/fake-personal-weekly-home' }));
vi.mock('../src/core/fleet/codex-session-usage.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/codex-session-usage.js')>(),
  collectCodexSessionUsages: vi.fn(),
}));
const NOW = Date.parse('2026-10-31T12:00:00Z');
const RESET = '2026-11-06T12:00:00.000Z';
function usage(over: Partial<CodexSessionUsage> = {}): CodexSessionUsage {
  return {
    // The deduplicated first slot is labelled CMP even though its home is personal.
    accountId: 'codex-cmp', slot: 'primary', observedAt: new Date(NOW - 60_000).toISOString(),
    planType: null, limitId: null, limitName: null, rateLimitReachedType: null,
    spendControlReached: null, individualLimit: null, model: null, originator: null, cliVersion: null,
    primary: { usedPercent: 99, windowMinutes: 300, resetsAt: (NOW + 3_600_000) / 1000 },
    secondary: { usedPercent: 85, windowMinutes: 10080, resetsAt: Date.parse(RESET) / 1000 },
    credits: null, ...over,
  };
}
async function snapshot(): Promise<FleetRunsV1> {
  const fail = async () => { throw new Error('fake unavailable source'); };
  const api = createFleetRunsApi({ now: () => NOW, readRunsDir: fail, listWorkers: fail,
    readInbox: async () => [], mergedLastHour: async () => ({ count: null, items: [] }),
    readHostLoad: () => ({ load1: null, load5: null, load15: null, cores: null, ratio: null }),
  });
  let body = '';
  const response = { writeHead: vi.fn(), end(text: string) { body = text; } } as unknown as ServerResponse;
  expect(await api({} as VerseApiContext, Readable.from([]) as unknown as IncomingMessage,
    response, VERSE_FLEET_RUNS_PATH, 'GET')).toBe(true);
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.anything());
  const personalHome = join('/fake-personal-weekly-home', '.codex-2');
  expect(collectCodexSessionUsages).toHaveBeenCalledExactlyOnceWith({
    env: { CODEX_HOME: personalHome, CODEX_HOME_ALT: personalHome }, homeDir: '/fake-personal-weekly-home',
  });
  const targets = Object.values(vi.mocked(collectCodexSessionUsages).mock.calls[0]![0]!.env!);
  expect(targets.every(target => typeof target === 'string' && !target.split(/[\\/]/).includes('.codex'))).toBe(true);
  return JSON.parse(body) as FleetRunsV1;
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('personal weekly meter through the default fleet API reader', () => {
  it('uses weekly 85 rather than session 99 and preserves the wire fields', async () => {
    vi.stubEnv('CODEX_HOME', '/fake-inherited-cmp');
    vi.stubEnv('CODEX_HOME_ALT', '/fake-inherited-other');
    vi.mocked(collectCodexSessionUsages).mockReturnValue([usage()]);
    const result = await snapshot();
    expect(result.sources.codex).toBe('healthy');
    expect(result.codexPersonal).toEqual({ usedPct: 85, resetsAt: RESET, asOf: new Date(NOW - 60_000).toISOString() });
  });
  it.each([
    ['missing weekly', [usage({ secondary: null })]],
    ['stale reading', [usage({ observedAt: new Date(NOW - CODEX_USAGE_STALE_MS - 1).toISOString() })]],
    ['no account', []],
    ['future reading', [usage({ observedAt: new Date(NOW + 1).toISOString() })]],
    ['undated reading', [usage({ observedAt: null })]],
    ['short secondary window', [usage({ secondary: { usedPercent: 85, windowMinutes: 300, resetsAt: null } })]],
  ] satisfies [string, CodexSessionUsage[]][] )('keeps %s unknown without a session or CMP fallback', async (_name, readings) => {
    vi.mocked(collectCodexSessionUsages).mockReturnValue(readings);
    const result = await snapshot();
    expect(result.codexPersonal).toBeNull();
    expect(result.sources.codex).toBe('missing');
  });
});
