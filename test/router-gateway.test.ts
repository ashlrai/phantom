/** Router gateway: one config, one routed-completion path, a loopback-only
 * OpenAI-compatible endpoint. Nothing here spawns a lane CLI or contacts a
 * model: transports are fakes, routing is the real routeSeat. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultRouterGatewayConfig,
  initRouterGatewayConfig,
  isRouterModelFlag,
  loadRouterGatewayConfig,
  parseRouterGatewayConfig,
  parseRouterModelSpec,
  type RouterGatewayConfig,
} from '../src/core/router-gateway/config.js';
import {
  listRouterModels,
  planRoutedCompletion,
  routedComplete,
  type RoutedCompletionResult,
  type RouterGatewayDeps,
} from '../src/core/router-gateway/complete.js';
import {
  ensureRouterGatewayToken,
  flattenChatMessages,
  parseChatRequest,
  startRouterGatewayServer,
  type RunningRouterGateway,
} from '../src/core/router-gateway/server.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { LeaderSeatCandidate } from '../src/core/vision/leader-seat.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();

function seat(id: string, engine: VerseSeat['engine'], models: string[]): VerseSeat {
  return {
    id, engine, label: id, accountId: engine === 'local' ? 'local' : id,
    models: models.map((m) => ({ id: m, label: m, contextWindow: 200_000 })),
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

const LOCAL: LeaderSeatCandidate = { seat: seat('local:qwen3:8b', 'local', ['qwen3:8b']), launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
const REMOTE_LOCAL: LeaderSeatCandidate = { seat: seat('local:big:70b', 'local', ['big:70b']), launcher: null, ollamaBaseUrl: 'http://10.0.0.5:11434' };
const GROK: LeaderSeatCandidate = { seat: seat('grok', 'grok', ['grok-4.6', 'grok-4.6-mini']), launcher: ['node', '/profiles/grok/launcher.js'], ollamaBaseUrl: null };
const CLAUDE: LeaderSeatCandidate = { seat: seat('claude', 'claude', ['claude-opus-5-5']), launcher: ['node', '/profiles/claude/launcher.js'], ollamaBaseUrl: null };
const DEVIN: LeaderSeatCandidate = { seat: seat('devin-cli', 'devin', ['swe-1']), launcher: null, ollamaBaseUrl: null };

function paid(id: string, engine: SeatCapacity['engine'], usedPercent: number): SeatCapacity {
  return {
    seatId: id, engine, label: id, free: false, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null,
    windows: [{ id: 'weekly', usedPercent, resetsAt: '2026-09-28T00:00:00.000Z', resetDescription: null, limitReached: false }],
  };
}

interface Harness {
  deps: RouterGatewayDeps;
  calls: string[];
  recorded: number;
}

function harness(opts: {
  candidates: LeaderSeatCandidate[];
  gateway?: Partial<RouterGatewayConfig>;
  snapshot?: SeatCapacity[];
  standing?: ReturnType<typeof makePolicy> | null;
  fail?: string[];
  killed?: boolean;
  native?: boolean;
}): Harness {
  const h: Harness = { calls: [], recorded: 0, deps: undefined as unknown as RouterGatewayDeps };
  const answer = (label: string) => async (_system: string, user: string): Promise<string> => {
    h.calls.push(label);
    if (opts.fail?.includes(label)) throw new Error(`${label} broke`);
    return `${label} says: ${user}`;
  };
  h.deps = {
    cfg: {} as AshlrConfig,
    gateway: { ...defaultRouterGatewayConfig(), ...opts.gateway },
    now: () => NOW,
    candidates: async () => opts.candidates,
    capacitySnapshot: () => ({ publishedAt: OBSERVED, seats: opts.snapshot ?? [] }),
    budgetPolicy: () => defaultBudgetPolicy(),
    standingPolicy: () => (opts.standing === undefined ? makePolicy() : opts.standing),
    clampBudget: (policy) => policy,
    route: (req, capacity, policy, nowMs) => routeSeat(req, capacity, policy, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => { h.recorded++; },
    killSwitchOn: () => opts.killed === true,
    transports: {
      local: (base, model) => answer(`local ${base} ${model}`),
      ...(opts.native === false ? {} : {
        native: (seatId: string, engine: string, model: string, admitted: () => boolean) => async (system: string, user: string) => {
          if (!admitted()) throw new Error('admission changed');
          return answer(`${engine} ${seatId} ${model}`)(system, user);
        },
      }),
    },
  };
  return h;
}

describe('router config', () => {
  it('fills defaults and refuses unknown keys, a host, bad versions and bad aliases', () => {
    const parsed = parseRouterGatewayConfig(JSON.stringify({ version: 1, lanes: ['local', 'grok'], models: { fast: { route: 'local:qwen3:8b', difficulty: 'low' } } }));
    expect(parsed).toMatchObject({ version: 1, port: 18741, lanes: ['local', 'grok'], maxAttempts: 2, models: { fast: { route: 'local:qwen3:8b', difficulty: 'low' } } });
    expect(() => parseRouterGatewayConfig('{"version":1,"host":"0.0.0.0"}')).toThrow(/unknown key "host"/);
    expect(() => parseRouterGatewayConfig('{"version":2}')).toThrow(/"version": 1/);
    expect(() => parseRouterGatewayConfig('{"version":1,"port":80}')).toThrow(/port/);
    expect(() => parseRouterGatewayConfig('{"version":1,"models":{"auto":{"route":"auto"}}}')).toThrow(/other than "auto"/);
    expect(() => parseRouterGatewayConfig('{"version":1,"models":{"x":{"route":"nope"}}}')).toThrow(/route/);
    expect(() => parseRouterGatewayConfig('{"version":1,"models":{"x":{"route":"auto","apiKey":"k"}}}')).toThrow(/unknown key "apiKey"/);
    expect(() => parseRouterGatewayConfig('not json')).toThrow(/valid JSON/);
  });

  it('init writes the defaults once (0600) and never overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-config-'));
    try {
      const path = join(dir, 'router', 'gateway.json');
      expect(loadRouterGatewayConfig(path)).toMatchObject({ exists: false, config: defaultRouterGatewayConfig() });
      expect(initRouterGatewayConfig(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, JSON.stringify({ version: 1, maxAttempts: 3 }));
      expect(initRouterGatewayConfig(path)).toBe(false);
      expect(loadRouterGatewayConfig(path).config.maxAttempts).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('model strings split on the first colon; run --model only routes named lanes', () => {
    expect(parseRouterModelSpec('auto')).toEqual({ kind: 'auto' });
    expect(parseRouterModelSpec('local:qwen3:8b')).toEqual({ kind: 'pin', lane: 'local', model: 'qwen3:8b' });
    expect(parseRouterModelSpec('codex-personal:gpt-5.5')).toEqual({ kind: 'pin', lane: 'codex-personal', model: 'gpt-5.5' });
    expect(parseRouterModelSpec(':x')).toBeNull();
    expect(parseRouterModelSpec('plain')).toBeNull();
    for (const routed of ['auto', 'local:qwen3:8b', 'codex-personal:gpt-5.5', 'claude:claude-opus-5-5', 'grok:grok-4.6']) expect(isRouterModelFlag(routed)).toBe(true);
    // Plain Ollama tags keep their old meaning for the goal runner.
    for (const tag of ['qwen3:8b', 'llama3.2:3b', 'qwen2.5-coder', 'localish:7b']) expect(isRouterModelFlag(tag)).toBe(false);
  });
});

describe('routedComplete', () => {
  it('auto routes through routeSeat, records the decision and returns the answer', async () => {
    const h = harness({ candidates: [GROK, LOCAL], snapshot: [paid('grok', 'grok', 20)] });
    const r = await routedComplete(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schema).toBe('router.completion.v1');
    expect(r.text).toMatch(/says: hi$/);
    expect(r.decision?.candidates).toEqual(expect.arrayContaining(['grok', 'local:qwen3:8b']));
    expect(r.seatId).toBe(r.decision?.candidates[0]);
    expect(h.recorded).toBe(1);
  });

  it('a pinned lane still passes admission and uses the pinned model', async () => {
    const h = harness({ candidates: [GROK, LOCAL], snapshot: [paid('grok', 'grok', 20)] });
    const r = await routedComplete(h.deps, { model: 'grok:grok-4.6-mini', system: '', prompt: 'hi' });
    expect(r.ok && [r.seatId, r.model]).toEqual(['grok', 'grok-4.6-mini']);
    expect(h.calls).toEqual(['grok grok grok-4.6-mini']);
    // Spent seat: the pin is refused rather than bypassing the budget.
    const spent = harness({ candidates: [GROK], snapshot: [paid('grok', 'grok', 100)] });
    const refused = await routedComplete(spent.deps, { model: 'grok:grok-4.6', system: '', prompt: 'hi' });
    expect(refused).toMatchObject({ ok: false, status: 'no-route' });
    expect(spent.calls).toEqual([]);
  });

  it('a failed seat falls through to the next ranked seat, within maxAttempts', async () => {
    const h = harness({ candidates: [LOCAL, GROK], snapshot: [paid('grok', 'grok', 20)], fail: ['local http://127.0.0.1:11434 qwen3:8b', 'grok grok grok-4.6'] });
    const both = await routedComplete(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(both).toMatchObject({ ok: false, status: 'failed' });
    expect(both.attempts.map((a) => a.outcome)).toEqual(['failed', 'failed']);
    const one = harness({ candidates: [LOCAL, GROK], snapshot: [paid('grok', 'grok', 20)], fail: ['local http://127.0.0.1:11434 qwen3:8b'], gateway: { maxAttempts: 2 } });
    const ok = await routedComplete(one.deps, { model: 'auto', system: '', prompt: 'hi' });
    if (one.calls[0]?.startsWith('local')) {
      expect(ok.ok && ok.seatId).toBe('grok');
      expect(ok.attempts.map((a) => a.outcome)).toEqual(['failed', 'completed']);
    }
    const capped = harness({ candidates: [LOCAL, GROK], snapshot: [paid('grok', 'grok', 20)], fail: ['local http://127.0.0.1:11434 qwen3:8b', 'grok grok grok-4.6'], gateway: { maxAttempts: 1 } });
    const r = await routedComplete(capped.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(r.attempts).toHaveLength(1);
  });

  it('native seats need a producer grant; claude is judge/leader-only in the fixture grant', async () => {
    const h = harness({ candidates: [CLAUDE, LOCAL], snapshot: [paid('claude', 'claude', 5)] });
    const plan = await planRoutedCompletion(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(plan.steps.map((s) => s.seatId)).toEqual(['local:qwen3:8b']);
    expect(plan.ruledOut).toContainEqual(expect.objectContaining({ seatId: 'claude', reason: expect.stringMatching(/producer/) }));
    const noGrant = harness({ candidates: [GROK], snapshot: [paid('grok', 'grok', 5)], standing: null });
    expect(await routedComplete(noGrant.deps, { model: 'auto', system: '', prompt: 'hi' })).toMatchObject({ ok: false, status: 'no-route' });
    expect(noGrant.calls).toEqual([]);
    const noAdapter = harness({ candidates: [GROK], snapshot: [paid('grok', 'grok', 5)], native: false });
    const held = await planRoutedCompletion(noAdapter.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(held.ruledOut[0]?.reason).toMatch(/native adapter/);
  });

  it('local models are loopback-only; engines without an adapter and unlisted lanes are ruled out', async () => {
    const h = harness({ candidates: [REMOTE_LOCAL, DEVIN, GROK], snapshot: [paid('grok', 'grok', 5)], gateway: { lanes: ['local', 'devin'] } });
    const plan = await planRoutedCompletion(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(plan.ok).toBe(false);
    const reasons = Object.fromEntries(plan.ruledOut.map((r) => [r.seatId, r.reason]));
    expect(reasons['local:big:70b']).toMatch(/loopback-only/);
    expect(reasons['devin-cli']).toMatch(/no completion adapter/);
    expect(reasons['grok']).toMatch(/lanes/);
  });

  it('the kill switch stops calls; previews still work and write no decision', async () => {
    const h = harness({ candidates: [LOCAL], killed: true });
    expect(await routedComplete(h.deps, { model: 'auto', system: '', prompt: 'hi' })).toMatchObject({ ok: false, reason: expect.stringMatching(/kill switch/) });
    const plan = await planRoutedCompletion(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(plan.ok).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.recorded).toBe(0);
  });

  it('aliases resolve with their task and difficulty; bad requests are refused before routing', async () => {
    const h = harness({ candidates: [LOCAL], gateway: { models: { fast: { route: 'local:qwen3:8b', task: 'bulk', difficulty: 'low' } } } });
    const r = await routedComplete(h.deps, { model: 'fast', system: '', prompt: 'hi' });
    expect(r.ok && r.route).toBe('local:qwen3:8b');
    const plan = await planRoutedCompletion(h.deps, { model: 'fast', system: '', prompt: 'hi' });
    expect(plan.request).toMatchObject({ task: 'bulk', difficulty: 'low', autonomous: true });
    expect(await routedComplete(h.deps, { model: 'mystery', system: '', prompt: 'hi' })).toMatchObject({ ok: false, status: 'bad-request' });
    expect(await routedComplete(h.deps, { model: 'auto', system: '', prompt: '  ' })).toMatchObject({ ok: false, status: 'bad-request' });
    expect(await routedComplete(h.deps, { model: 'local:nope', system: '', prompt: 'hi' })).toMatchObject({ ok: false, status: 'bad-request' });
    expect(h.calls).toEqual(['local http://127.0.0.1:11434 qwen3:8b']);
  });

  it('a native call aborts when admission changes mid-flight', async () => {
    const h = harness({ candidates: [GROK] });
    // Routing reads 20% used; the transport's admission recheck then sees the seat spent.
    let reads = 0;
    h.deps.capacitySnapshot = () => ({ publishedAt: OBSERVED, seats: [paid('grok', 'grok', reads++ === 0 ? 20 : 100)] });
    const r = await routedComplete(h.deps, { model: 'auto', system: '', prompt: 'hi' });
    expect(r).toMatchObject({ ok: false, status: 'failed' });
    expect(r.attempts[0]?.reason).toMatch(/admission changed/);
    expect(h.calls).toEqual([]);
  });

  it('lists auto, aliases and <lane>:<model> ids for allowed lanes', async () => {
    const h = harness({ candidates: [LOCAL, GROK, DEVIN], gateway: { models: { fast: { route: 'local:qwen3:8b' } } } });
    const ids = (await listRouterModels(h.deps)).map((m) => m.id);
    expect(ids).toEqual(['auto', 'fast', 'local:qwen3:8b', 'grok:grok-4.6', 'grok:grok-4.6-mini']);
  });
});

describe('chat request parsing', () => {
  it('flattens system and multi-turn messages and refuses tools and images', () => {
    expect(flattenChatMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])).toEqual({ system: 'S', prompt: 'U' });
    expect(flattenChatMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' },
    ]).prompt).toBe('User:\na\n\nAssistant:\nb\n\nUser:\nc');
    expect(() => flattenChatMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }])).toThrow(/only text/);
    expect(() => flattenChatMessages([{ role: 'assistant', content: 'x' }])).toThrow(/last message/);
    expect(() => parseChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }] })).toThrow(/Tool calls/);
    expect(parseChatRequest({ model: 'auto', messages: [{ role: 'user', content: 'x' }], tools: [], max_tokens: 50, stream: true }))
      .toEqual({ request: { model: 'auto', system: '', prompt: 'x', maxOutputTokens: 50 }, stream: true });
  });
});

describe('loopback endpoint', () => {
  let running: RunningRouterGateway | null = null;
  let dir = '';
  afterEach(async () => {
    await running?.close();
    running = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const okResult = (text: string): RoutedCompletionResult => ({
    schema: 'router.completion.v1', ok: true, text, requested: 'auto', route: 'auto', seatId: 'local:qwen3:8b', engine: 'local', model: 'qwen3:8b',
    decision: null, attempts: [], elapsedMs: 1,
  });

  async function start(complete = async () => okResult('pong'), maxConcurrent = 4): Promise<{ token: string; port: number }> {
    dir = mkdtempSync(join(tmpdir(), 'router-token-'));
    const token = ensureRouterGatewayToken(join(dir, 'router', 'token'));
    running = await startRouterGatewayServer({
      port: 0, token, maxConcurrent,
      handlers: { complete, models: async () => [{ id: 'auto', kind: 'auto', target: 'auto', engine: null }] },
    });
    return { token, port: running.port };
  }

  function call(port: number, path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { 'content-type': 'application/json', ...opts.headers } }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
  }

  it('binds 127.0.0.1 and writes a 0600 token file', async () => {
    const { token } = await start();
    expect(running!.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(running!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const file = join(dir, 'router', 'token');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    expect(ensureRouterGatewayToken(file)).toBe(token);
  });

  it('requires the bearer token and a loopback Host/Origin', async () => {
    const { token, port } = await start();
    expect((await call(port, '/healthz')).status).toBe(200);
    expect((await call(port, '/v1/models')).status).toBe(401);
    expect((await call(port, '/v1/models', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const models = await call(port, '/v1/models', { headers: { authorization: `Bearer ${token}` } });
    expect(models.status).toBe(200);
    expect(JSON.parse(models.text).data[0].id).toBe('auto');
    expect((await call(port, '/v1/models', { headers: { authorization: `Bearer ${token}`, host: 'evil.example' } })).status).toBe(403);
    expect((await call(port, '/v1/models', { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('serves chat completions, streams one chunk, maps failures and refuses tools', async () => {
    const seen: unknown[] = [];
    const { token, port } = await start(async (req) => {
      seen.push({ model: req.model, system: req.system, prompt: req.prompt });
      if (req.model === 'grok:none') {
        return { schema: 'router.completion.v1', ok: false, status: 'no-route', reason: 'No seat.', requested: req.model, route: req.model, decision: null, attempts: [], elapsedMs: 0 };
      }
      return okResult('pong');
    });
    const auth = { authorization: `Bearer ${token}` };
    const body = { model: 'auto', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'ping' }] };
    const res = await call(port, '/v1/chat/completions', { method: 'POST', body, headers: auth });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.text);
    expect(parsed).toMatchObject({ object: 'chat.completion', model: 'local:qwen3:8b:qwen3:8b', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] });
    expect(parsed.phantom).toMatchObject({ seatId: 'local:qwen3:8b', usageEstimated: true });
    expect(seen[0]).toEqual({ model: 'auto', system: 'be brief', prompt: 'ping' });
    const stream = await call(port, '/v1/chat/completions', { method: 'POST', body: { ...body, stream: true }, headers: auth });
    expect(stream.text).toContain('"content":"pong"');
    expect(stream.text.trim().endsWith('data: [DONE]')).toBe(true);
    const none = await call(port, '/v1/chat/completions', { method: 'POST', body: { ...body, model: 'grok:none' }, headers: auth });
    expect(none.status).toBe(503);
    expect(JSON.parse(none.text).error.message).toBe('No seat.');
    const tools = await call(port, '/v1/chat/completions', { method: 'POST', body: { ...body, tools: [{ type: 'function' }] }, headers: auth });
    expect(tools.status).toBe(400);
    expect((await call(port, '/v1/chat/completions', { headers: auth })).status).toBe(405);
  });

  it('end to end: the sample agent → endpoint → routeSeat → the ranked seat', async () => {
    const h = harness({ candidates: [GROK, LOCAL], snapshot: [paid('grok', 'grok', 20)] });
    dir = mkdtempSync(join(tmpdir(), 'router-e2e-'));
    const tokenFile = join(dir, 'router', 'token');
    running = await startRouterGatewayServer({
      port: 0, token: ensureRouterGatewayToken(tokenFile), maxConcurrent: 2,
      handlers: { complete: (req) => routedComplete(h.deps, req), models: () => listRouterModels(h.deps) },
    });
    const agent = join(__dirname, '..', 'examples', 'router-gateway', 'agent.mjs');
    const out = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [agent, 'ping'], {
        env: { PATH: process.env['PATH'] ?? '', ROUTER_URL: running!.url, ROUTER_TOKEN_FILE: tokenFile, ROUTER_MODEL: 'auto' },
        timeout: 20_000,
      }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr })));
    });
    expect(out.stdout.trim()).toMatch(/says: ping$/);
    expect(h.calls).toHaveLength(1);
    expect(out.stderr).toMatch(/1 attempt/);
    // The token is read from its file and never echoed.
    expect(out.stdout + out.stderr).not.toContain(readFileSync(tokenFile, 'utf8').trim());
  });

  it('answers 429 past maxConcurrent', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { token, port } = await start(async () => { await gate; return okResult('late'); }, 1);
    const auth = { authorization: `Bearer ${token}` };
    const body = { model: 'auto', messages: [{ role: 'user', content: 'x' }] };
    const first = call(port, '/v1/chat/completions', { method: 'POST', body, headers: auth });
    await new Promise((r) => setTimeout(r, 50));
    expect((await call(port, '/v1/chat/completions', { method: 'POST', body, headers: auth })).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});
