import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const mocks = vi.hoisted(() => ({ candidates: vi.fn(), prompt: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/fleet/planner-candidates.js', () => ({ readPlannerCandidates: mocks.candidates }));
vi.mock('../src/core/fleet/planner-prompt.js', () => ({ readPlannerPromptPath: mocks.prompt }));
vi.mock('../src/core/fleet/planner-run.js', () => ({ runPlannerPass: mocks.run }));

const name = 'phantom_fleet_planner_run';
const slate = { source: 'ok', path: '/fake/slate.json', candidates: [{ provider: 'test', argv: ['fake-command'] }], lastProvider: null };
const pass = { v: 1, provider: 'test', outcome: 'ran', exitCode: 0, logPath: '/fake/private.log',
  startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z', nextResetAt: null, planError: null };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'planner-mcp-'));
  vi.stubEnv('HOME', home);
  mocks.candidates.mockReset().mockResolvedValue(slate);
  mocks.prompt.mockReset().mockResolvedValue('/fake/prompt');
  mocks.run.mockReset().mockResolvedValue(pass);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const payload = (result: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(result.content[0].text);

describe('native MCP fleet planner', () => {
  it('advertises its schema and append safety', () => {
    expect(nativeToolSafety(name)).toBe('append');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    });
  });

  it('rejects malformed arguments before reading the slate', async () => {
    for (const args of [null, [], 'bad', { extra: true }, { reason: 1 }, { reason: 'x'.repeat(201) }, { reason: 'bad\ntext' }, { reason: '\u007f' }, { reason: '\u0085' }]) {
      const result = await callNativeTool(name, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalid planner arguments');
    }
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid'])('returns no-slate for %s without reading a prompt or spawning', async source => {
    mocks.candidates.mockResolvedValue({ ...slate, source });
    expect(payload(await callNativeTool(name, {}))).toEqual({ started: false, reason: 'no-slate', path: slate.path });
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('returns no-prompt-declared without spawning', async () => {
    mocks.prompt.mockResolvedValue(null);
    expect(payload(await callNativeTool(name, {}))).toEqual({ started: false, reason: 'no-prompt-declared', path: slate.path });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs the declared slate and returns only the public result fields', async () => {
    const result = await callNativeTool(name, { reason: 'next batch' });
    const { logPath: _logPath, ...publicPass } = pass;
    expect(payload(result)).toEqual({ started: true, ...publicPass });
    expect(result.content[0].text).not.toContain('fake-command');
    expect(result.content[0].text).not.toContain('/fake/private.log');
    const runsRoot = join(home, '.ashlr-runs');
    expect(mocks.candidates).toHaveBeenCalledWith(runsRoot);
    expect(mocks.prompt).toHaveBeenCalledWith(runsRoot);
    expect(mocks.run).toHaveBeenCalledWith({ runsRoot, candidates: slate.candidates, lastProvider: '', promptPath: '/fake/prompt', now: expect.any(Number) });
    expect(mocks.candidates.mock.invocationCallOrder[0]).toBeLessThan(mocks.prompt.mock.invocationCallOrder[0]);
    expect(mocks.prompt.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
  });

  it('refuses a concurrent pass and clears the guard after completion', async () => {
    let resolvePass!: (value: typeof pass) => void;
    mocks.run.mockReturnValue(new Promise(resolve => { resolvePass = resolve; }));
    const first = callNativeTool(name, {});
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    const second = payload(await callNativeTool(name, {}));
    expect(second).toEqual({ started: false, reason: 'pass-in-flight', startedAt: expect.any(String) });
    expect(mocks.run).toHaveBeenCalledOnce();
    resolvePass(pass);
    expect(payload(await first)).toMatchObject({ started: true });
    mocks.run.mockResolvedValue(pass);
    expect(payload(await callNativeTool(name, {}))).toMatchObject({ started: true });
  });

  it('clears the guard after a failed pass', async () => {
    mocks.run.mockRejectedValueOnce(new Error('test failure'));
    expect((await callNativeTool(name, {})).isError).toBe(true);
    expect(payload(await callNativeTool(name, {}))).toMatchObject({ started: true });
  });

  it('enforces the kill switch before reading or spawning', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), '');
    expect((await callNativeTool(name, {})).isError).toBe(true);
    expect(mocks.candidates).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
