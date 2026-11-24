import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetReturnsCheck } from '../src/cli/fleet-returns-check.js';
import { readFleetBoard, type FleetMessage } from '../src/core/fleet/coordination.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function receipt(pr: number, kind = `pr #${pr} head abc1234`): FleetMessage {
  return { id: `return-fake-${pr}`, from: 'fake-agent', to: 'all', at: 1_000 + pr, expiresAt: 20_000,
    body: `RESULT VERIFIED fake/repo claim fake-${pr} task "Fake task ${pr}": ${kind}` };
}

function fixture(messages: FleetMessage[]) {
  const root = mkdtempSync(join(tmpdir(), 'returns-projection-548s-'));
  dirs.push(root);
  for (const key of ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_ROOT']) vi.stubEnv(key, root);
  const path = join(root, 'ledger.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  // Real private disk ledger, using the public post event schema; no reader mocks.
  writeFileSync(path, messages.map(message => JSON.stringify({ version: 1, kind: 'post', at: message.at, message }) + '\n').join(''), { mode: 0o600 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh = vi.fn(async (args: string[]) => {
    expect(args.at(-1)).toMatch(/^repos\/fake\/repo\/pulls\/\d+$/);
    return JSON.stringify({ merged: true, head: { sha: 'abc1234abcdef000000000000000000000000000' } });
  });
  async function run(code: number, json = true, limit = 50) {
    log.mockClear();
    gh.mockClear();
    const bytes = readFileSync(path);
    const before = statSync(path, { bigint: true });
    expect(await cmdFleetReturnsCheck([...(json ? ['--json'] : []), '--limit', String(limit)],
      { gh, now: () => 5_000 })).toBe(code);
    expect(readFileSync(path)).toEqual(bytes);
    const after = statSync(path, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
    return log.mock.calls.map(call => String(call[0])).join('\n');
  }
  return { path, gh, run };
}

it('fails full verification when the newest 50 hide one older conflicting PR receipt', async () => {
  const messages = Array.from({ length: 51 }, (_, i) => receipt(i + 1));
  messages[0] = receipt(1, 'pr #1 head deadbee');
  const { path, gh, run } = fixture(messages);
  const report = JSON.parse(await run(1));
  expect(report).toMatchObject({ returnsState: 'known', truncated: false, skipped: 0,
    projectionCoverage: { parsedTotal: 51, omitted: 1, unparsed: 0 } });
  expect(report.checked).toHaveLength(50);
  expect(report.checked.every((row: { verdict: string }) => row.verdict === 'merged-at-head')).toBe(true);
  expect(report.checked.map((row: { pr: number }) => row.pr)).toEqual(Array.from({ length: 50 }, (_, i) => 51 - i));
  expect(gh).toHaveBeenCalledTimes(50);
  const text = await run(1, false);
  expect(text).toContain('projection coverage: parsed-total=51 omitted=1 unparsed=0');
  expect(text).toContain('projection omitted parsed return evidence');
  expect(text).toContain('truncated=no');
  // Make the hidden contradiction visible in the same real ledger.
  writeFileSync(path, JSON.stringify({ version: 1, kind: 'post', at: messages[0]!.at, message: messages[0] }) + '\n');
  expect(JSON.parse(await run(1)).checked[0].verdict).toBe('merged-other-head');
});

it('succeeds with 50 matching rows, preserving row keys, JSON qualification and newest-first display', async () => {
  const { path, gh, run } = fixture(Array.from({ length: 50 }, (_, i) => receipt(i + 1)));
  const report = JSON.parse(await run(0));
  expect(report).toMatchObject({ truncated: false, projectionCoverage: { parsedTotal: 50, omitted: 0, unparsed: 0 } });
  expect(gh).toHaveBeenCalledTimes(50);
  const board = readFleetBoard({ path, now: 0, reap: false });
  const before = JSON.stringify(board);
  const view = projectCoordinationReturns(board, 5_000);
  expect(Object.keys(view.returns[0]!).sort()).toEqual([
    'claimId', 'repo', 'result', 'evidenceKind', 'pr', 'head', 'evidence', 'from', 'at', 'expiresAt',
  ].sort());
  expect(report.receipts[0]).toMatchObject({ pr: 50, temporal: 'current' });
  expect(JSON.stringify(board)).toBe(before);
});

it('reports malformed return-prefixed evidence independently of checker truncation', async () => {
  const malformed = { ...receipt(2), body: 'malformed fake receipt' };
  const { run } = fixture([receipt(1), malformed]);
  expect(JSON.parse(await run(1))).toMatchObject({ truncated: false,
    projectionCoverage: { parsedTotal: 1, omitted: 0, unparsed: 1 }, checked: [{ verdict: 'merged-at-head' }] });
  const text = await run(1, false);
  expect(text).toContain('projection coverage: parsed-total=1 omitted=0 unparsed=1');
  expect(text).toContain('return-prefixed messages could not be parsed');
  expect(text).toContain('truncated=no');
});

it('ignores ordinary messages and distinguishes the GitHub checker limit', async () => {
  const ordinary = { ...receipt(3), id: 'ordinary', body: 'ordinary fake message' };
  const { run } = fixture([receipt(1), receipt(2), ordinary]);
  expect(JSON.parse(await run(0))).toMatchObject({ truncated: false,
    projectionCoverage: { parsedTotal: 2, omitted: 0, unparsed: 0 } });
  expect(JSON.parse(await run(1, true, 1))).toMatchObject({ truncated: true, skipped: 1,
    projectionCoverage: { parsedTotal: 2, omitted: 0, unparsed: 0 } });
  const text = await run(1, false, 1);
  expect(text).toContain('projection coverage: parsed-total=2 omitted=0 unparsed=0');
  expect(text).toContain('truncated=yes');
  expect(text).toContain('the limit prevented checking all eligible PR returns');
});

it('counts omitted non-PR evidence too', async () => {
  const messages = [receipt(1, 'tests fake tests passed'), ...Array.from({ length: 50 }, (_, i) => receipt(i + 2))];
  const { run } = fixture(messages);
  expect(JSON.parse(await run(1))).toMatchObject({ truncated: false,
    projectionCoverage: { parsedTotal: 51, omitted: 1, unparsed: 0 } });
});

it('keeps empty evidence successful and unreadable coverage unknown without GitHub reads', async () => {
  const { path, gh, run } = fixture([]);
  expect(JSON.parse(await run(0))).toMatchObject({ returnsState: 'known',
    projectionCoverage: { parsedTotal: 0, omitted: 0, unparsed: 0 } });
  expect(gh).not.toHaveBeenCalled();
  writeFileSync(path, 'invalid ledger\n');
  expect(JSON.parse(await run(1))).toMatchObject({ returnsState: 'unknown', checked: [],
    projectionCoverage: { parsedTotal: null, omitted: null, unparsed: null } });
  expect(gh).not.toHaveBeenCalled();
  const text = await run(1, false);
  expect(text).toContain('returns: unknown');
  expect(text).toContain('projection coverage: parsed-total=unknown omitted=unknown unparsed=unknown');
  expect(projectCoordinationReturns(null, 5_000).coverage).toEqual({ parsedTotal: null, matched: null, omitted: null, unparsed: null });
});
