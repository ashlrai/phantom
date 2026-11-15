import { afterEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ connection: vi.fn(), request: vi.fn() }));
vi.mock('../src/core/web/app-control.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/web/app-control.js')>(),
  appConnection: backend.connection, appFetch: backend.request,
}));
import { cmdApp } from '../src/cli/app.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('app CLI twins', () => {
  it.each(['pause', 'resume'])('routes %s through the versioned POST', async action => {
    vi.stubEnv('PHM_APP_CONNECTION_FILE', '/fixture');
    backend.connection.mockResolvedValue({}); backend.request.mockResolvedValue({ ok: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdApp(['steer', action, '--json'])).toBe(0);
    expect(backend.request).toHaveBeenLastCalledWith({}, '/api/app/v1/control', { version: 'app.control.v1', action });
  });
  it('refuses extra arguments without printing their values', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdApp(['steer', 'private-input'])).toBe(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-input');
  });
});
it('lists app control only with explicit app authority in the existing stdio bridge', async () => {
  const { runVerseMcpStdio } = await import('../src/core/verse/verse-mcp-stdio.js');
  for (const configured of [false, true]) {
    const output: string[] = [];
    await runVerseMcpStdio({
      lines: (async function* () { yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); })(),
      write: line => output.push(line), env: configured ? { PHM_APP_CONNECTION_FILE: '/fixture' } : {}, ppid: 0,
      readFile: async () => { throw new Error('no chat credential'); }, fetch: globalThis.fetch,
    });
    expect(JSON.parse(output[0] ?? '{}').result.tools.map((t: { name: string }) => t.name)).toEqual(configured ? ['phm_app_control'] : []);
  }
});
