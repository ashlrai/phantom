import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callNativeTool, listNativeTools } from '../src/core/mcp-native.js';
import { acquireWorkClaim, BRIEF_MAX_BYTES, buildContextBrief, pullTouchesKey, releaseWorkClaim } from '../src/core/agents/work-visibility.js';
import { listCoordination } from '../src/core/agents/claim-store.js';
import { projectWorldModel } from '../src/core/world/project.js';
import { writeWorldExport, worldExportPath } from '../src/core/world/export.js';
import { presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import { cmdAgentContext, cmdWorkClaim } from '../src/cli/work-visibility.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function world() {
  const sensors = presentUsageSensors([{
      lane: 'claude-max', observedAt: new Date(NOW).toISOString(), source: 'claude-usage',
    staleAfter: new Date(NOW + 60_000).toISOString(), used: 10, limit: 100, unit: 'percent', resetAt: null,
  }], NOW);
  return projectWorldModel({
    nowMs: NOW, sensors, sensorRows: [{ lane: 'claude-max', pacePerHour: 2, requiredPacePerHour: 3, runwayHours: 8 }],
    roster: null, claims: null, claimStore: { source: 'available', live: 1 }, busReadable: true,
    queue: null, ci: null, updatePhase: null, bottlenecks: 1, bottlenecksObservedAt: new Date(NOW).toISOString(),
    stepsRemaining: null, stepsObservedAt: null, outcomes: null,
  });
}

describe('shared visibility', () => {
  it('builds a brief under 4KB with claims, pulls, bottlenecks, blind spots, and pacing', () => {
    const claims = Array.from({ length: 3 }, (_, index) => ({
      origin: 'resource' as const, key: `queue:job-${index}`, owner: index % 2 === 0 ? 'claude' : 'codex',
      leaseUntil: NOW + 1000, sourceId: `work:${index}`, live: true, repo: 'ashlrai/phantom',
      branch: 'feat/x', path: null, started: new Date(NOW).toISOString(),
    }));
    const pulls = Array.from({ length: 3 }, (_, index) => ({
      repo: 'ashlrai/phantom', number: index + 1, state: 'open' as const, createdAt: new Date(NOW).toISOString(),
    }));
    const brief = buildContextBrief({
      nowMs: NOW, lane: 'claude', world: world(), claims, pulls,
      bottlenecks: [{ id: 'ci', metric: 'daily_ttg_s', value: 90 }],
    });
    const json = JSON.stringify(brief);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    expect(brief.bytes).toBe(Buffer.byteLength(json));
    expect(brief.pacing).toMatchObject({ lane: 'claude-max', pacePerHour: 2, requiredPacePerHour: 3, runwayHours: 8 });
    expect(brief.working.length).toBeGreaterThan(0);
    expect(brief.openPrs.length).toBeGreaterThan(0);
    expect(brief.working).toHaveLength(3);
    expect(brief.openPrs).toHaveLength(3);
    expect(brief.bottlenecks).toEqual([{ id: 'ci', metric: 'daily_ttg_s', value: 90 }]);
    expect(brief.blindSpots.length).toBeGreaterThan(0);
    expect(json).not.toContain('token');
  });

  it('refuses a second claim and an open pull, then releases on merge', () => {
    const root = mkdtempSync(join(tmpdir(), 'work-claim-'));
    roots.push(root);
    const pulls = [{ repo: 'ashlrai/phantom', number: 12, state: 'open' as const, createdAt: new Date(NOW).toISOString(), files: ['src/cli/world.ts'] }];
    expect(pullTouchesKey(pulls[0]!, 'path:ashlrai/phantom:src/cli/*')).toBe(true);
    const blockedPr = acquireWorkClaim({
      workKey: 'path:ashlrai/phantom:src/cli/*', lane: 'claude', pulls, root, now: NOW,
    });
    expect(blockedPr).toMatchObject({ status: 'conflict', reason: 'open-pr', holder: { pr: 12, repo: 'ashlrai/phantom' } });
    const first = acquireWorkClaim({ workKey: 'RQ-SHARED-VISIBILITY-1', lane: 'claude', repo: 'ashlrai/phantom', branch: 'feat/vis', root, now: NOW });
    expect(first.status).toBe('acquired');
    const second = acquireWorkClaim({ workKey: 'RQ-SHARED-VISIBILITY-1', lane: 'codex', root, now: NOW });
    expect(second).toMatchObject({ status: 'conflict', reason: 'live-claim', holder: { lane: 'claude' } });
    expect(JSON.stringify(second)).not.toContain('token');
    expect(releaseWorkClaim({ workKey: 'RQ-SHARED-VISIBILITY-1', lane: 'codex', reason: 'abandon', root, now: NOW }).status).toBe('conflict');
    expect(releaseWorkClaim({ workKey: 'RQ-SHARED-VISIBILITY-1', lane: 'claude', reason: 'merge', root, now: NOW })).toMatchObject({ status: 'released', reason: 'merge' });
    expect(listCoordination(root, NOW).claims.filter((row) => row.live)).toEqual([]);
    const again = acquireWorkClaim({ workKey: 'RQ-SHARED-VISIBILITY-1', lane: 'codex', root, now: NOW });
    expect(again.status).toBe('acquired');
  });

  it('exports the world snapshot and live claims without tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'world-export-'));
    roots.push(root);
    const file = join(root, 'world.json');
    acquireWorkClaim({ workKey: 'queue:export-job', lane: 'devin', root: undefined, now: Date.now() });
    const written = writeWorldExport(world(), { path: file, nowMs: NOW });
    expect(written).toEqual({ path: file, written: true });
    const body = JSON.parse(readFileSync(file, 'utf8')) as { schema: string; world: { schema: string }; claims: { items: unknown[] } };
    expect(body.schema).toBe('ashlr.world-export/v1');
    expect(body.world.schema).toBe('ashlr.world-model/v1');
    expect(JSON.stringify(body)).not.toContain('token');
    expect(worldExportPath(file)).toBe(file);
    releaseWorkClaim({ workKey: 'queue:export-job', lane: 'devin', reason: 'abandon' });
  });

  it('serves the brief and the claim through the CLI and MCP tools', async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      expect(await cmdWorkClaim(['acquire', 'queue:mcp-job', '--lane', 'cursor', '--json'])).toBe(0);
      expect(await cmdAgentContext(['--for-agent', 'cursor', '--json'], { readWorld: async () => world(), claims: () => listCoordination().claims })).toBe(0);
    } finally { console.log = log; }
    const claim = JSON.parse(lines[0]!) as { status: string };
    const brief = JSON.parse(lines[1]!) as { schema: string; lane: string; bytes: number };
    expect(claim.status).toBe('acquired');
    expect(brief).toMatchObject({ schema: 'ashlr.context-brief/v1', lane: 'cursor' });
    expect(brief.bytes).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    expect(listNativeTools().some((tool) => tool.name === 'phm_context_brief')).toBe(true);
    const mcp = await callNativeTool('phm_claim_release', { workKey: 'queue:mcp-job', lane: 'cursor', reason: 'open' });
    expect(mcp.isError).toBeUndefined();
    expect(JSON.parse(mcp.content[0]!.text).status).toBe('released');
    expect(mcp.content[0]!.text).not.toContain('token');
  });
});
