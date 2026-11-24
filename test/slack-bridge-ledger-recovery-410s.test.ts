import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const START = Date.parse('2026-11-15T06:00:00.000Z');
const FOOTER = 'Reachability only; this is not an assignment or claim.';
let directory: string;
let ledger: string;
let previousPath: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'slack-bridge-410s-'));
  ledger = join(directory, 'coordination.jsonl');
  previousPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
});

afterEach(() => {
  if (previousPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousPath;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('Slack bridge reply against the real claims ledger', () => {
  it('rereads after corruption and repair, and reports expiry without writing', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(START);
    const adapter = ownerStatusReply({
      bridge: async now => formatBridgeCheckReply(await readFleetBridgeCheck({
        runtime: async () => ({ lastFleetStateRead: { ageSeconds: 12 } }),
        peers: () => ({ status: 'ok' }),
        now: () => now.getTime(),
      }), now),
    });
    const claim = (task: string, now: number) => claimFleetWork(
      { repo: 'example/repo', task, agent: 'dot', ttlMs: 60_000 }, { now },
    );
    const replyAt = async (ms: number) => {
      clock.mockReturnValue(ms);
      const before = readFileSync(ledger);
      expect(adapter.ask('bridge?')).toBe(true);
      const reply = await adapter.compose('/fake-runs', new Date(ms), 'bridge?');
      const after = readFileSync(ledger);
      expect(reply.length).toBeLessThanOrEqual(600);
      expect(reply.split('\n').length).toBeLessThanOrEqual(6);
      expect(reply.endsWith(FOOTER)).toBe(true);
      return { reply, before, after };
    };

    expect(claim('initial', START)).toMatchObject({ ok: true });
    const initial = await replyAt(START + 10_000);
    expect(initial.after).toEqual(initial.before);
    expect(initial.reply).toContain(`Bridge: READY as of ${new Date(START + 10_000).toISOString()}`);
    expect(initial.reply).toContain('Claims: 1 live, newest 10s');

    const corrupt = 'private-corrupt-fixture-410s';
    writeFileSync(ledger, `${corrupt}\n`, { mode: 0o600 });
    const blocked = await replyAt(START + 20_000);
    expect(blocked.after).toEqual(blocked.before);
    expect(blocked.reply).toContain(`Bridge: BLOCKED as of ${new Date(START + 20_000).toISOString()} · missing claims`);
    expect(blocked.reply).toContain('Claims: unknown');
    expect(blocked.reply).not.toContain(corrupt);

    writeFileSync(ledger, '', { mode: 0o600 });
    expect(claim('recovered', START + 30_000)).toMatchObject({ ok: true });
    const recovered = await replyAt(START + 40_000);
    expect(recovered.after).toEqual(recovered.before);
    expect(recovered.reply).toContain(`Bridge: READY as of ${new Date(START + 40_000).toISOString()}`);
    expect(recovered.reply).toContain('Claims: 1 live, newest 10s');
    const expired = await replyAt(START + 90_000);
    expect(expired.reply).toContain(`Bridge: READY as of ${new Date(START + 90_000).toISOString()}`);
    expect(expired.reply).toContain('Claims: 0 live, newest unknown');
    const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string });
    // The bridge read passes reap: false, so expiry is reported and the ledger stays a claim.
    expect(events.map(event => event.kind)).toEqual(['claim']);
  });

  it('routes a separate ownership ask to the owners seam', async () => {
    const owners = vi.fn(async () => 'fixture ownership evidence');
    const bridge = vi.fn(async () => 'wrong route');
    const adapter = ownerStatusReply({ owners, bridge });
    expect(adapter.ask('who owns the bridge')).toBe(true);
    expect(await adapter.compose('/fake-runs', new Date(START), 'who owns the bridge')).toBe('fixture ownership evidence');
    expect(owners).toHaveBeenCalledExactlyOnceWith(new Date(START));
    expect(bridge).not.toHaveBeenCalled();
  });
});
