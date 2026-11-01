import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import * as writer from '../src/core/fleet/drop-job-writer.js';
import { scrubSecrets } from '../src/core/knowledge/index.js';

const gate = vi.hoisted(() => ({ killed: false, audit: vi.fn() }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: gate.audit }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => gate.killed }));

const name = 'phantom_fleet_drop_job';
const job = { id: 'MCPDROPTEST01', lane: 'codex-personal', tier: 'mid', body: 'Goal: test' };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-drop-job-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  gate.killed = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('native MCP fleet drop job', () => {
  it('advertises the schema and append safety', () => {
    expect(nativeToolSafety(name)).toBe('append');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['id', 'lane', 'tier', 'body'],
        properties: {
          id: { type: 'string', pattern: '^[A-Z0-9]{3,40}$' },
          lane: { type: 'string', enum: writer.DROP_JOB_LANES },
          tier: { type: 'string', enum: writer.DROP_JOB_TIERS },
          body: { type: 'string', minLength: 1, maxLength: 7800 },
        },
      },
    });
  });

  it('writes the job without returning its body and refuses a duplicate', async () => {
    const result = await callNativeTool(name, job);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    const file = join(root, 'leader', 'drop', 'claude', 'RQ-PHX-MCPDROPTEST01.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('#job repo=phantom lane=codex-personal tier=mid\n\nGoal: test\n');
    expect(payload).toEqual({ file: scrubSecrets(file), bytes: expect.any(Number), at: expect.any(String) });
    expect(payload).not.toHaveProperty('body');
    const duplicate = await callNativeTool(name, job);
    expect(duplicate.isError).toBeUndefined();
    expect(JSON.parse(duplicate.content[0].text)).toEqual({ written: false, reason: 'exists', id: job.id });
  });

  it('rejects invalid schema arguments before calling the writer', async () => {
    const write = vi.spyOn(writer, 'writeDropJob');
    for (const input of [null, {}, { ...job, lane: 'nope' }, { ...job, tier: 'nope' },
      { ...job, id: 'lowercase' }, { ...job, body: '' }, { ...job, body: 'x'.repeat(7801) },
      { ...job, extra: true }]) {
      expect((await callNativeTool(name, input)).isError).toBe(true);
    }
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'leader'))).toBe(false);
  });

  it('returns writer validation reasons without echoing the prompt', async () => {
    const result = await callNativeTool(name, { ...job, body: '   ' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ written: false, reason: 'invalid', reasons: ['empty-body'] });
  });

  it('enforces the kill switch before writing', async () => {
    gate.killed = true;
    const write = vi.spyOn(writer, 'writeDropJob');
    expect((await callNativeTool(name, job)).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('propagates path errors through the native error pipeline', async () => {
    vi.spyOn(writer, 'writeDropJob').mockRejectedValue(new writer.DropJobPathError('/fake/outside'));
    const result = await callNativeTool(name, job);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('path escapes the drop root');
    expect(result.content[0].text).not.toContain('/fake/outside');
  });
});
