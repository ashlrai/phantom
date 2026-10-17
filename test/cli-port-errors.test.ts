import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { describeListenError, parsePortArg } from '../src/cli/port.js';
import { parseVerseArgs } from '../src/cli/verse.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
const startServerMock = vi.fn();
vi.mock('../src/core/web/server.js', () => ({ startServer: (...a: unknown[]) => startServerMock(...a) }));

describe('parsePortArg', () => {
  it('accepts 1..65535', () => {
    expect(parsePortArg('1')).toEqual({ n: 1 });
    expect(parsePortArg('4317')).toEqual({ n: 4317 });
    expect(parsePortArg('65535')).toEqual({ n: 65535 });
  });

  it.each(['0', '65536', '99999', 'abc', '12abc', '-1', '1.5', ''])('rejects %j', (raw) => {
    expect(parsePortArg(raw)).toEqual({
      error: `Invalid --port "${raw}": expected a number between 1 and 65535`,
    });
  });

  it('reports a missing value', () => {
    expect(parsePortArg(undefined)).toEqual({
      error: 'Invalid --port "(missing)": expected a number between 1 and 65535',
    });
  });

  it('verse parser returns a usage error (exit 2) for an out-of-range port', () => {
    expect(parseVerseArgs(['--port', '99999'])).toEqual({
      error: 'Invalid --port "99999": expected a number between 1 and 65535',
      code: 2,
    });
  });
});

describe('describeListenError', () => {
  let holder: Server | null = null;
  afterEach(async () => {
    if (holder) await new Promise<void>((r) => holder!.close(() => r()));
    holder = null;
  });

  it('maps a real EADDRINUSE bind failure to an actionable message', async () => {
    holder = createServer();
    await new Promise<void>((r) => holder!.listen(0, '127.0.0.1', () => r()));
    const port = (holder.address() as { port: number }).port;
    const second = createServer();
    const err = await new Promise<unknown>((resolve) => {
      second.once('error', resolve);
      second.listen(port, '127.0.0.1');
    });
    expect(describeListenError(err, port)).toBe(
      `Port ${port} is already in use. Pass --port <other> or stop the process using it.`,
    );
  });

  it('maps EACCES and ignores unknown errors', () => {
    expect(describeListenError(Object.assign(new Error('x'), { code: 'EACCES' }), 80)).toMatch(
      /^Permission denied binding port 80\./,
    );
    expect(describeListenError(new Error('boom'), 80)).toBeNull();
    expect(describeListenError(undefined, 80)).toBeNull();
  });
});

describe('serve/verse startup failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    startServerMock.mockReset();
  });

  for (const cmd of ['serve', 'verse'] as const) {
    it(`phm ${cmd} prints a one-line EADDRINUSE message and exits 1`, async () => {
      startServerMock.mockRejectedValue(
        Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4555'), { code: 'EADDRINUSE' }),
      );
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = cmd === 'serve'
        ? (await import('../src/cli/serve.js')).cmdServe
        : (await import('../src/cli/verse.js')).cmdVerse;
      const code = await run(cmd === 'serve' ? ['--port', '4555'] : ['--port', '4555', '--no-open', '--no-accounts']);
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(
        'Port 4555 is already in use. Pass --port <other> or stop the process using it.',
      );
      expect(errors.join('\n')).not.toContain('EADDRINUSE');
    });

    it(`phm ${cmd} --port 99999 exits 2 without starting a server`, async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
      const run = cmd === 'serve'
        ? (await import('../src/cli/serve.js')).cmdServe
        : (await import('../src/cli/verse.js')).cmdVerse;
      expect(await run(['--port', '99999'])).toBe(2);
      expect(errors.join('\n')).toContain('Invalid --port "99999": expected a number between 1 and 65535');
      expect(startServerMock).not.toHaveBeenCalled();
    });
  }
});
