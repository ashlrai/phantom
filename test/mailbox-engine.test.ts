import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { spawnEngine } from '../src/core/run/engines.js';
import { runMailboxEngine, type MailboxEngineRequest } from '../src/core/run/mailbox-engine.js';

vi.mock('../src/core/run/engines.js', () => ({ spawnEngine: vi.fn() }));
const fakeEngine = vi.mocked(spawnEngine);
const cfg = {} as AshlrConfig;
const codexReply = [
  { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'not a reply' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'reply ✓' } },
  { type: 'turn.completed', usage: {} },
].map(event => JSON.stringify(event)).join('\n');
const claudeReply = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'reply ✓' });
let root: string;
let request: MailboxEngineRequest;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mailbox-engine-'));
  // macOS temp roots have a /var → /private/var alias.
  root = await realpath(root);
  request = { engine: 'codex', sandboxDir: root, inbox: 'inbox.txt', outbox: 'outbox.txt',
    launcher: { bin: 'fake-confinement', prefixArgs: ['--jail', root] } };
  await writeFile(join(root, request.inbox), 'Implement $(touch escaped); `literal`\nUnicode ✓');
  fakeEngine.mockReset();
  fakeEngine.mockResolvedValue({ ok: true, output: codexReply });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sandbox mailbox engine adapters', () => {
  it.each(['codex', 'claude'] as const)('stages a private prompt and publishes only the %s final reply', async engine => {
    request.engine = engine;
    request.model = 'model with spaces';
    fakeEngine.mockImplementation(async (command, actualCfg, options) => {
      expect(actualCfg).toBe(cfg);
      expect(command).toEqual({ bin: engine, cwd: root, args: engine === 'codex'
        ? ['exec', '--cd', root, '--json', '--model', request.model!, '-']
        : ['-p', '--output-format', 'json', '--model', request.model!] });
      expect(options?.launcher).toBe(request.launcher);
      const exchange = (await readdir(root)).find(name => name.startsWith('.phantom-mailbox-'))!;
      const promptPath = join(root, exchange, 'prompt.txt');
      expect(options?.stdin).toBe(await readFile(promptPath, 'utf8'));
      expect(options?.stdin).toBe(await readFile(join(root, 'inbox.txt'), 'utf8'));
      expect((await stat(promptPath)).mode & 0o777).toBe(0o600);
      expect(command.args.join(' ')).not.toContain('touch escaped');
      return { ok: true, output: engine === 'codex' ? codexReply : claudeReply };
    });
    await runMailboxEngine(request, cfg);
    expect(await readFile(join(root, 'outbox.txt'), 'utf8')).toBe('reply ✓');
    expect((await stat(join(root, 'outbox.txt'))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['inbox.txt', 'outbox.txt']);
  });

  it.each([
    ['codex', '{'],
    ['codex', JSON.stringify({ type: 'turn.completed' })],
    ['codex', codexReply + '\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'late' } })],
    ['codex', codexReply + '\n' + JSON.stringify({ type: 'turn.failed' })],
    ['claude', JSON.stringify({ type: 'result', subtype: 'error_during_execution', result: 'partial' })],
    ['claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'partial' })],
    ['claude', JSON.stringify({ type: 'result', subtype: 'success', result: '' })],
  ] as const)('refuses incomplete or failed %s output (%#)', async (engine, output) => {
    request.engine = engine;
    fakeEngine.mockResolvedValue({ ok: true, output });
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['inbox.txt']);
  });

  it('preserves an existing delivery and the inbox', async () => {
    await writeFile(join(root, 'outbox.txt'), 'previous reply');
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow();
    expect(await readFile(join(root, 'outbox.txt'), 'utf8')).toBe('previous reply');
    expect(await readdir(root)).toEqual(['inbox.txt', 'outbox.txt']);
  });

  it('does not expose engine failure diagnostics or publish partial output', async () => {
    fakeEngine.mockResolvedValue({ ok: false, output: codexReply, error: 'private diagnostic' });
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('Mailbox engine failed or was cancelled');
    expect(await readdir(root)).toEqual(['inbox.txt']);
  });

  it('requires confinement before calling an engine', async () => {
    request.launcher = undefined!;
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('requires confinement');
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it('propagates deadlines and cancellation and never publishes after cancellation', async () => {
    const controller = new AbortController();
    request.signal = controller.signal;
    request.timeoutMs = 100;
    fakeEngine.mockImplementation(async (_cmd, _cfg, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(options?.timeoutMs).toBe(100);
      controller.abort();
      return { ok: true, output: codexReply };
    });
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('cancelled');
    expect(await readdir(root)).toEqual(['inbox.txt']);
    fakeEngine.mockClear();
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('cancelled');
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it.each(['inbox', 'outbox'] as const)('rejects escaping %s paths before launch', async field => {
    request[field] = '../escape.txt';
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('inside the sandbox');
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it('rejects inbox symlinks', async () => {
    await symlink(join(root, 'inbox.txt'), join(root, 'alias.txt'));
    request.inbox = 'alias.txt';
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow();
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it('rejects oversized inboxes before launch', async () => {
    await writeFile(join(root, 'inbox.txt'), 'x'.repeat(1024 * 1024 + 1));
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('bounded regular file');
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it('refuses a delivery created while the engine runs', async () => {
    fakeEngine.mockImplementation(async () => {
      await writeFile(join(root, 'outbox.txt'), 'concurrent delivery');
      return { ok: true, output: codexReply };
    });
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow();
    expect(await readFile(join(root, 'outbox.txt'), 'utf8')).toBe('concurrent delivery');
  });

  it('refuses an outbox symlink without invoking the engine or changing its target', async () => {
    await symlink(join(root, 'inbox.txt'), join(root, 'outbox.txt'));
    const original = await readFile(join(root, 'inbox.txt'), 'utf8');
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('already exists');
    expect(fakeEngine).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'inbox.txt'), 'utf8')).toBe(original);
  });

  it('cleans up when the runner throws', async () => {
    fakeEngine.mockRejectedValue(new Error('runner failed'));
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow('runner failed');
    expect(await readdir(root)).toEqual(['inbox.txt']);
  });

  it('rejects invalid UTF-8 input before invoking the engine', async () => {
    await writeFile(join(root, 'inbox.txt'), Buffer.from([0xff]));
    await expect(runMailboxEngine(request, cfg)).rejects.toThrow();
    expect(fakeEngine).not.toHaveBeenCalled();
  });

  it('bounds replies and hides malformed protocol contents from errors', async () => {
    for (const output of ['private malformed protocol', 'x'.repeat(1024 * 1024 + 1)]) {
      fakeEngine.mockResolvedValue({ ok: true, output });
      await expect(runMailboxEngine(request, cfg)).rejects.toThrow('Mailbox engine did not return a valid successful reply');
      expect(await readdir(root)).toEqual(['inbox.txt']);
    }
  });

});
