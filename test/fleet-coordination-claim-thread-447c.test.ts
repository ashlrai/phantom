import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { claimNoticeDir, claimNoticePaths, readClaimThreadBindings } from '../src/core/fleet/claim-notice-send.js';
import { readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';

const thread = 'T0FAKE01/C0FAKE01/1700000000.000100';
const now = 1_700_000_000_000;
const args = ['claim', '--repo', 'fake-owner/fake-repo', '--task', 'Fake Slack request', '--agent', 'fake-agent', '--json'];

describe('coordination claim --thread (447c)', () => {
  let dir: string, ledger: string, runsRoot: string;
  const bindings = () => claimNoticePaths(claimNoticeDir(runsRoot)).bindings;
  const invoke = (extra: string[] = []) => cmdFleetCoordination([...args, ...extra], { runsRoot, now: () => now });
  const output = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-thread-447c-'));
    ledger = join(dir, 'ledger', 'coordination.jsonl');
    runsRoot = join(dir, 'runs');
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([thread, 'slack:T0FAKE01:C0FAKE01:1700000000.000100'])('claims and binds %s in one output', async threadKey => {
    expect(await invoke(['--thread', threadKey])).toBe(0);
    const result = output();
    expect(result).toMatchObject({ ok: true, threadBinding: { ok: true, status: 'bound' } });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(readClaimThreadBindings(bindings())).toEqual([
      { claimId: result.value.claim.id, repo: result.value.claim.repo, threadKey },
    ]);
    const rows = readFileSync(bindings(), 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({ at: now });
    expect(readFileSync(bindings(), 'utf8')).not.toContain(result.value.lease);
    expect(readFleetBoard().claims).toEqual([result.value.claim]);
  });

  it('rejects an invalid thread before touching the ledger', async () => {
    expect(await invoke(['--thread', 'fake-invalid-thread'])).toBe(2);
    expect(console.error).toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(readFleetBoard().claims).toEqual([]);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(bindings())).toBe(false);
  });

  it('preserves the original output without --thread and writes no binding', async () => {
    expect(await invoke()).toBe(0);
    expect(output()).not.toHaveProperty('threadBinding');
    expect(Object.keys(output()).sort()).toEqual(['ok', 'value']);
    expect(readFleetBoard().claims).toEqual([output().value.claim]);
    expect(existsSync(bindings())).toBe(false);
  });

  it('keeps the claim and usable lease when binding is refused', async () => {
    writeFileSync(runsRoot, 'fake regular file');
    expect(await invoke(['--thread', thread])).toBe(1);
    const result = output();
    expect(result).toMatchObject({ ok: true, threadBinding: { ok: false, reason: 'bindings-dir-unusable' } });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(readFleetBoard().claims).toEqual([result.value.claim]);
    expect(result.value.lease).toEqual(expect.any(String));
    expect(releaseFleetClaim({ id: result.value.claim.id, agent: 'fake-agent', lease: result.value.lease }).ok).toBe(true);
    expect(existsSync(bindings())).toBe(false);
  });

  it('does not bind when the claim fails', async () => {
    expect(await invoke()).toBe(0);
    vi.mocked(console.log).mockClear();
    expect(await invoke(['--thread', thread])).toBe(1);
    expect(output()).toEqual({ ok: false, error: 'duplicate' });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(readFleetBoard().claims).toHaveLength(1);
    expect(existsSync(bindings())).toBe(false);
  });
});
