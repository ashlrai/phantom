/**
 * spawnEngine emits one value-free phantom custody record per spawn
 * (follow-up to #888: the record was only unit-tested in phantom-custody.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../src/core/types.js';
import type { PhantomCustodyRecord } from '../src/core/run/phantom-custody.js';

// phantomInstalled() resolves through execFileSync; report it installed.
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => Buffer.from('/usr/local/bin/phantom')),
}));

const { spawnEngine } = await import('../src/core/run/engines.js');

function cfg(enabled: boolean): AshlrConfig {
  return {
    version: 1, roots: ['/tmp'], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
    telemetry: {}, tools: {}, phantom: { enabled },
  } as unknown as AshlrConfig;
}

async function custodyFor(dir: string, enabled: boolean): Promise<{ records: PhantomCustodyRecord[]; stderr: string }> {
  const records: PhantomCustodyRecord[] = [];
  let stderr = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const cmd: EngineCommand = { bin: 'nonexistent-engine-custody-test', args: [], cwd: dir };
    await spawnEngine(cmd, cfg(enabled), { onCustody: (r) => records.push(r), timeoutMs: 5_000 });
  } finally {
    spy.mockRestore();
  }
  return { records, stderr };
}

describe('spawnEngine custody record', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'custody-spawn-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('phantom disabled: one record, reason phantom-disabled, no stderr line', async () => {
    const { records, stderr } = await custodyFor(dir, false);
    expect(records).toEqual([{ wrapped: false, reason: 'phantom-disabled', engine: 'nonexistent-engine-custody-test', preflight_schema: 1, preflight_exit: null }]);
    expect(stderr).not.toContain('phantom custody');
  });

  it('no .phantom.toml: unwrapped not-initialized, value-free stderr line without the cwd', async () => {
    const { records, stderr } = await custodyFor(dir, true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ wrapped: false, reason: 'not-initialized' });
    expect(stderr).toContain('[ashlr] phantom custody {');
    expect(stderr).not.toContain(dir);
  });

  it('linked worktree with .phantom.toml: unwrapped worktree-namespace', async () => {
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/x\n');
    const { records } = await custodyFor(dir, true);
    expect(records[0]).toMatchObject({ wrapped: false, reason: 'worktree-namespace' });
  });

  it('main checkout with .phantom.toml: wrapped', async () => {
    writeFileSync(join(dir, '.phantom.toml'), '[phantom]\n');
    mkdirSync(join(dir, '.git'));
    const { records } = await custodyFor(dir, true);
    expect(records[0]).toMatchObject({ wrapped: true });
  });
});
