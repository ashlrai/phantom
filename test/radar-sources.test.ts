import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ get: transport.get }));

import { isPublicRadarUrl, loadRadarSources, radarSourceSchema, radarSourcesSchema, type RadarSource } from '../src/core/radar/sources.js';
import { fetchRadarSource, RADAR_MAX_BYTES, RADAR_TIMEOUT_MS } from '../src/core/radar/fetch.js';

const source: RadarSource = { id: 'fixture-docs', product: 'Fixture product', url: 'https://docs.fixture.org/changes', kind: 'page', verified: true };
const publicAddress = { address: '93.184.216.34', family: 4 };
const directories: string[] = [];

beforeEach(() => {
  transport.lookup.mockReset().mockResolvedValue([publicAddress]);
  transport.get.mockReset().mockImplementation(() => { throw new Error('Unexpected transport access'); });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Synthetic HTTPS response. The real request implementation is always mocked. */
function responseFixture(options: { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; aborted?: boolean; hang?: boolean } = {}) {
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const response = Object.assign(new EventEmitter(), {
    statusCode: options.status ?? 200,
    headers: options.headers ?? {},
    destroy: vi.fn(),
  });
  transport.get.mockImplementation((_url: string, _options: unknown, receive: (value: unknown) => void) => {
    queueMicrotask(() => {
      receive(response);
      if (response.destroy.mock.calls.length || options.hang) return;
      for (const chunk of options.chunks ?? [Buffer.from('Fixture public documentation')]) response.emit('data', chunk);
      if (options.aborted) response.emit('aborted');
      else response.emit('end');
    });
    return request;
  });
  return { request, response };
}

describe('Radar public source catalogue', () => {
  it('accepts every declared source kind and explicit verification state', () => {
    for (const kind of ['page', 'atom', 'npm', 'pypi', 'json']) {
      expect(radarSourceSchema.parse({ ...source, kind, verified: false })).toMatchObject({ kind, verified: false });
    }
    expect(radarSourcesSchema.parse([source])).toEqual([source]);
  });

  it.each([
    'http://docs.fixture.org/changes',
    'file:///fixture',
    `https://fixture-user:placeholder${String.fromCharCode(64)}docs.fixture.org/changes`,
    'https://docs.fixture.org/changes?token=placeholder',
    'https://docs.fixture.org/changes?%74%6f%6b%65%6e=placeholder',
    'https://docs.fixture.org/changes?',
    'https://docs.fixture.org/changes#fragment',
    'https://docs.fixture.org/changes#',
    'https://docs.fixture.org:8443/changes',
    'https://127.0.0.1/changes',
    'https://2130706433/changes',
    'https://[::1]/changes',
    'https://localhost/changes',
    'https://docs.local/changes',
    'https://docs.internal/changes',
    ' https://docs.fixture.org/changes',
    'https://docs.fixture.org/line\nbreak',
    'https://docs.fixture.org\\changes',
  ])('rejects unsafe URL %s', url => {
    expect(isPublicRadarUrl(url)).toBe(false);
    expect(radarSourceSchema.safeParse({ ...source, url }).success).toBe(false);
  });

  it.each(['../fixture', '/fixture', 'fixture.json', 'Fixture', '', 'a'.repeat(81)])('rejects unsafe snapshot id %s', id => {
    expect(radarSourceSchema.safeParse({ ...source, id }).success).toBe(false);
  });

  it('refuses extra request configuration, duplicate identities and implicit verification', () => {
    expect(radarSourceSchema.safeParse({ ...source, headers: { authorization: '<PLACEHOLDER>' } }).success).toBe(false);
    expect(radarSourceSchema.safeParse({ ...source, verified: undefined }).success).toBe(false);
    expect(radarSourceSchema.safeParse({ ...source, product: 'Fixture\nproduct' }).success).toBe(false);
    expect(radarSourcesSchema.safeParse([source, { ...source, url: 'https://other.fixture.org/changes' }]).success).toBe(false);
    expect(radarSourcesSchema.safeParse([]).success).toBe(false);
  });

  it('loads a synthetic catalogue and uses a fixed diagnostic for invalid or missing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'radar-sources-'));
    directories.push(directory);
    const path = join(directory, 'sources.json');
    await writeFile(path, JSON.stringify([source]));
    await expect(loadRadarSources(path)).resolves.toEqual([source]);
    await writeFile(path, '{"fixture_private_content":');
    await expect(loadRadarSources(path)).rejects.toThrow('Radar source catalogue unavailable or invalid');
    await expect(loadRadarSources(join(directory, 'absent.json'))).rejects.toThrow('Radar source catalogue unavailable or invalid');
    await writeFile(path, ' '.repeat(256 * 1024 + 1));
    await expect(loadRadarSources(path)).rejects.toThrow('Radar source catalogue unavailable or invalid');
  });
});

describe('Radar bounded unauthenticated HTTPS GET', () => {
  it('sends only fixed public GET headers and pins the checked DNS address', async () => {
    responseFixture();
    await expect(fetchRadarSource(source)).resolves.toBe('Fixture public documentation');
    expect(transport.lookup).toHaveBeenCalledWith('docs.fixture.org', { all: true, family: 4 });
    expect(transport.get).toHaveBeenCalledTimes(1);
    const [url, options] = transport.get.mock.calls[0];
    expect(url).toBe(source.url);
    expect(options).toMatchObject({ method: 'GET', agent: false, headers: { accept: '*/*', 'accept-encoding': 'identity' } });
    expect(Object.keys(options.headers).sort()).toEqual(['accept', 'accept-encoding']);
    expect(options).not.toHaveProperty('auth');
    expect(options).not.toHaveProperty('ca');
    const callback = vi.fn();
    options.lookup('ignored.fixture.org', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, publicAddress.address, 4);
    const allCallback = vi.fn();
    options.lookup('ignored.fixture.org', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [publicAddress]);
  });

  it('does not resolve or request unverified sources', async () => {
    await expect(fetchRadarSource({ ...source, verified: false })).rejects.toThrow();
    expect(transport.lookup).not.toHaveBeenCalled();
    expect(transport.get).not.toHaveBeenCalled();
  });

  it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1'])('rejects non-public DNS address %s before GET', async address => {
    transport.lookup.mockResolvedValue([{ address, family: 4 }]);
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    expect(transport.get).not.toHaveBeenCalled();
  });

  it('rejects empty DNS and mixed public/private answers', async () => {
    transport.lookup.mockResolvedValue([]);
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    transport.lookup.mockResolvedValue([publicAddress, { address: '127.0.0.1', family: 4 }]);
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    expect(transport.get).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 401, 404, 500])('refuses HTTP status %s without following a redirect', async status => {
    const fixture = responseFixture({ status, headers: { location: 'https://127.0.0.1/private' } });
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(fixture.response.destroy).toHaveBeenCalled();
  });

  it.each([
    { 'content-length': String(RADAR_MAX_BYTES + 1) },
    { 'content-length': 'not-a-length' },
    { 'content-encoding': 'gzip' },
  ])('refuses oversized or unsupported response headers %#', async headers => {
    responseFixture({ headers });
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
  });

  it('caps streamed bodies even without a declared length', async () => {
    const fixture = responseFixture({ chunks: [Buffer.alloc(RADAR_MAX_BYTES), Buffer.from('overflow')] });
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    expect(fixture.response.destroy).toHaveBeenCalled();
    expect(fixture.request.destroy).toHaveBeenCalled();
  });

  it('refuses truncated response bodies', async () => {
    responseFixture({ aborted: true });
    await expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
  });

  it('bounds stalled body reads by the same 15-second deadline', async () => {
    vi.useFakeTimers();
    const fixture = responseFixture({ hang: true });
    const pending = expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    await vi.advanceTimersByTimeAsync(RADAR_TIMEOUT_MS);
    await pending;
    expect(fixture.request.destroy).toHaveBeenCalled();
  });

  it('never starts a request if DNS resolves after the overall deadline', async () => {
    vi.useFakeTimers();
    let resolveDns!: (addresses: Array<{ address: string; family: number }>) => void;
    transport.lookup.mockImplementation(() => new Promise(resolve => { resolveDns = resolve; }));
    const pending = expect(fetchRadarSource(source)).rejects.toThrow('Radar public source unavailable');
    await vi.advanceTimersByTimeAsync(RADAR_TIMEOUT_MS);
    await pending;
    resolveDns([publicAddress]);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.get).not.toHaveBeenCalled();
  });
});
