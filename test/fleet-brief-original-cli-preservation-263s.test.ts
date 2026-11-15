// Preserves #4355's (RQ-PHX-LEADERBRIEFCORE13) test/fleet-brief-cli.test.ts
// regression on today's contract: `ashlr fleet brief` JSON/plain output through
// the real cmdFleetBrief with every reader injected, a fixed clock and a
// captured console. No HOME, network, runtime state or live transport is used.
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBrief } from '../src/cli/fleet-brief.js';
import { readLeaderBrief, type BriefReaders } from '../src/core/fleet/leader-brief.js';

afterEach(() => vi.restoreAllMocks());

const read = (readers: BriefReaders) => () => readLeaderBrief({ readers, now: () => 0 });

// The original fixture, unchanged from refs/pr/4355 @ 8e7cef99cc.
it('prints the original fixture readings as JSON and plain text', async () => {
  const fixture: BriefReaders = {
    fleet: () => ({ merges24h: 3, openPrs: 7 }),
    installed: () => '1.0.0',
    latest: () => '1.1.0',
    needsMason: () => 2,
    goals: () => [],
    lanes: () => ['codex 1/2'],
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], read(fixture))).toBe(0);
  const brief = JSON.parse(log.mock.calls[0]![0] as string);
  expect(brief).toMatchObject({
    at: '1970-01-01T00:00:00.000Z',
    merges24h: 3, openPrs: 7, needsMason: 2,
    release: { installed: '1.0.0', latest: '1.1.0', behind: true },
    goals: [], lanes: ['codex 1/2'],
  });
  expect(await cmdFleetBrief([], read(fixture))).toBe(0);
  const text = log.mock.calls[1]![0] as string;
  expect(text).toContain('codex 1/2');
  expect(text).toContain('Merges (24h): 3; open PRs: 7');
  expect(text).toContain('Needs Mason: 2');
  expect(text).toContain('Goals: none');
});

// Unavailable readings degrade to unknown through the same command — never an
// invented zero, never a fabricated "not behind", never a live transport call.
it('keeps every reading unknown when all injected readers are unavailable', async () => {
  const send = vi.spyOn(globalThis, 'fetch');
  const unavailable: BriefReaders = {
    fleet: () => { throw new Error('fleet snapshot unavailable'); },
    installed: () => null,
    latest: () => { throw new Error('release feed unavailable'); },
    needsMason: () => null,
    goals: () => { throw new Error('goals store unavailable'); },
    lanes: () => null,
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBrief(['--json'], read(unavailable))).toBe(0);
  const brief = JSON.parse(log.mock.calls[0]![0] as string);
  expect(brief).toMatchObject({
    at: '1970-01-01T00:00:00.000Z',
    merges24h: null, openPrs: null, needsMason: null,
    release: { installed: null, latest: null, behind: null },
    goals: [], lanes: [],
  });
  expect(await cmdFleetBrief([], read(unavailable))).toBe(0);
  expect(log.mock.calls[1]![0]).toBe([
    'Merges (24h): unknown; open PRs: unknown',
    'Release: installed unknown; latest published unknown',
    'Needs Mason: unknown',
    'Goals: unknown',
    'Lanes: unknown',
  ].join('\n'));
  expect(send).not.toHaveBeenCalled();
});
