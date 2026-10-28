import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLocusBusPeers, resolveBusPeer } from '../src/core/fleet/bus-identity.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

function probe(stdout: string, error: object | null = null, stderr = ''): void {
  execFile.mockImplementation((_file, _args, _options, callback) => callback(error, stdout, stderr));
}

beforeEach(() => vi.resetAllMocks());

describe('bus peer identity', () => {
  it('uses local labels only when a Locus registry is unavailable', () => {
    expect(resolveBusPeer('local:worker-1')).toEqual({ id: 'local:worker-1', source: 'local' });
    expect(resolveBusPeer('local:worker-1', null).source).toBe('local');
  });

  it('uses the Locus registry when present and refuses unknown peers', () => {
    expect(resolveBusPeer('worker-1', [{ id: 'worker-1' }])).toEqual({ id: 'worker-1', source: 'locus' });
    expect(() => resolveBusPeer('worker-2', [{ id: 'worker-1' }])).toThrow('absent');
  });

  it.each(['', '../worker', 'worker/1', 'worker\n', 'worker\r', 'worker 1', 'a'.repeat(129), '<admin>'])(
    'rejects unsafe identifiers %j', (id) => {
      expect(() => resolveBusPeer(id)).toThrow('Invalid bus peer identifier');
    });

  it.each([
    [], [{ id: 'worker' }, { id: 'worker' }], [{ id: 'worker' }, { id: '../bad' }],
    [{ id: 'worker' }, null], [{ id: 'worker' }, []], [{ id: 1 }],
  ].map((peers) => [peers]))('rejects incomplete or ambiguous registries', (peers) => {
    expect(() => resolveBusPeer('worker', peers as never)).toThrow('registry');
  });
});

describe('optional Locus peer discovery', () => {
  it('runs a bounded shell-free probe and projects only peer identifiers', async () => {
    probe(JSON.stringify({ schema: 'locus.peers.v1', peers: [{
      session_id: 'worker', engine_id: 'codex', task: 'withheld', cwd: '/private/path', pid: 12345,
    }] }));
    expect(await loadLocusBusPeers()).toEqual([{ id: 'worker' }]);
    expect(execFile).toHaveBeenCalledWith('locus', ['peers', 'list', '--json'], {
      shell: false, encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1_024, windowsHide: true,
    }, expect.any(Function));
  });

  it('retains an available empty directory and denies every peer instead of falling back', async () => {
    probe(JSON.stringify({ schema: 'locus.peers.v1', peers: [] }));
    const directory = await loadLocusBusPeers();
    expect(directory).toEqual([]);
    expect(() => resolveBusPeer('worker', directory)).toThrow('absent');
  });

  it('allows local fallback when the executable is absent', async () => {
    probe('', { code: 'ENOENT' });
    expect(await loadLocusBusPeers()).toBeNull();
  });

  it.each(['unrecognized', 'unknown'])('allows an explicitly %s peers subcommand', async (word) => {
    probe('', { code: 2 }, `error: ${word} subcommand 'peers'\n\nUsage: locus [COMMAND]`);
    expect(await loadLocusBusPeers()).toBeNull();
  });

  it.each([
    [{}, 'private details'],
    [{ code: null, signal: 'SIGTERM' }, 'private details'],
    [{ code: 'EACCES' }, 'private details'],
    [{ code: 'ETIMEDOUT', killed: true }, 'private details'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'private details'],
    [{ code: 1 }, 'private details'],
    [{ code: 2 }, "error: unrecognized subcommand 'other'"],
    [{ code: 2 }, "error: unexpected argument '--json' found"],
    [{ code: 2, killed: true }, "error: unrecognized subcommand 'peers'"],
  ])('fails closed for operational errors without disclosing output', async (error, stderr) => {
    probe('private stdout', error as object, stderr as string);
    await expect(loadLocusBusPeers()).rejects.toThrow('Locus bus peer discovery failed');
  });

  it.each([
    '', '{broken', 'null', '[]', '{}',
    JSON.stringify({ schema: 'locus.peers.v2', peers: [{ session_id: 'worker' }] }),
    JSON.stringify({ schemaVersion: 1, peers: [{ id: 'worker' }] }),
    JSON.stringify({ schema: 'locus.peers.v1', peers: [{ session_id: 'worker' }, { session_id: 'worker' }] }),
    JSON.stringify({ schema: 'locus.peers.v1', peers: [{ session_id: 'worker\n' }] }),
    JSON.stringify({ schema: 'locus.peers.v1', peers: [{ id: 'worker' }] }),
  ])('rejects malformed or unsupported responses', async (stdout) => {
    probe(stdout);
    await expect(loadLocusBusPeers()).rejects.toThrow();
  });
});
