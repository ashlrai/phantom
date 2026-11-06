import { describe, expect, it, vi } from 'vitest';
import type { ProviderBackend } from '../src/core/providers.js';
import { adapterFor, backendFor } from '../src/core/verse/adapters/index.js';
import { claudeAdapter } from '../src/core/verse/adapters/claude.js';
import { codexAdapter } from '../src/core/verse/adapters/codex.js';
import { devinAdapter } from '../src/core/verse/adapters/devin.js';
import { grokAdapter } from '../src/core/verse/adapters/grok.js';
import type { VerseEngine, VerseSession } from '../src/core/verse/types.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';

vi.mock('../src/core/verse/local-harness.js', () => ({
  localHarnessInvocation: () => ({ executable: '/inert/claude', path: '/inert/tools:/usr/bin' }),
}));

describe('provider-neutral backends', () => {
  it.each([
    ['codex', codexAdapter, true],
    ['claude', claudeAdapter, false],
    ['devin', devinAdapter, true],
    ['local', claudeAdapter, false],
    ['grok', grokAdapter, false],
  ] as const)('%s exposes support and preserves the existing adapter', (id, adapter, providerAssignedSessionId) => {
    const backend = backendFor(id);
    expect(backend.id).toBe(id);
    expect(backend.capabilities).toEqual({ streaming: true, resume: true, providerAssignedSessionId });
    expect(adapterFor(id)).toBe(adapter);
    expect(backend.buildLaunch).toBe(adapter.buildLaunch);
    expect(backend.createParser).toBe(adapter.createParser);
    expect(backend.pollTelemetry).toBe(adapter.pollTelemetry);
    expect(backend.afterTurn).toBe(adapter.afterTurn);
    expect(backend.resolvesPlaybooks).toBe(adapter.resolvesPlaybooks);
  });

  it('keeps local inference a distinct backend while preserving its shared harness', () => {
    expect(backendFor('local')).not.toBe(backendFor('claude'));
    expect(adapterFor('local')).toBe(adapterFor('claude'));
  });

  it('does not allow one caller to change later callers capabilities or routing', () => {
    const backend = backendFor('codex');
    expect(Object.isFrozen(backend)).toBe(true);
    expect(Object.isFrozen(backend.capabilities)).toBe(true);
    expect(() => Object.assign(backend.capabilities, { providerAssignedSessionId: false })).toThrow(TypeError);
    expect(() => Object.assign(backend, { createParser: claudeAdapter.createParser })).toThrow(TypeError);
    expect(backendFor('codex')).toBe(backend);
  });

  it.each(['missing', '__proto__', 'constructor', 'toString'])('rejects unknown backend %s without falling back', (id) => {
    expect(() => backendFor(id as VerseEngine)).toThrow('unknown verse engine');
    expect(() => adapterFor(id as VerseEngine)).toThrow('unknown verse engine');
  });

  it.each(['claude', 'codex', 'devin', 'local', 'grok'] as const)('%s creates independent parsers that tolerate malformed lines', (id) => {
    const first = backendFor(id).createParser('turn-1');
    const second = backendFor(id).createParser('turn-2');
    expect(first).not.toBe(second);
    for (const line of ['garbage', '{', 'null', '[]', '{"type":"unknown"}']) {
      expect(() => first.push(line)).not.toThrow();
    }
    expect(() => first.finish(1)).not.toThrow();
    expect(second.nativeSessionId()).toBeNull();
  });

  it('launches and resumes through the generic contract without interpreting prompt text', () => {
    const backend: ProviderBackend<VerseSession, VerseSeatLaunch, ReturnType<typeof codexAdapter.buildLaunch>, ReturnType<typeof codexAdapter.createParser>> = backendFor('codex');
    const session: VerseSession = {
      id: 'test-session', title: 'test', projectPath: '/inert/project', engine: 'codex',
      accountId: 'test-account', seatId: 'codex-test', model: 'gpt-6-sol', nativeSessionId: null,
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      status: 'idle', turnCount: 0, lastError: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000 },
    };
    const launch: VerseSeatLaunch = {
      seat: { id: session.seatId, engine: 'codex', label: 'Test', accountId: session.accountId,
        models: [], contextWindow: 200_000,
        health: { state: 'unknown', summary: null, windows: [], observedAt: null } },
      launcher: ['/inert/codex'], ollamaBaseUrl: 'http://127.0.0.1:11434',
    };
    const prompt = 'literal $(touch /inert/unwanted); `echo hello`\n--resume';
    const first = backend.buildLaunch(session, prompt, launch);
    expect(first.argv.slice(0, 2)).toEqual(['/inert/codex', 'exec']);
    expect(first.argv).not.toContain('resume');
    expect(first.stdin).toBe(prompt);
    expect(first.cwd).toBe(session.projectPath);

    const parser = backend.createParser('turn-1');
    parser.push(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }));
    expect(parser.nativeSessionId()).toBe('test-thread');
    const resumed = backend.buildLaunch({ ...session, nativeSessionId: parser.nativeSessionId(), turnCount: 1 }, 'continue', launch);
    expect(resumed.argv.slice(0, 4)).toEqual(['/inert/codex', 'exec', 'resume', 'test-thread']);
    expect(resumed.stdin).toBe('continue');
  });
});
