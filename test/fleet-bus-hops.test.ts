/**
 * `phm fleet bus-hops` — the CLI read of the same bounded bus hop audit
 * `fleet_bus_hops` serves over MCP. Both surfaces share
 * `src/core/fleet/bus-hops.ts`: the same argument validation, the same
 * hoplog tail window, the same filters and the same honest states. These
 * tests pin the CLI's argv mapping, its --root store isolation, its exit
 * codes and its parity with the core read; the MCP contract itself is
 * covered by fleet-mcp-bus-observation-oct31.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusHop } from '../src/core/fleet/bus-hoplog.js';
import { readBusHops } from '../src/core/fleet/bus-hops.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { cmdFleetBusHops } from '../src/cli/fleet-bus-hops.js';

let root: string;
let hopFile: string;

const hop = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  ({ id, from, to, inputTokens: null, outputTokens: null, ...extra });

function post(value: Parameters<typeof appendBusHop>[0]): void {
  expect(appendBusHop(value, hopFile)).toBe(true);
}

async function run(args: string[]) {
  const out: string[] = [], err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((text?: unknown) => { out.push(String(text)); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((text?: unknown) => { err.push(String(text)); });
  try {
    const code = await cmdFleetBusHops(args);
    return { code, out, err };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const parsed = (result: { out: string[] }) => JSON.parse(result.out[0]!) as Record<string, unknown>;
const hopIds = (result: { out: string[] }) =>
  (parsed(result)['hops'] as Array<Record<string, unknown>>).map(row => row['id']);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-hops-cli-'));
  mkdirSync(join(root, 'bus'), { mode: 0o700 });
  hopFile = join(root, 'bus', 'hops.jsonl');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('phm fleet bus-hops', () => {
  it('prints usage for --help without touching the store', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out[0]).toContain('fleet bus-hops');
  });

  it('distinguishes a missing log from an empty one without inventing activity', async () => {
    const missing = await run(['--root', root, '--json']);
    expect(missing.code).toBe(0);
    expect(parsed(missing)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'missing', hops: null, matched: null, usageSummary: null,
      returnedHops: null, skippedRows: null, truncated: null, limit: 20,
    });
    // An existing-but-empty log is verified empty, not missing.
    writeFileSync(hopFile, '', { mode: 0o600 });
    const empty = await run(['--root', root, '--json']);
    expect(empty.code).toBe(0);
    expect(parsed(empty)).toMatchObject({ sourceState: 'ok', hops: [], returnedHops: 0, skippedRows: 0 });
  });

  it('returns the newest validated hops in append order, bounded by --limit', async () => {
    for (let i = 1; i <= 5; i++) post(hop(`hop-${i}`, 'codex-cmp', 'RQ-EVENTD', { inputTokens: i }));
    const bounded = await run(['--root', root, '--limit', '2', '--json']);
    expect(bounded.code).toBe(0);
    expect(hopIds(bounded)).toEqual(['hop-4', 'hop-5']);
    expect(parsed(bounded)).toMatchObject({ returnedHops: 2, matched: 5, limit: 2, truncated: true });
    const hops = parsed(bounded)['hops'] as Array<Record<string, unknown>>;
    expect(hops[1]).toEqual({ id: 'hop-5', from: 'codex-cmp', to: 'RQ-EVENTD', inputTokens: 5, outputTokens: null });
    const all = await run(['--root', root, '--json']);
    expect(parsed(all)).toMatchObject({ returnedHops: 5, truncated: false });
  });

  it('applies the shared from/to/exclude-from/id filters with honest matched counts', async () => {
    post(hop('hop-a', 'codex-cmp', 'RQ-EVENTD'));
    post(hop('hop-b', 'claude', 'RQ-EVENTD'));
    post(hop('hop-c', 'codex-cmp', 'mason'));
    post(hop('hop-d', 'grok', 'mason'));
    expect(hopIds(await run(['--root', root, '--from', 'codex-cmp', '--json']))).toEqual(['hop-a', 'hop-c']);
    expect(hopIds(await run(['--root', root, '--to', 'mason', '--json']))).toEqual(['hop-c', 'hop-d']);
    // A sender both included and excluded matches nothing.
    const excluded = await run(['--root', root, '--from', 'codex-cmp', '--exclude-from', 'codex-cmp', '--json']);
    expect(parsed(excluded)).toMatchObject({ matched: 0, returnedHops: 0, hops: [] });
    expect(hopIds(await run(['--root', root, '--id', 'hop-b', '--json']))).toEqual(['hop-b']);
    // --id is an exact match, never a substring.
    expect(parsed(await run(['--root', root, '--id', 'hop-', '--json']))).toMatchObject({ matched: 0, hops: [] });
  });

  it('applies the channel and topic room filters like every other bus read', async () => {
    post(hop('hop-a', 'a', 'group:eng:deploy'));
    post(hop('hop-b', 'b', 'group:eng:general'));
    post(hop('hop-c', 'c', 'group:ops:deploy'));
    post(hop('hop-d', 'd', 'RQ-EVENTD'));
    post(hop('hop-e', 'e', 'group:eng'));
    expect(hopIds(await run(['--root', root, '--channel', 'eng', '--json']))).toEqual(['hop-a', 'hop-b']);
    expect(hopIds(await run(['--root', root, '--topic', 'deploy', '--json']))).toEqual(['hop-a', 'hop-c']);
    expect(hopIds(await run(['--root', root, '--channel', 'eng', '--topic', 'deploy', '--json']))).toEqual(['hop-a']);
    expect(parsed(await run(['--root', root, '--topic', 'release', '--json']))).toMatchObject({ matched: 0, hops: [] });
  });

  it('resolves address filters through the identity registry under --root', async () => {
    expect(registerAgentIdentity({ handle: 'codex-cmp', aliases: ['cmp'] }, { root }).status).toBe('created');
    post(hop('hop-a', 'codex-cmp', 'RQ-EVENTD'));
    post(hop('hop-b', 'agent:codex-cmp', 'RQ-EVENTD'));
    post(hop('hop-c', 'claude', 'RQ-EVENTD'));
    // The alias resolves to the identity, so it matches every registered label.
    expect(hopIds(await run(['--root', root, '--from', 'cmp', '--json']))).toEqual(['hop-a', 'hop-b']);
    expect(hopIds(await run(['--root', root, '--exclude-from', 'cmp', '--json']))).toEqual(['hop-c']);
  });

  it('prints the same projection the core read serves', async () => {
    post(hop('hop-a', 'codex-cmp', 'group:eng:deploy', { inputTokens: 3, outputTokens: 4 }));
    post(hop('hop-b', 'claude', 'mason'));
    const cli = await run(['--root', root, '--channel', 'eng', '--json']);
    expect(cli.code).toBe(0);
    const core = readBusHops({ channel: 'eng' }, { root });
    const { generatedAt: _cliAt, ...cliRest } = parsed(cli);
    const { generatedAt: _coreAt, ...coreRest } = core as unknown as Record<string, unknown>;
    expect(cliRest).toEqual(coreRest);
    // Pretty printing is the default; --json compacts to one line.
    const pretty = await run(['--root', root, '--channel', 'eng']);
    expect(pretty.out[0]!.includes('\n')).toBe(true);
    expect(pretty.out[0]).toBe(JSON.stringify(JSON.parse(pretty.out[0]!), null, 2));
  });

  it('reports an unreadable log as unreadable with a nonzero exit', async () => {
    post(hop('hop-1', 'a', 'b'));
    if (process.platform === 'win32') return;
    chmodSync(hopFile, 0o644);
    const result = await run(['--root', root, '--json']);
    expect(result.code).toBe(1);
    expect(parsed(result)).toMatchObject({ sourceState: 'unreadable', hops: null });
  });

  it('rejects malformed arguments before touching the store', async () => {
    for (const bad of [
      ['--limit'], ['--limit', '--json'], ['--limit', '0'], ['--limit', '51'],
      ['--limit', '1.5'], ['--limit', 'abc'], ['--limit', '2', '--limit', '3'],
      ['--from'], ['--from', '--json'], ['--from', 'has space'], ['--from', ''],
      ['--to', 'a b'], ['--exclude-from'], ['--id', 'x'.repeat(129)],
      ['--channel', 'Bad Room'], ['--channel', ''], ['--topic', 'UPPER'],
      ['--root'], ['--root', 'relative'], ['--root', root, '--root', root],
      ['--json', '--json'], ['--unknown'], ['hops'], ['--since', '15m'],
    ]) {
      const result = await run(bad);
      expect(result.code, JSON.stringify(bad)).toBe(2);
    }
  });
});
