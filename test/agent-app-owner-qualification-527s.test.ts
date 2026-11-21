import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Point at a disposable checkout of the owner's exact head, not master.
const source = process.env['APP_OWNER_SOURCE'];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'app-owner-527-')); dirs.push(dir); return dir; };
async function modules() {
  if (!source) throw new Error('Set APP_OWNER_SOURCE to the disposable owner checkout');
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(source, file)).href);
  return { cli: await load('src/core/agents/apps/cli-adapters.ts'), desktop: await load('src/core/agents/apps/desktop-adapters.ts') };
}

describe('PR 6570 owner qualification', () => {
  it('records and resumes each provider session with the matching binary and id', async () => {
    const { cli } = await modules();
    const dir = scratch();
    const calls: { command: string; args: readonly string[]; stdin: string }[] = [];
    const run = async (command: string, args: readonly string[], opts: { stdin: string }) => {
      calls.push({ command, args, stdin: opts.stdin });
      const stdout = command.endsWith('codex') ? '{"type":"thread.started","thread_id":"codex_1"}' : '{"session_id":"claude_1","result":"done"}';
      return { code: 0, stdout, stderr: '', timedOut: false, missing: false };
    };
    const apps = cli.createCliAgentApps({ commands: { codex: '/fake/codex', claude: '/fake/claude' }, run, killed: () => false, ledgerPath: join(dir, 'ledger.json'), now: () => new Date('2026-01-01T00:00:00Z') });
    for (const [index, id] of [[0, 'codex_1'], [1, 'claude_1']] as const) {
      const app = apps[index];
      expect(await app.launchTask({ prompt: 'launch' })).toMatchObject({ ok: true, value: { sessionId: id, status: 'idle', updatedAt: '2026-01-01T00:00:00.000Z' } });
      expect(await app.sendMessage(id, 'resume')).toMatchObject({ ok: true, value: { sessionId: id, status: 'idle' } });
    }
    expect(calls.map(c => [c.command, c.stdin])).toEqual([['/fake/codex', 'launch'], ['/fake/codex', 'resume'], ['/fake/claude', 'launch'], ['/fake/claude', 'resume']]);
    expect(calls[1]?.args).toContain('codex_1');
    expect(calls[3]?.args).toContain('claude_1');
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).sessions).toHaveLength(2);
  });

  it('exposes failed status and refuses timeouts; stop probes prevent calls', async () => {
    const { cli } = await modules();
    const dir = scratch();
    let calls = 0;
    let timedOut = false;
    const run = async () => { calls++; return { code: 1, stdout: '{"type":"thread.started","thread_id":"failed_1"}', stderr: '', timedOut, missing: false }; };
    const make = (killed: () => boolean) => cli.createCliAgentApps({ commands: { codex: '/fake/codex' }, run, killed, ledgerPath: join(dir, 'ledger.json'), now: () => new Date('2026-01-01T00:00:00Z') })[0];
    expect(await make(() => false).launchTask({ prompt: 'x' })).toMatchObject({ ok: true, value: { status: 'failed' } });
    timedOut = true;
    expect(await make(() => false).launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'failed' });
    for (const probe of [() => true, () => { throw new Error('probe'); }]) {
      expect(await make(probe).launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'killed' });
      expect(await make(probe).sendMessage('failed_1', 'x')).toMatchObject({ ok: false, code: 'killed' });
    }
    expect(calls).toBe(2);
  });

  it('reports unsupported Devin and desktop constraints without starting either', async () => {
    const { cli, desktop } = await modules();
    const devin = cli.createCliAgentApps({ commands: { devin: '/fake/devin' } })[2];
    expect(await devin.describe()).toMatchObject({ available: false, capabilities: { launchTask: { supported: false } } });
    expect(await devin.launchTask({ prompt: 'x' })).toMatchObject({ ok: false, code: 'unsupported' });
    const app = desktop.createDesktopAgentApps({ platform: 'linux' })[0];
    expect(await app.describe()).toMatchObject({ available: false, capabilities: { launchTask: { supported: true } } });
    expect(await app.launchTask({ prompt: 'x', model: 'test' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await app.launchTask({ prompt: 'x', cwd: '/fake' })).toMatchObject({ ok: false, code: 'unsupported' });
  });
});
