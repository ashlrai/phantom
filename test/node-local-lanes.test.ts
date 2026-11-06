/**
 * Per-node oMLX lane wiring (RQ-OMLX-DISTILL-1): local-lanes.json parsing,
 * caps merged into the node join advertisement, and the router only sending
 * omlx-work jobs to nodes whose measured pick reaches that tier.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import { DriveNodes } from '../src/core/drive/nodes/index.js';
import { emptyState, parseState, type NodesState, type NodesStore } from '../src/core/drive/nodes/state.js';
import {
  localLanePlan, probeLocalModelCaps, readLocalLaneConfig,
} from '../src/core/drive/nodes/local-model-caps.js';
import { probeNodeLanes } from '../src/core/drive/nodes/worker.js';

const GiB = 1024 ** 3;
class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    parseState(draft);
    this.state = draft;
    return structuredClone(result);
  }
}
let dir: string;
let configPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phm-node-lanes-')); configPath = join(dir, 'local-lanes.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const enable = { schemaVersion: 1, enabled: true };
const headroom = (freePercent = 60, swapGb = 0) => () => ({ freePercent, swapGb });
const deps = (over = {}) => ({ configPath, totalBytes: () => 16 * GiB, platform: 'darwin', ...over });

describe('local-lanes.json parsing', () => {
  it('absent file is a clean null, malformed files report a config error', () => {
    expect(readLocalLaneConfig(configPath)).toEqual({ config: null, error: null });
    writeFileSync(configPath, 'not json');
    expect(readLocalLaneConfig(configPath).error).toContain('not valid JSON');
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, enabled: 'yes' }));
    expect(readLocalLaneConfig(configPath).error).toContain('enabled');
    writeFileSync(configPath, JSON.stringify({ ...enable, bogus: 1 }));
    expect(readLocalLaneConfig(configPath).error).toContain('bogus');
    writeFileSync(configPath, JSON.stringify({ ...enable, model: 'not-a-catalog-id' }));
    expect(readLocalLaneConfig(configPath).error).toContain('catalog id');
    writeFileSync(configPath, JSON.stringify({ ...enable, maxSlots: 9 }));
    expect(readLocalLaneConfig(configPath).error).toContain('maxSlots');
  });

  it('parses an enabled config with a pinned model and slot cap', () => {
    writeFileSync(configPath, JSON.stringify({ ...enable, model: 'qwen3-8b-4bit', maxSlots: 3 }));
    expect(readLocalLaneConfig(configPath)).toEqual({ config: { enabled: true, model: 'qwen3-8b-4bit', maxSlots: 3 }, error: null });
  });
});

describe('lane plan and caps probe', () => {
  it('an enabled 16 GB node advertises omlx and omlx-work', () => {
    writeFileSync(configPath, JSON.stringify(enable));
    const probe = localLanePlan(deps({ headroom: headroom() }));
    expect(probe.configError).toBeNull();
    expect(probe.plan.model?.id).toBe('qwen2.5-coder-7b-instruct-4bit');
    expect(probeLocalModelCaps(deps({ headroom: headroom() }))).toEqual(['omlx', 'omlx-work']);
  });

  it('an 8 GB node advertises only omlx, and swap backs it off entirely', () => {
    writeFileSync(configPath, JSON.stringify(enable));
    expect(probeLocalModelCaps(deps({ totalBytes: () => 8 * GiB, headroom: headroom() }))).toEqual(['omlx']);
    expect(probeLocalModelCaps(deps({ totalBytes: () => 8 * GiB, headroom: headroom(60, 12) }))).toEqual([]);
  });

  it('advertises nothing without config, off macOS, or under memory pressure', () => {
    expect(probeLocalModelCaps(deps({ headroom: headroom() }))).toEqual([]);
    writeFileSync(configPath, JSON.stringify(enable));
    expect(probeLocalModelCaps(deps({ headroom: headroom(), platform: 'linux' }))).toEqual([]);
    expect(probeLocalModelCaps(deps({ headroom: headroom(20) }))).toEqual([]);
  });
});

describe('probeNodeLanes merges provider sign-ins with local model caps', () => {
  it('appends omlx caps after provider lanes', () => {
    writeFileSync(configPath, JSON.stringify(enable));
    const run = vi.fn((command: string) => ({ status: command === 'codex' ? 0 : 1 })) as unknown as typeof spawnSync;
    const lanes = probeNodeLanes(run, deps({ headroom: headroom() }));
    expect(lanes).toEqual(['codex', 'omlx', 'omlx-work']);
  });

  it('a failed local probe never costs the provider lanes', () => {
    const run = vi.fn(() => ({ status: 0 })) as unknown as typeof spawnSync;
    expect(probeNodeLanes(run, { configPath: join(dir, 'missing', 'x.json') })).toEqual(['codex', 'claude']);
  });
});

describe('unified pool routing over omlx caps', () => {
  it('routes omlx-work jobs only to nodes whose pick reaches the tier', () => {
    const nodes = new DriveNodes(new MemoryStore());
    const small = nodes.join('mini-8gb', { owners: ['mason'], caps: ['omlx'] })!;
    const big = nodes.join('mini-16gb', { owners: ['mason'], caps: ['omlx', 'omlx-work'] })!;
    nodes.enqueue('draft-docs', { owner: 'mason', requires: ['omlx'] });
    nodes.enqueue('fix-branch', { owner: 'mason', requires: ['omlx-work'] });
    const routes = nodes.plan('mason');
    expect(routes.find(r => r.jobId === 'fix-branch')?.nodeId).toBe('mini-16gb');
    expect(routes.find(r => r.jobId === 'draft-docs')?.nodeId).toBe('mini-16gb'); // tie on load: nodeId order wins
    const view = nodes.view(['mason']);
    expect(view.nodes.find(n => n.nodeId === 'mini-16gb')?.lanes).toEqual(['omlx', 'omlx-work']);
    expect(view.nodes.find(n => n.nodeId === 'mini-8gb')?.lanes).toEqual(['omlx']);
    const pulled = nodes.pull(big);
    expect(pulled?.job.id).toBe('draft-docs');
    expect(nodes.pull(small)).toBeNull(); // nothing left that a plain-omlx node can take
  });
});
