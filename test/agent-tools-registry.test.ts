import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = resolve('tools/registry.mjs');
const invoke = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });

describe('agent tool registry', () => {
  it('discovers and invokes the three examples', () => {
    const tools = JSON.parse(execFileSync(process.execPath, [runner, 'list'], { encoding: 'utf8' }));
    expect(tools.map((item: { name: string }) => item.name)).toEqual(['line-count', 'sort-lines', 'word-count']);
    expect(JSON.parse(invoke('run', 'line-count', '{"text":"a\\nb"}').stdout)).toEqual({ lines: 2 });
    expect(JSON.parse(invoke('run', 'sort-lines', '{"text":"b\\na"}').stdout)).toEqual({ text: 'a\nb' });
    expect(JSON.parse(invoke('run', 'word-count', '{"text":"one two"}').stdout)).toEqual({ words: 2 });
  });
  it('rejects malformed input and unknown tools', () => {
    for (const args of [['run', 'word-count', '{}'], ['run', 'word-count', '{"text":1}'], ['run', 'word-count', '{"text":"x","extra":"y"}'], ['run', 'missing', '{}']]) {
      expect(invoke(...args).status).not.toBe(0);
    }
  });
  it('refuses dangerous tools and escaping entrypoints', async () => {
    const { discover, run } = await import('../tools/registry.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'tool-registry-'));
    mkdirSync(join(dir, 'examples'));
    writeFileSync(join(dir, 'examples', 'tool.mjs'), 'throw new Error("must not run")');
    const manifest = { name: 'danger', description: 'danger', safetyClass: 'dangerous', entrypoint: 'examples/tool.mjs', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
    writeFileSync(join(dir, 'danger.tool.json'), JSON.stringify(manifest));
    expect(() => run(['run', 'danger', '{}'], dir)).toThrow(/Leader approval required/);
    symlinkSync(runner, join(dir, 'escape.mjs'));
    writeFileSync(join(dir, 'danger.tool.json'), JSON.stringify({ ...manifest, entrypoint: 'escape.mjs' }));
    expect(() => discover(dir)).toThrow(/Invalid entrypoint/);
  });
});
