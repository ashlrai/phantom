import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { runAgentsAppsCli } from '../src/cli/agents-apps.js';
import { AGENT_APP_CAPABILITIES, describeAgentApps } from '../src/core/agents/apps/adapter.js';
import { createAgentAppRegistry } from '../src/core/agents/apps/registry.js';
import type { DesktopSurface } from '../src/core/desktop/operator.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'agent-apps-')); dirs.push(dir); return dir; };

function fakeCli(dir: string, name: string, launch: string, resume: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/${name}.argv"
cat >> "${dir}/${name}.stdin"
case "$*" in *resume*) printf '%s\\n' '${resume}' ;; *) printf '%s\\n' '${launch}' ;; esac
`, { mode: 0o700 });
  return path;
}

const capture = (out: string[] = []) => ({ out, o: (t: string) => { out.push(t); }, e: (_t: string) => undefined });

function fakeSurface(typed: string[]): DesktopSurface {
  const app = { name: 'Claude', bundleId: 'com.anthropic.claudefordesktop', pid: 1, executablePath: '/Applications/Claude.app/Contents/MacOS/Claude' };
  return {
    permissions: async () => ({ accessibility: true, screenRecording: true }),
    listApps: async () => ({ ok: true, value: [app] }),
    windows: async () => ({ ok: true, value: [{ app: 'Claude', bundleId: app.bundleId, title: 'Plan usage', id: 1 } as never] }),
    focus: async () => ({ ok: true, value: { focused: true } }), scroll: async () => ({ ok: true, value: { scrolled: true } }),
    read: async () => ({ ok: true, value: { source: 'accessibility', text: 'Usage: 42% of weekly limit', truncated: false, nodes: 3 } as never }),
    type: async ({ text }) => { typed.push(text); return { ok: true, value: { typed: text.length } }; },
    click: async () => ({ ok: true, value: { clicked: true } }), screenshot: async () => ({ ok: false, code: 'failed' }),
  };
}

describe('agent app adapters (fake CLIs)', () => {
  it('codex-cli launches with the chosen model, resumes the thread and reads status from the ledger', async () => {
    const dir = scratch();
    const codex = fakeCli(dir, 'codex',
      '{"type":"thread.started","thread_id":"th_1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done one"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done two"}}');
    const registry = createAgentAppRegistry({ cli: { commands: { codex }, killed: () => false, ledgerPath: join(dir, 'ledger.json') } });
    const adapter = registry.get('codex-cli')!;
    const launched = await adapter.launchTask({ prompt: 'fix the test', model: 'gpt-5.5', cwd: dir });
    expect(launched).toMatchObject({ ok: true, value: { sessionId: 'th_1', status: 'idle', model: 'gpt-5.5', output: 'done one', untrusted: true } });
    expect(await adapter.sendMessage('th_1', 'and the docs')).toMatchObject({ ok: true, value: { sessionId: 'th_1', output: 'done two', model: 'gpt-5.5' } });
    const argv = readFileSync(join(dir, 'codex.argv'), 'utf8').trim().split('\n');
    expect(argv).toEqual([`exec --json --skip-git-repo-check --model gpt-5.5 --cd ${dir} -`, 'exec resume th_1 --json --skip-git-repo-check -']);
    expect(readFileSync(join(dir, 'codex.stdin'), 'utf8')).toBe('fix the testand the docs');
    expect(await adapter.readSession('th_1')).toMatchObject({ ok: true, value: { output: 'done two' } });
    expect(await adapter.listSessions()).toMatchObject({ ok: true, value: [{ sessionId: 'th_1' }] });
    expect(await adapter.readUsage()).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('claude-cli parses -p JSON and resumes by session id', async () => {
    const dir = scratch();
    const claude = fakeCli(dir, 'claude', '{"type":"result","session_id":"s-9","result":"hi","is_error":false}',
      '{"type":"result","session_id":"s-9","result":"again","is_error":true}');
    const adapter = createAgentAppRegistry({ cli: { commands: { claude }, killed: () => false, ledgerPath: join(dir, 'l.json') } }).get('claude-cli')!;
    expect(await adapter.launchTask({ prompt: 'hello', model: 'opus' })).toMatchObject({ ok: true, value: { sessionId: 's-9', output: 'hi', status: 'idle' } });
    expect(await adapter.sendMessage('s-9', 'more')).toMatchObject({ ok: true, value: { status: 'failed', output: 'again' } });
    expect(readFileSync(join(dir, 'claude.argv'), 'utf8').trim().split('\n')).toEqual(['-p --output-format json --model opus', '-p --resume s-9 --output-format json']);
  });

  it('KILL (or a failing probe) stops launch and send before the CLI runs', async () => {
    const dir = scratch();
    const codex = fakeCli(dir, 'codex', '{}', '{}');
    for (const killed of [() => true, () => { throw new Error('unreadable'); }]) {
      const adapter = createAgentAppRegistry({ cli: { commands: { codex }, killed, ledgerPath: join(dir, 'l.json') } }).get('codex-cli')!;
      expect(await adapter.launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'killed' });
      expect(await adapter.sendMessage('th_1', 'x')).toMatchObject({ ok: false, code: 'killed' });
    }
    expect(() => readFileSync(join(dir, 'codex.argv'))).toThrow();
  });

  it('rejects bad input and reports a missing binary as unavailable', async () => {
    const dir = scratch();
    const registry = createAgentAppRegistry({ cli: { commands: { codex: join(dir, 'nope') }, killed: () => false, ledgerPath: join(dir, 'l.json') } });
    const codex = registry.get('codex-cli')!;
    for (const bad of [{ prompt: ' ' }, { prompt: 'x', model: 'bad model' }, { prompt: 'x', cwd: 'relative' }]) expect(await codex.launchTask(bad)).toMatchObject({ code: 'invalid' });
    expect(await codex.sendMessage('../etc', 'x')).toMatchObject({ code: 'invalid' });
    expect(await codex.launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await registry.get('devin-cli')!.launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'unsupported' });
  });
});

describe('desktop fallback adapters', () => {
  it('reads sessions and usage through the operator and types behind the bus intent', async () => {
    const typed: string[] = [];
    const intents: unknown[] = [];
    const desktop = { surface: fakeSurface(typed), platform: 'darwin' as const, killed: () => false, commsPaused: () => false,
      postIntent: (envelope: unknown) => { intents.push(envelope); return { status: 'posted' }; } };
    const adapter = createAgentAppRegistry({ desktop }).get('claude-desktop')!;
    expect(await adapter.listSessions()).toMatchObject({ ok: true, value: [{ sessionId: 'Plan usage', adapter: 'claude-desktop' }] });
    expect(await adapter.readUsage({ window: 'Plan usage' })).toEqual({ ok: true, value: { adapter: 'claude-desktop', text: 'Usage: 42% of weekly limit', untrusted: true } });
    expect(await adapter.sendMessage('Plan usage', 'next step')).toMatchObject({ ok: true });
    expect(typed).toEqual(['next step']);
    expect(intents).toHaveLength(2);
    expect(await adapter.launchTask({ prompt: 'x', model: 'opus' })).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('KILL blocks desktop writes through the existing operator gate', async () => {
    const typed: string[] = [];
    const adapter = createAgentAppRegistry({ desktop: { surface: fakeSurface(typed), killed: () => true, postIntent: () => ({ status: 'posted' }) } }).get('claude-desktop')!;
    expect(await adapter.sendMessage('', 'x')).toMatchObject({ ok: false, code: 'killed' });
    expect(typed).toEqual([]);
  });
});

describe('phm agents apps', () => {
  it('lists every adapter with its capability table', async () => {
    const dir = scratch();
    const registry = createAgentAppRegistry({ cli: { commands: { codex: fakeCli(dir, 'codex', '{}', '{}'), claude: join(dir, 'none'), devin: join(dir, 'none') } }, desktop: { platform: 'linux' } });
    const io = capture();
    expect(await runAgentsAppsCli(['--json'], io.o, io.e, registry)).toBe(0);
    const listed = JSON.parse(io.out[0]!) as Awaited<ReturnType<typeof describeAgentApps>>;
    expect(listed.apps.map((app) => app.id)).toEqual(['codex-cli', 'claude-cli', 'devin-cli', 'devin-desktop', 'claude-desktop', 'codex-desktop', 'grok-desktop', 'cursor-desktop']);
    for (const app of listed.apps) expect(Object.keys(app.capabilities)).toEqual([...AGENT_APP_CAPABILITIES]);
    expect(listed.apps.find((a) => a.id === 'codex-cli')).toMatchObject({ available: true, capabilities: { launchTask: { supported: true }, readUsage: { supported: false } } });
    expect(listed.apps.find((a) => a.id === 'grok-desktop')).toMatchObject({ available: false, capabilities: { readUsage: { supported: true } } });
    expect(await runAgentsAppsCli(['nope', 'sessions', '--json'], io.o, io.e, registry)).toBe(2);
    expect(await runAgentsAppsCli(['codex-cli', 'launch', '--json'], io.o, io.e, registry)).toBe(2);
    expect(await runAgentsCli(['apps', '--help'], io.o, io.e)).toBe(0);
    expect(io.out.join('\n')).toContain('agents apps <id> launch');
  });
});
