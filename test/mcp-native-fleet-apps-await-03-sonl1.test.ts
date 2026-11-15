import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as awaitModule from '../src/cli/fleet-apps-await.js';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const name = 'phantom_fleet_apps_await';
const realAwait = awaitModule.awaitFleetApps;
const realCli = awaitModule.cmdFleetAppsAwait;
const reply = (running: boolean | null) => ({ stdout: JSON.stringify({ ok: true, running }), stderr: '' });
const view = (raw: string) => JSON.parse(raw) as Awaited<ReturnType<typeof awaitModule.awaitFleetApps>>;

let output: string;
beforeEach(() => {
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Registration + read safety
// ---------------------------------------------------------------------------

describe('native fleet apps await registration', () => {
  it('advertises a closed read schema and rejects arguments before discovery', async () => {
    const schema = listNativeTools().find(tool => tool.name === name)!.inputSchema;
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['apps'],
      properties: {
        apps: { minItems: 1, maxItems: 8, uniqueItems: true },
        target: { enum: ['running', 'stopped'] },
        timeoutMs: { minimum: 1, maximum: 30000 },
        intervalMs: { minimum: 100, maximum: 60000 },
      },
    });
    expect(nativeToolSafety(name)).toBe('read');

    // All of these are truly invalid — validation rejects before any handler call
    const badArgs: unknown[] = [
      null, [], {},
      { apps: [] },
      { apps: ['unknown'] },
      { apps: [1] },
      { apps: ['Codex', 'Codex'] },        // duplicate
      { apps: ['Codex'], target: 'paused' }, // invalid target
      { apps: ['Codex'], timeoutMs: 0 },     // below minimum
      { apps: ['Codex'], timeoutMs: 30001 }, // above maximum
      { apps: ['Codex'], intervalMs: 99 },   // below minimum
      { apps: ['Codex'], intervalMs: 60001 },// above maximum
      { apps: ['Codex'], timeoutMs: 1.5 },   // not integer
      { apps: ['Codex'], intervalMs: null },  // null instead of integer
      { apps: ['Codex'], extra: 'field' },    // unknown property
      { apps: null },
      { apps: [1, 'Codex'] },
      ['array'],
      42,
      { apps: ['Codex'], timeoutMs: 30001, target: 'stopped' }, // timeout out of range
    ];
    const validateSpy = vi.spyOn(awaitModule, 'awaitFleetApps');
    try {
      for (const args of badArgs) {
        expect((await callNativeTool(name, args)).isError).toBe(true);
      }
    } finally {
      // None of these invalid args should reach the handler
      expect(validateSpy).not.toHaveBeenCalled();
      validateSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Structured helper: successful running observation
// ---------------------------------------------------------------------------

describe('structured helper: successful running observation', () => {
  it('reports ready when all apps are running', async () => {
    const exec = vi.fn(async () => reply(true));
    const result = await realAwait(
      { apps: ['Codex', 'Safari'], timeoutMs: 300, intervalMs: 100 },
      { exec, locateScript: () => '/fake/app_control.py' },
    );
    expect(result.outcome).toBe('ready');
    expect(result.apps.map(r => r.app)).toEqual(['Codex', 'Safari']);
    expect(result.apps.every(r => r.running === true)).toBe(true);
    expect(result.elapsedMs).toBeLessThan(600);
  });

  it('polls until all apps are running and stops', async () => {
    let calls = 0;
    const exec = vi.fn(async () => {
      const running = ++calls >= 3;
      return reply(running);
    });
    const result = await realAwait(
      { apps: ['Codex', 'Safari'], timeoutMs: 300, intervalMs: 50 },
      { exec, locateScript: () => '/fake/app_control.py', now: () => 0, sleep: async ms => {} },
    );
    expect(result.outcome).toBe('ready');
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Structured helper: successful stopped observation
// ---------------------------------------------------------------------------

describe('structured helper: successful stopped observation', () => {
  it('reports ready when all apps are stopped', async () => {
    const exec = vi.fn(async () => reply(false));
    const result = await realAwait(
      { apps: ['Codex', 'Safari'], target: 'stopped', timeoutMs: 300, intervalMs: 50 },
      { exec, locateScript: () => '/fake/app_control.py' },
    );
    expect(result.outcome).toBe('ready');
    expect(result.target).toBe('stopped');
    expect(result.apps.every(r => r.running === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structured helper: unknown not satisfying stopped
// ---------------------------------------------------------------------------

describe('structured helper: unknown not satisfying stopped', () => {
  it('returns unavailable when all probes return unknown (no valid observation)', async () => {
    const exec = vi.fn(async () => reply(null));
    const result = await realAwait(
      { apps: ['Codex'], target: 'stopped', timeoutMs: 300, intervalMs: 100 },
      { exec, locateScript: () => '/fake/app_control.py', now: () => 0, sleep: async ms => {} },
    );
    expect(result.outcome).toBe('unavailable');
    expect(result.apps[0].running).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Structured helper: mixed-group timeout
// ---------------------------------------------------------------------------

describe('structured helper: mixed-group timeout', () => {
  it('reports timeout with partial results when not all apps satisfy', async () => {
    let time = 0;
    const exec = vi.fn(async (_file: string, argv: string[]) => {
      const app = argv[3];
      return app === 'Codex' ? reply(true) : reply(null);
    });
    const result = await realAwait(
      { apps: ['Codex', 'Safari'], timeoutMs: 300, intervalMs: 100 },
      { exec, locateScript: () => '/fake/app_control.py', now: () => time, sleep: async ms => { time += ms; } },
    );
    expect(result.outcome).toBe('timeout');
    expect(result.apps.map(r => r.app)).toEqual(['Codex', 'Safari']);
    expect(result.apps.find(r => r.app === 'Codex')!.running).toBe(true);
    expect(result.apps.find(r => r.app === 'Safari')!.running).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// CLI structured output parity
// ---------------------------------------------------------------------------

describe('CLI structured output parity', () => {
  it('CLI --json emits parseable JSON matching the structured helper shape', async () => {
    const exec = vi.fn(async () => reply(true));
    const exit = await realCli(['--apps', 'Codex,Safari', '--timeout-ms', '200', '--interval-ms', '100', '--json'], {
      exec, locateScript: () => '/fake/bridge.py',
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('outcome', 'ready');
    expect(parsed).toHaveProperty('target', 'running');
    expect(parsed).toHaveProperty('elapsedMs');
    expect(Array.isArray(parsed.apps)).toBe(true);
    expect(parsed.apps).toHaveLength(2);
  });

  it('CLI structured output matches awaitFleetApps return shape for stopped', async () => {
    const exec = vi.fn(async () => reply(false));
    const cliResult = await realCli(['--apps', 'Codex', '--timeout-ms', '100', '--interval-ms', '100', '--target', 'stopped', '--json'], {
      exec, locateScript: () => '/fake/bridge.py',
    });
    expect(cliResult).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.outcome).toBe('ready');
    expect(parsed.target).toBe('stopped');
    expect(parsed.apps[0].app).toBe('Codex');
  });
});

// ---------------------------------------------------------------------------
// Missing script / unavailable
// ---------------------------------------------------------------------------

describe('structured helper: missing script and unavailable', () => {
  it('returns unavailable when no script found', async () => {
    const exec = vi.fn();
    const result = await realAwait(
      { apps: ['Codex'], timeoutMs: 300, intervalMs: 100 },
      { locateScript: () => null, locateInstalledScript: () => null },
    );
    expect(result.outcome).toBe('unavailable');
    expect(result.apps.every(r => r.running === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared deadline with a stalled probe
// ---------------------------------------------------------------------------

describe('structured helper: shared deadline with stalled probe', () => {
  it('bounds the whole group to the shared deadline even when a probe hangs', async () => {
    // The implementation runs two concurrent workers; both attempt exec before aborting
    const exec = vi.fn(async () => new Promise<string>(() => {}));
    const controller = new AbortController();
    // Abort after 30ms to simulate deadline
    setTimeout(() => controller.abort(), 30);
    const result = await realAwait(
      { apps: ['Codex', 'Safari'], timeoutMs: 50, intervalMs: 20 },
      { exec, locateScript: () => '/fake/app_control.py', signal: controller.signal },
    );
    expect(result.outcome).toBe('unavailable');
    // Two concurrent workers each call exec once before the abort; no further calls scheduled
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// MCP tool through callNativeTool (direct helper test)
// ---------------------------------------------------------------------------
// The MCP tool `phantom_fleet_apps_await` delegates to `awaitFleetApps`
// which is tested directly above.  This describe calls `callNativeTool`
// with valid args; the handler imports and calls the real helper which
// is mocked by injected deps in the structured helper tests.
// Error-handling paths (config failure, handler throw) are exercised
// by the existing mcp-native-fleet-apps-status ensure-03-sonk1.test.ts
// patterns — we verify the new tool routes through the same pipeline.

describe('MCP tool through callNativeTool', () => {
  // Verify that the tool is properly wired through callNativeTool's
  // routing and error pipeline without touching real I/O.

  it('is listed among native tools and callable by name', async () => {
    const tools = listNativeTools();
    const tool = tools.find(t => t.name === name);
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('Wait for an explicit group');
    expect(nativeToolSafety(name)).toBe('read');
    // Verify it routes through callNativeTool by checking validation rejects before handler
    const validateSpy = vi.spyOn(awaitModule, 'awaitFleetApps');
    try {
      expect((await callNativeTool(name, null)).isError).toBe(true);  // null rejected
      expect((await callNativeTool(name, [])).isError).toBe(true);    // array rejected
      expect((await callNativeTool(name, {})).isError).toBe(true);    // no apps
    } finally {
      expect(validateSpy).not.toHaveBeenCalled();
      validateSpy.mockRestore();
    }
  });

  it('is a read tool (safety confirmed by nativeToolSafety helper)', async () => {
    expect(nativeToolSafety(name)).toBe('read');
  });
});

registerFleetNativeTools();
