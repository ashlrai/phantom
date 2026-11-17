import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { setLeaderLineDepsForTest } from '../src/core/comms/leader-line.js';

let root = '';
const originalHome = process.env.HOME;
afterEach(() => {
  setLeaderLineDepsForTest(null);
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

it('reads fresh default brief evidence after recreation and deduplicates a replay', async () => {
  root = mkdtempSync(join(tmpdir(), 'status-default-478s-'));
  process.env.HOME = root;
  vi.stubEnv('ASHLR_HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  vi.stubEnv('ASHLR_FLEET_TRUTH_GH', 'off');
  const config = '[mason]\nidentities=[{channel="slack",id="U0OWNER"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"}]\n';
  const comms = 'confirmedByMason=true\n';
  const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-13T12:00:00Z') };
  mkdirSync(options.configDir, { recursive: true });
  writeFileSync(join(options.configDir, 'agent-network.toml'), config);
  writeFileSync(join(options.configDir, 'comms.toml'), comms);
  let title = 'Synthetic alpha';
  setLeaderLineDepsForTest({ now: options.now, narrative: async () => null, briefSources: {
    digest: { ledger: async () => [], appliedProposals: () => [], proposalTitle: () => null, cloudTasks: () => [], capacity: () => null, memos: () => [],
      fleetTruth: async (since, now) => ({ windowStartMs: since, windowEndMs: now!, merged: [], mergeCountState: 'ok', truncated: false, running: null, queued: null }) },
    leader: () => null, cloudTasks: () => [{ id: 'fake', title, repo: 'fake/repo', state: 'running', updatedAt: '2026-11-13T12:00:00Z' }],
    devinTasks: () => [], openQuestion: () => null, driveReport: () => null, holds: () => [], autonomy: () => ({ on: false, mode: null }), comms: () => null,
  } });
  const service = () => createLeaderNetwork({ configSource: config, commsSource: comms, runsDir: options.runsDir, busRoot: options.busRoot, now: options.now });
  const request = (id: string) => service().ingest({ message: { id, from: 'mason', to: 'leader', priority: 'P0', ttl: 100000,
    body: { text: 'Phantom status' }, channel: 'slack', channel_ref: `synthetic-${id}`,
    sender: { agent_id: 'mason', vendor: 'fixture', human: true, team: true }, external: false }, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
  const sent: BusEnvelope[] = [];
  const reply = vi.fn(async () => 'model');
  const deliver = async (_identity: unknown, envelope: BusEnvelope) => { sent.push(envelope); return { status: 'sent' as const, reason: 'synthetic' }; };
  const tick = () => tickLeaderNetwork({} as AshlrConfig, options, { deliver, reply });
  expect((await request('first')).status).toBe('accepted');
  expect(await tick()).toMatchObject({ replies: 1 });
  expect(sent[0]).toMatchObject({ channel: 'slack', channel_ref: 'synthetic-first', body: { text: expect.stringContaining('Synthetic alpha') } });
  expect(await service().pending()).toEqual([]);
  title = 'Synthetic beta';
  expect((await request('second')).status).toBe('accepted');
  expect(await tick()).toMatchObject({ replies: 1 });
  expect(sent[1]).toMatchObject({ channel: 'slack', channel_ref: 'synthetic-second', body: { text: expect.stringContaining('Synthetic beta') } });
  expect((sent[1].body as { text: string }).text).not.toContain('Synthetic alpha');
  expect((await request('first')).status).toBe('duplicate');
  expect(await tick()).toMatchObject({ replies: 0 });
  expect(reply).not.toHaveBeenCalled();
  expect(sent).toHaveLength(2);
  expect(readFileSync(join(options.runsDir, 'leader/MASON-OUTBOX.md'), 'utf8').match(/\[leader-network:reply-/g)).toHaveLength(2);
}, 20000);
