import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessProfileCapacity, nodeProfile, profileCaps, readConfiguredNodeProfiles } from '../src/core/drive/nodes/profiles.js';
import { emptyState } from '../src/core/drive/nodes/state.js';
import { buildNodesSnapshot } from '../src/core/nodes/view.js';
import type { HostHeadroom } from '../src/core/run/host-headroom.js';

const GIB = 1024 ** 3;
const nodeProfiles = readConfiguredNodeProfiles(fileURLToPath(new URL('../examples/fleet-profile.json', import.meta.url)));
const mbp = nodeProfile('mbp8', nodeProfiles)!;
const ok: HostHeadroom = { freePercent: 30, swapGb: 0.5, pressureLevel: 1 };
const DISK = 100e9;

describe('mbp8 profile lane sizing', () => {
  it('declares the 8 GB host: 2 agents, no local models, tailnet address only', () => {
    expect(mbp).toMatchObject({ hostname: 'worker.example', tailnetIp: '100.64.0.9', ramBytes: 8 * GIB, maxCliAgents: 2, localModels: false });
    expect(nodeProfiles.map(p => p.id)).toEqual(['mbp8']);
  });
  it('does not invent a host when no profile is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'missing-fleet-profile-'));
    expect(readConfiguredNodeProfiles(join(root, 'fleet-profile.json'))).toEqual([]);
  });
  it('caps an 8 GiB host at 2 concurrent agents', () => {
    expect(assessProfileCapacity(mbp, 8 * GIB, ok, DISK)).toMatchObject({ slots: 2, held: null });
  });
  it('never exceeds the ceiling even with abundant RAM', () => {
    expect(assessProfileCapacity(mbp, 64 * GIB, ok, DISK).slots).toBe(2);
  });
  it('scales down when less RAM is usable (host reserve of 4 GiB, 1 GiB per CLI agent)', () => {
    expect(assessProfileCapacity(mbp, 6 * GIB, ok, DISK).slots).toBe(2);
    expect(assessProfileCapacity(mbp, 5 * GIB, ok, DISK).slots).toBe(1);
    expect(assessProfileCapacity(mbp, 4 * GIB, ok, DISK)).toMatchObject({ slots: 0, held: 'memory-pressure' });
  });
  it('holds below the memory floor, on heavy swap, and under kernel pressure', () => {
    expect(assessProfileCapacity(mbp, 8 * GIB, { ...ok, freePercent: 14.9 }, DISK)).toMatchObject({ slots: 0, held: 'memory-pressure' });
    expect(assessProfileCapacity(mbp, 8 * GIB, { ...ok, freePercent: 15 }, DISK).slots).toBe(2);
    expect(assessProfileCapacity(mbp, 8 * GIB, { ...ok, swapGb: 2.1 }, DISK)).toMatchObject({ slots: 0, held: 'memory-pressure' });
    expect(assessProfileCapacity(mbp, 8 * GIB, { ...ok, pressureLevel: 2 }, DISK)).toMatchObject({ slots: 0, held: 'memory-pressure' });
  });
  it('holds when memory or disk is unmeasured or low', () => {
    expect(assessProfileCapacity(mbp, 8 * GIB, null, DISK)).toMatchObject({ slots: 0, held: 'memory-unmeasured' });
    expect(assessProfileCapacity(mbp, 8 * GIB, ok, null)).toMatchObject({ slots: 0, held: 'disk-unmeasured' });
    expect(assessProfileCapacity(mbp, 8 * GIB, ok, 1e9)).toMatchObject({ slots: 0, held: 'disk-pressure' });
  });
  it('strips local model caps but keeps CLI lanes', () => {
    expect(profileCaps(mbp, ['codex', 'claude', 'omlx:qwen', 'local', 'ollama', 'gh', 'v:3.30.34'])).toEqual(['codex', 'claude', 'gh', 'v:3.30.34']);
    expect(profileCaps({ ...mbp, localModels: true }, ['omlx:qwen'])).toEqual(['omlx:qwen']);
  });
});

describe('roster state for the mbp8 profile', () => {
  const NOW = 1_800_000_000_000;
  const node = (heartbeatAt: number) => ({ nodeId: 'mbp8', session: 1, owners: ['ashlr'], caps: ['codex'], heartbeatAt, expiresAt: NOW + 60_000 });
  function dirWith(state: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'nodes-'));
    writeFileSync(join(dir, 'nodes.json'), JSON.stringify(state));
    return dir;
  }
  it('lists a never-joined profile host as offline, including when the inventory is missing', () => {
    const snap = buildNodesSnapshot({ dir: mkdtempSync(join(tmpdir(), 'nodes-')), nowMs: NOW, profiles: nodeProfiles });
    expect(snap.error).toBe('inventory missing');
    expect(snap.nodes).toEqual([expect.objectContaining({ id: 'mbp8', status: 'offline', source: 'profile', liveJobs: [], profile: expect.objectContaining({ ramGb: 8, maxCliAgents: 2, localModels: false }) })]);
  });
  it('omits profile rows unless profiles are passed', () => {
    expect(buildNodesSnapshot({ dir: mkdtempSync(join(tmpdir(), 'nodes-')), nowMs: NOW }).nodes).toEqual([]);
  });
  it('shows a joined, heartbeating host as ready with its profile', () => {
    const snap = buildNodesSnapshot({ dir: dirWith({ ...emptyState(), sequence: 1, observedAt: NOW, nodes: [node(NOW - 5_000)] }), nowMs: NOW, profiles: nodeProfiles });
    expect(snap.nodes.find(n => n.id === 'mbp8')).toMatchObject({ status: 'ready', source: 'registry', profile: { label: 'MacBook Pro (8 GB)' } });
  });
  it('flips to offline once heartbeats stop', () => {
    const snap = buildNodesSnapshot({ dir: dirWith({ ...emptyState(), sequence: 1, observedAt: NOW, nodes: [node(NOW - 10 * 60_000)] }), nowMs: NOW, profiles: nodeProfiles });
    expect(snap.nodes.find(n => n.id === 'mbp8')).toMatchObject({ status: 'offline', source: 'registry' });
  });
});
