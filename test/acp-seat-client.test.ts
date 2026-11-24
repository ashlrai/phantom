import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runAcpSeatTurn, type AcpSeatOptions } from '../src/core/agents/acp-client.js';
import { devinAcpSeatArgs, devinQualifiedFreeModel, runDevinAcpSeat } from '../src/core/devin/acp-seat.js';
import { DEVIN_MODELS_MAX_AGE_MS, fallbackDevinModelCatalog } from '../src/core/devin/models.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
function options(mode = 'happy'): AcpSeatOptions {
  return { command: process.execPath, args: [fixture, mode], cwd: process.cwd(), prompt: 'test',
    model: 'free-model', qualifyModel: () => true, timeoutMs: 3000 };
}
describe('generic ACP seat', () => {
  it('sets the exact offered model and collects only message text', async () => {
    expect(await runAcpSeatTurn(options())).toMatchObject({ ok: true, code: 'ok', text: 'hello world', sessionId: 'seat', stopReason: 'end_turn' });
  });
  it.each(['empty', 'permission', 'fs', 'read', 'allow'])('handles %s safely', async (mode) => {
    expect(await runAcpSeatTurn({ ...options(mode), permission: mode === 'allow' ? 'allow' : undefined }))
      .toMatchObject({ ok: true, text: '' });
  });
  it.each(['missing', 'ignored'])('refuses %s model configuration', async (mode) => {
    expect(await runAcpSeatTurn(options(mode))).toMatchObject({ ok: false, code: 'model-unavailable', text: '' });
  });
  it.each(['', 'bad model', 'free-model'])('refuses unqualified model %j before spawn', async (model) => {
    const spawn = vi.fn();
    expect(await runAcpSeatTurn({ ...options(), model, qualifyModel: () => model !== 'free-model' }, { spawn }))
      .toMatchObject({ code: 'model-unqualified', message: expect.stringContaining('no paid fallback') });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('fails closed when qualification throws', async () => {
    const spawn = vi.fn();
    expect((await runAcpSeatTurn({ ...options(), qualifyModel: () => { throw new Error('offline'); } }, { spawn })).code).toBe('model-unqualified');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('returns protocol errors without agent error text', async () => {
    expect(await runAcpSeatTurn(options('error'))).toMatchObject({ code: 'protocol-error', text: '' });
  });
  it('refuses a planner that never converges after four sets', async () => {
    const planModelStep = vi.fn(() => ({ kind: 'set' as const, configId: 'model', value: 'free-model' }));
    expect((await runAcpSeatTurn({ ...options(), planModelStep })).code).toBe('model-unavailable');
    expect(planModelStep).toHaveBeenCalledTimes(5);
  });
  it.each(['invalid', 'overflow'])('bounds and rejects %s protocol output', async (mode) => {
    expect((await runAcpSeatTurn(options(mode))).code).toBe(mode === 'invalid' ? 'protocol-error' : 'buffer-limit');
  });
  it('handles spawn errors and pre-aborted calls', async () => {
    expect((await runAcpSeatTurn({ ...options(), command: '/nonexistent/acp-seat-agent' })).code).toBe('spawn-error');
    const spawn = vi.fn();
    expect((await runAcpSeatTurn({ ...options(), signal: AbortSignal.abort() }, { spawn })).code).toBe('aborted');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'aborted'])('%s sends cancel and kills the child', async (code) => {
    const controller = new AbortController();
    let cancelSeen = false, killed = false;
    const spawnSpy: typeof spawn = (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      const write = child.stdin!.write.bind(child.stdin!);
      vi.spyOn(child.stdin!, 'write').mockImplementation((...args: Parameters<typeof write>) => {
        const message = JSON.parse(String(args[0]));
        if (message.method === 'session/cancel') cancelSeen = true;
        if (code === 'aborted' && message.method === 'session/prompt') queueMicrotask(() => controller.abort());
        return write(...args);
      });
      const kill = child.kill.bind(child);
      vi.spyOn(child, 'kill').mockImplementation((signal) => { killed = true; return kill(signal); });
      return child;
    };
    expect((await runAcpSeatTurn({ ...options('hang'), timeoutMs: 500, signal: controller.signal }, { spawn: spawnSpy })).code).toBe(code);
    expect(cancelSeen).toBe(true);
    expect(killed).toBe(true);
  });
});
describe('Devin free qualification', () => {
  it('accepts only exact, native-listed free non-lightning ids', () => {
    const catalog = fallbackDevinModelCatalog();
    catalog.source = 'cli';
    catalog.fetchedAt = new Date().toISOString();
    const model = catalog.families[0]!.models[0]!;
    expect(devinQualifiedFreeModel(catalog, model.id)).toBe(true);
    for (const source of ['cache', 'fallback'] as const) expect(devinQualifiedFreeModel({ ...catalog, source }, model.id)).toBe(false);
    expect(devinQualifiedFreeModel(catalog, 'swe')).toBe(false);
    expect(devinQualifiedFreeModel(catalog, 'unknown')).toBe(false);
    model.pricing.free = false;
    expect(devinQualifiedFreeModel(catalog, model.id)).toBe(false);
    model.pricing.free = true; model.id = 'swe-2-lightning';
    expect(devinQualifiedFreeModel(catalog, model.id)).toBe(false);
    expect(devinAcpSeatArgs('swe-2-high')).toEqual(['acp', '--model', 'swe-2-high']);
  });
  it('requires a parseable, recent, non-future native timestamp', () => {
    const catalog = fallbackDevinModelCatalog();
    catalog.source = 'cli';
    const now = Date.now(), id = catalog.families[0]!.models[0]!.id;
    for (const fetchedAt of [null, 'invalid', new Date(now - DEVIN_MODELS_MAX_AGE_MS - 1).toISOString(), new Date(now + 1).toISOString()]) {
      expect(devinQualifiedFreeModel({ ...catalog, fetchedAt }, id, now)).toBe(false);
    }
    expect(devinQualifiedFreeModel({ ...catalog, fetchedAt: new Date(now - DEVIN_MODELS_MAX_AGE_MS).toISOString() }, id, now)).toBe(true);
  });
  it.each(['swe-2-medium', 'swe-2-unknown', 'no-model'])('plans Devin config for %s before prompting', async (target) => {
    const model = target === 'no-model' ? 'swe-2-medium' : target;
    const catalog = fallbackDevinModelCatalog();
    catalog.source = 'cli'; catalog.fetchedAt = new Date().toISOString();
    catalog.families[0]!.models.push({ ...catalog.families[0]!.models[0]!, id: model });
    const messages: { method?: string; params?: Record<string, unknown> }[] = [];
    const spawnFixture: typeof spawn = (...args: Parameters<typeof spawn>) => {
      expect(args[1]).toEqual(['acp', '--model', model]);
      const child = spawn(process.execPath, [fixture, target === 'no-model' ? 'no-model' : 'devin'], args[2]);
      const write = child.stdin!.write.bind(child.stdin!);
      vi.spyOn(child.stdin!, 'write').mockImplementation((...args: Parameters<typeof write>) => {
        messages.push(JSON.parse(String(args[0])));
        return write(...args);
      });
      return child;
    };
    const result = await runDevinAcpSeat({ ...options(), cliPath: 'devin', model, catalog }, { spawn: spawnFixture });
    const prompted = messages.some((m) => m.method === 'session/prompt');
    expect(result.code).toBe(target === 'swe-2-unknown' ? 'model-unavailable' : 'ok');
    expect(prompted).toBe(target !== 'swe-2-unknown');
    if (target === 'swe-2-medium') expect(messages.filter((m) => m.method === 'session/set_config_option').map((m) => m.params)).toEqual([
      { sessionId: 'seat', configId: 'model', value: 'swe-2-high' },
      { sessionId: 'seat', configId: 'thought_level', value: 'medium' },
      { sessionId: 'seat', configId: 'speed', value: 'standard' },
    ]);
  });
  it('wrapper refuses cached listings before spawning', async () => {
    const spawn = vi.fn();
    expect((await runDevinAcpSeat({ ...options(), cliPath: 'devin', catalog: fallbackDevinModelCatalog() }, { spawn })).code).toBe('model-unqualified');
    expect(spawn).not.toHaveBeenCalled();
  });
});
