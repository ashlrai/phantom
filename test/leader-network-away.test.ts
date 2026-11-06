import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderNetwork, LEADER_AWAY_MS } from '../src/core/agents/leader-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'leader-away-')); roots.push(runsDir);
  let clock = Date.parse('2026-01-01T12:00:00Z');
  return { options: { runsDir, busRoot: join(runsDir, 'bus'), configSource: '[mason]\nidentities = [{channel="telegram",id="synthetic-owner"},{channel="email",id="synthetic-owner"}]\n[team]\nidentities = [{channel="telegram",id="synthetic-owner"},{channel="email",id="synthetic-owner"}]', commsSource: 'confirmedByMason = true', now: () => clock }, advance: (ms: number) => { clock += ms; } };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('leader away mode', { timeout: 20000 }, () => {
  it('continues planning and sends one digest per verified channel per day after exactly 72 hours', async () => {
    const { options, advance } = fixture();
    const messages: BusEnvelope[] = [];
    const deliver = async (_identity: unknown, message: BusEnvelope) => { messages.push(message); return { status: 'sent' as const, reason: 'Synthetic delivery' }; };
    let planned = 0;
    const plan = async () => { planned++; };
    const network = createLeaderNetwork({ ...options, deliver });
    expect(await network.tick('Synthetic fleet digest', plan)).toMatchObject({ away: false, sent: 0 });
    advance(LEADER_AWAY_MS - 1);
    expect(await network.tick('Synthetic fleet digest', plan)).toMatchObject({ away: false, sent: 0 });
    advance(1);
    expect(await network.tick('Synthetic fleet digest', plan)).toMatchObject({ away: true, sent: 2, pending: 0 });
    expect(await createLeaderNetwork({ ...options, deliver }).tick('Synthetic later digest', plan)).toMatchObject({ away: true, sent: 0 });
    expect(messages).toHaveLength(2);
    expect(messages.every(message => message.external === false && message.body && typeof message.body === 'object' && !Array.isArray(message.body) && message.body.text === 'Leader: Synthetic fleet digest')).toBe(true);
    advance(24 * 60 * 60 * 1000);
    expect(await network.tick('Synthetic next digest', plan)).toMatchObject({ away: true, sent: 2 });
    expect(planned).toBe(5);
  });
  it('resets activity only for a fresh verified owner message; retries do not extend presence', async () => {
    const { options, advance } = fixture();
    const network = createLeaderNetwork(options);
    await network.tick('Synthetic digest');
    advance(LEADER_AWAY_MS);
    const message: BusEnvelope = { id: 'synthetic-message', from: 'fixture', to: 'all', priority: 'P3', ttl: 1000, body: 'Synthetic return message', channel: 'telegram', channel_ref: 'synthetic-thread', sender: { agent_id: 'fixture', vendor: 'fixture', human: true, team: true }, external: false };
    await network.ingest({ message, verifiedSender: { channel: 'telegram', id: 'synthetic-owner' } });
    expect(await network.tick('Synthetic digest')).toMatchObject({ away: false });
    advance(LEADER_AWAY_MS);
    await network.ingest({ message, verifiedSender: { channel: 'telegram', id: 'synthetic-owner' } });
    expect(await network.tick('Synthetic digest')).toMatchObject({ away: true });
  });
  it('keeps planning with denied sends and damaged receipts, without treating corrupt evidence as absence', async () => {
    const { options, advance } = fixture();
    const service = createLeaderNetwork({ ...options, commsSource: '', deliver: async () => { throw new Error('Must not send'); } });
    await service.tick('Synthetic digest');
    advance(LEADER_AWAY_MS);
    expect(await service.tick('Synthetic digest')).toMatchObject({ away: true, sent: 0, pending: 2 });
    const file = join(options.runsDir, 'leader/network-state.json');
    const previous = readFileSync(file, 'utf8');
    writeFileSync(file, '{invalid');
    let planned = false;
    expect(await service.tick('Synthetic digest', async () => { planned = true; })).toMatchObject({ away: null, planning: 'completed', sent: 0, pending: 1 });
    expect(planned).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('{invalid');
    expect(previous.length).toBeGreaterThan(0);
  });
});


describe('away mode damaged evidence', { timeout: 20000 }, () => {
  it('fails closed on primitive receipt maps and clock rollback', async () => {
    const { options, advance } = fixture();
    const service = createLeaderNetwork(options);
    await service.tick('Synthetic digest');
    const file = join(options.runsDir, 'leader/network-state.json');
    const previous = readFileSync(file, 'utf8');
    const corrupt = { ...JSON.parse(previous), routes: 1 };
    writeFileSync(file, JSON.stringify(corrupt));
    expect(await service.tick('Synthetic digest')).toMatchObject({ sent: 0, pending: 1 });
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(corrupt));
    writeFileSync(file, previous);
    advance(-1);
    expect(await service.tick('Synthetic digest')).toMatchObject({ sent: 0, pending: 1 });
    expect(readFileSync(file, 'utf8')).toBe(previous);
  });
  it('does not read or overwrite oversized receipts', async () => {
    const { options } = fixture();
    const service = createLeaderNetwork(options);
    await service.tick('Synthetic digest');
    const file = join(options.runsDir, 'leader/network-state.json');
    writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(await service.tick('Synthetic digest')).toMatchObject({ sent: 0, pending: 1 });
    expect(readFileSync(file, 'utf8').length).toBe(8 * 1024 * 1024 + 1);
  });
});
