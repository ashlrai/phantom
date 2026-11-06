import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ get: transport.get }));

import { cmdRadar } from '../src/cli/radar.js';
import * as catalogue from '../src/core/radar/sources.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'radar-cli-'));
  directories.push(directory);
  return directory;
}

describe('Radar CLI integration', () => {
  it('dispatches bare radar through the real CLI and prints JSON usage', async () => {
    const home = await temporaryHome();
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'radar', '--json'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home },
    });
    expect(JSON.parse(stdout).usage).toContain('phm radar run');
  }, 30_000);

  it('reports an HTTP 403 as a warning while successful sources keep the run successful', async () => {
    vi.stubEnv('HOME', await temporaryHome());
    const sources = [
      { id: 'blocked', product: 'Blocked', url: 'https://docs.fixture.org/blocked', kind: 'page' as const, verified: true },
      { id: 'working', product: 'Working', url: 'https://docs.fixture.org/working', kind: 'page' as const, verified: true },
    ];
    vi.spyOn(catalogue, 'loadRadarSources').mockResolvedValue(sources);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    transport.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    transport.get.mockImplementation((url: string, _options: unknown, receive: (response: unknown) => void) => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const response = Object.assign(new EventEmitter(), { statusCode: url.endsWith('/blocked') ? 403 : 200, headers: {}, destroy: vi.fn() });
      queueMicrotask(() => {
        receive(response);
        if (response.statusCode === 200) {
          response.emit('data', Buffer.from('<h1>Working</h1>'));
          response.emit('end');
        }
      });
      return request;
    });
    expect(await cmdRadar(['run', '--json'])).toBe(0);
    const result = JSON.parse(log.mock.calls.at(-1)![0]);
    expect(result).toMatchObject({ ok: true, warnings: ['blocked'], results: [
      { id: 'blocked', status: 'warning', reason: 'source unavailable' },
      { id: 'working', status: 'updated' },
    ] });
    expect(transport.get).toHaveBeenCalledTimes(2);
  });
});
