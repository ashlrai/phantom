import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const policyMocks = vi.hoisted(() => ({
  enroll: vi.fn(),
  unenroll: vi.fn(),
  setKill: vi.fn(),
  readEnrollmentRegistry: vi.fn(),
  killSwitchOn: vi.fn(),
}));

const fleetMocks = vi.hoisted(() => ({
  buildFleetStatus: vi.fn(async () => ({ killed: true })),
}));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  enroll: policyMocks.enroll,
  unenroll: policyMocks.unenroll,
  setKill: policyMocks.setKill,
  readEnrollmentRegistry: policyMocks.readEnrollmentRegistry,
  killSwitchOn: policyMocks.killSwitchOn,
}));

vi.mock('../src/core/fleet/status.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/status.js')>(),
  buildFleetStatus: fleetMocks.buildFleetStatus,
}));

const optimizerMocks = vi.hoisted(() => ({
  optimizePrompt: vi.fn(),
  loadConfig: vi.fn(),
}));

// `fleet optimize-prompt` must stay local if a regression lets it run: no real
// config, no provider client, no trace files, no optimizer.
vi.mock('../src/core/fleet/prompt-optimizer.js', () => ({
  buildJudgeKappaMetric: () => () => 0,
  optimizePrompt: optimizerMocks.optimizePrompt,
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => { throw new Error('no provider in tests'); }),
}));

vi.mock('../src/core/fleet/judge-trace.js', () => ({
  readJudgeTraces: () => [],
}));

vi.mock('../src/core/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/config.js')>();
  optimizerMocks.loadConfig.mockImplementation(original.loadConfig);
  return { ...original, loadConfig: optimizerMocks.loadConfig };
});

import { cmdEnroll } from '../src/cli/sandbox.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { handleApi } from '../src/core/web/api.js';

beforeEach(() => {
  policyMocks.enroll.mockReset();
  policyMocks.unenroll.mockReset();
  policyMocks.setKill.mockReset();
  policyMocks.readEnrollmentRegistry.mockReset();
  policyMocks.readEnrollmentRegistry.mockReturnValue({
    state: 'ready',
    repos: [],
    reason: 'missing-registry',
  });
  policyMocks.killSwitchOn.mockReset();
  policyMocks.killSwitchOn.mockReturnValue(false);
  fleetMocks.buildFleetStatus.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function apiRequest(action: 'pause' | 'resume'): IncomingMessage {
  return {
    method: 'POST',
    url: `/api/fleet/${action}`,
    headers: {
      'content-type': 'application/json',
      'x-ashlr-token': 'operator-token',
    },
  } as IncomingMessage;
}

function apiResponse(): {
  res: ServerResponse;
  read: () => { status: number; body: Record<string, unknown> };
} {
  let status = 0;
  let payload = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      payload += chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({ status, body: JSON.parse(payload) as Record<string, unknown> }),
  };
}

async function callFleetApi(action: 'pause' | 'resume') {
  const response = apiResponse();
  const handled = await handleApi(
    apiRequest(action),
    response.res,
    {} as never,
    { token: 'operator-token', allowDispatch: true },
  );
  return { handled, ...response.read() };
}

describe('PolicyMutationResult operator surfaces', () => {
  it('emits typed healthy enrollment authority in JSON mode', async () => {
    policyMocks.readEnrollmentRegistry.mockReturnValue({
      state: 'ready',
      repos: ['/repo/one'],
      reason: 'healthy',
    });
    policyMocks.killSwitchOn.mockReturnValue(true);
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    await expect(cmdEnroll(['list', '--json'])).resolves.toBe(0);

    expect(JSON.parse(logs.join('\n'))).toEqual({
      state: 'ready',
      repos: ['/repo/one'],
      reason: 'healthy',
      killSwitchOn: true,
    });
    expect(errors).toEqual([]);
  });

  it('emits typed degraded enrollment authority in JSON mode and exits nonzero', async () => {
    policyMocks.readEnrollmentRegistry.mockReturnValue({
      state: 'degraded',
      reason: 'malformed-registry',
    });
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    await expect(cmdEnroll(['list', '--json'])).resolves.toBe(1);

    expect(JSON.parse(logs.join('\n'))).toEqual({
      state: 'degraded',
      reason: 'malformed-registry',
      killSwitchOn: false,
    });
    expect(errors).toEqual([]);
  });

  it('reports unsafe enrollment storage as a CLI error', async () => {
    policyMocks.enroll.mockReturnValue({
      ok: false,
      changed: false,
      quiesced: true,
      reason: 'unsafe-enrollment-registry',
    });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdEnroll(['add', '/repo'])).resolves.toBe(1);

    expect(errors.join('\n')).toMatch(/unsafe policy storage.*unsafe-enrollment-registry/i);
    expect(logs).not.toHaveBeenCalled();
  });

  it('reports a non-quiesced fleet pause as busy and retryable in the CLI', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdFleet(['pause'])).resolves.toBe(1);

    expect(stderr).toMatch(/fleet pause is busy.*retry/i);
    expect(logs).not.toHaveBeenCalled();
  });

  it('returns HTTP 409 with retry guidance when pause has not quiesced', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: true,
      changed: true,
      quiesced: false,
      reason: 'outward mutation still active',
    });

    const response = await callFleetApi('pause');

    expect(response.handled).toBe(true);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'pause',
      retryable: true,
      mutation: { ok: true, quiesced: false },
    });
  });

  it('returns a hard HTTP error for unsafe policy storage', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'unsafe-kill-sentinel',
    });

    const response = await callFleetApi('pause');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'pause',
      retryable: false,
      error: 'unsafe policy storage: unsafe-kill-sentinel',
    });
  });

  it('keeps void-returning legacy policy mocks compatible', async () => {
    policyMocks.setKill.mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdFleet(['pause'])).resolves.toBe(0);
  });
});

describe('fleet <verb> --help and stray flags never toggle or spend', () => {
  let stdout = '';
  let stderr = '';

  beforeEach(() => {
    optimizerMocks.optimizePrompt.mockReset();
    optimizerMocks.loadConfig.mockReturnValue({});
    stdout = '';
    stderr = '';
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
  });

  it.each([
    [['pause', '--help']],
    [['pause', '-h']],
    [['resume', '--help']],
    [['resume', '-h']],
  ])('%j prints usage and leaves the kill switch alone', async (args) => {
    await expect(cmdFleet(args)).resolves.toBe(0);
    expect(policyMocks.setKill).not.toHaveBeenCalled();
    expect(stdout).toContain('ashlr fleet pause');
  });

  it('pause/resume reject a stray argument without toggling', async () => {
    await expect(cmdFleet(['pause', '--yes'])).resolves.toBe(2);
    await expect(cmdFleet(['resume', 'now'])).resolves.toBe(2);
    expect(policyMocks.setKill).not.toHaveBeenCalled();
    expect(stderr).toContain('takes no arguments');
  });

  it('optimize-prompt --help prints usage without loading the optimizer', async () => {
    await expect(cmdFleet(['optimize-prompt', '--target', 'judge', '--help'])).resolves.toBe(0);
    expect(optimizerMocks.optimizePrompt).not.toHaveBeenCalled();
    expect(stdout).toContain('ashlr fleet optimize-prompt');
  });

  it('optimize-prompt rejects a mistyped --dry_run instead of running for real', async () => {
    await expect(cmdFleet(['optimize-prompt', '--dry_run'])).resolves.toBe(2);
    expect(optimizerMocks.optimizePrompt).not.toHaveBeenCalled();
    expect(stderr).toContain('unknown optimize-prompt option: --dry_run');
  });
});
