import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentsAppsCli } from '../src/cli/agents-apps.js';
import { createRegistry } from '../src/core/agents/apps/adapter.js';
import { createCliAgentApps, type CliRunResult } from '../src/core/agents/apps/cli-adapters.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// All provider text, binaries and prompts are fake; injected runners never spawn.
function fixture(provider: 'codex' | 'claude', code: number | null, providerError = false) {
  const dir = mkdtempSync(join(tmpdir(), 'app-failure-589s-'));
  dirs.push(dir);
  const ledgerPath = join(dir, 'sessions.json');
  const sessionId = `fake_${provider}_589s`;
  const output = 'FAKE diagnostic output';
  const stdout = provider === 'codex'
    ? [JSON.stringify({ type: 'thread.started', thread_id: sessionId }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: output } }),
      ...(providerError ? [JSON.stringify({ type: 'turn.failed', error: { message: 'FAKE provider detail' } })] : [])].join('\n')
    : JSON.stringify({ session_id: sessionId, result: output, is_error: providerError });
  const result: CliRunResult = { code, stdout, stderr: 'FAKE private stderr', timedOut: false, missing: false };
  const run = vi.fn(async () => result);
  const registry = createRegistry(createCliAgentApps({
    commands: { codex: '/fake/codex', claude: '/fake/claude' }, run,
    killed: () => false, ledgerPath, now: () => new Date('2026-11-18T00:00:00Z'),
  }));
  return { adapter: registry.get(`${provider}-cli`)!, registry, result, run, ledgerPath, sessionId };
}

describe.each(['codex', 'claude'] as const)('%s failed execution contract', (provider) => {
  it.each([
    ['nonzero exit', 7, false],
    ['signal/null exit', null, false],
    ['provider failure on exit zero', 0, true],
  ] as const)('refuses launch and resume for %s while retaining failed evidence', async (_label, code, providerError) => {
    const f = fixture(provider, code, providerError);
    for (const verb of ['launch', 'send'] as const) {
      // Resume must retain the known id even when the failed turn emits none.
      if (verb === 'send') f.result.stdout = provider === 'codex'
        ? (providerError ? '{"type":"turn.failed"}' : '')
        : JSON.stringify({ is_error: providerError });
      const result = verb === 'launch'
        ? await f.adapter.launchTask({ prompt: 'FAKE private prompt', model: 'fake-model' })
        : await f.adapter.sendMessage(f.sessionId, 'FAKE private prompt');
      expect(result).toMatchObject({ ok: false, code: 'failed' });
      expect(JSON.stringify(result)).not.toMatch(/private stderr|private prompt|provider detail/);
      expect(await f.adapter.readSession(f.sessionId)).toMatchObject({
        ok: true, value: { sessionId: f.sessionId, status: 'failed', model: 'fake-model', untrusted: true },
      });
      expect(await f.adapter.listSessions()).toMatchObject({ ok: true, value: [{ status: 'failed' }] });
      const rows = JSON.parse(readFileSync(f.ledgerPath, 'utf8')).sessions;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ adapter: `${provider}-cli`, sessionId: f.sessionId, status: 'failed' });
      if (verb === 'launch') expect(rows[0].output).toBe('FAKE diagnostic output');
    }
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it.each([[7, false], [null, false], [0, true]] as const)('returns CLI exit 1 on launch and send (exit %s, provider error %s)', async (code, providerError) => {
    const f = fixture(provider, code, providerError);
    for (const args of [
      [`${provider}-cli`, 'launch', '--prompt', 'FAKE prompt', '--json'],
      [`${provider}-cli`, 'send', f.sessionId, '--prompt', 'FAKE prompt', '--json'],
    ]) {
      const out = vi.fn();
      const err = vi.fn();
      expect(await runAgentsAppsCli(args, out, err, f.registry)).toBe(1);
      expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ ok: false, code: 'failed' });
      expect(err).not.toHaveBeenCalled();
    }
  });

  it('keeps successful launch and resume successful through the CLI', async () => {
    const f = fixture(provider, 0);
    for (const args of [
      [`${provider}-cli`, 'launch', '--prompt', 'FAKE prompt', '--json'],
      [`${provider}-cli`, 'send', f.sessionId, '--prompt', 'FAKE prompt', '--json'],
    ]) {
      const out = vi.fn();
      expect(await runAgentsAppsCli(args, out, vi.fn(), f.registry)).toBe(0);
      expect(JSON.parse(out.mock.calls[0]![0])).toMatchObject({ ok: true, value: { status: 'idle', sessionId: f.sessionId } });
    }
  });

  it('refuses failed launch without a valid provider id and writes no invalid ledger row', async () => {
    const f = fixture(provider, 1);
    f.result.stdout = provider === 'codex'
      ? '{"type":"thread.started","thread_id":"../FAKE-invalid"}'
      : '{"session_id":"../FAKE-invalid"}';
    expect(await f.adapter.launchTask({ prompt: 'FAKE prompt' })).toMatchObject({ ok: false, code: 'failed' });
    expect(await f.adapter.listSessions()).toEqual({ ok: true, value: [] });
  });
});
