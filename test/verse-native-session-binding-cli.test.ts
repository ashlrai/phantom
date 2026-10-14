import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const backend = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/verse/session-store.js', () => ({ readVerseNativeSessionBinding: backend.read,
  isValidSessionId: (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) }));
vi.mock('../src/core/web/server.js', () => { throw new Error('Native binding CLI must not start/import a web server'); });
vi.mock('../src/core/verse/session-engine.js', () => { throw new Error('Native binding CLI must not import an engine'); });
import { cmdVerse } from '../src/cli/verse.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  backend.read.mockReset().mockReturnValue({ sessionId: 'chat-1', engine: 'codex', nativeSessionId: 'thread-1', nativeIdState: 'recorded',
    savedStatus: 'running', savedUpdatedAt: '2026-10-14T01:02:03.000Z', liveOwnerState: 'unverified', desktopAttachment: 'unverified', controlEnabled: false });
  log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe('saved binding CLI dispatch', () => {
  it('reads only the selected saved ID without server startup and preserves unverified owner labels', async () => {
    expect(await cmdVerse(['native-binding', '--id', 'chat-1', '--json'])).toBe(0);
    expect(backend.read).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ liveOwnerState: 'unverified', controlEnabled: false });
  });
  it('labels saved running status without claiming live execution', async () => {
    expect(await cmdVerse(['native-binding', '--id', 'chat-1'])).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('Saved status: running'); expect(log.mock.calls[0]![0]).toContain('Live owner: unverified');
  });
  it.each([['--help'], ['-h']])('help %j performs no metadata read', async (...args) => {
    expect(await cmdVerse(['native-binding', ...args])).toBe(0); expect(backend.read).not.toHaveBeenCalled();
  });
  it.each([[], ['--id', '../PRIVATE'], ['--id', 'chat-1', '--connect'], ['--id', 'chat-1', '--id', 'other'],
    ['--id', 'chat-1', '--json', '--json'], ['--root', '/PRIVATE'], ['--id', '--json']])('rejects invalid arguments %# without reads', async (...args) => {
    expect(await cmdVerse(['native-binding', ...args])).toBe(2); expect(backend.read).not.toHaveBeenCalled();
  });
  it('reports unavailable with fixed redacted error', async () => {
    backend.read.mockReturnValue(null); expect(await cmdVerse(['native-binding', '--id', 'missing', '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({ code: 'VERSE_NATIVE_BINDING_NOT_FOUND', error: 'Native session binding unavailable.' });
  });
  it('redacts unexpected reader failure', async () => {
    backend.read.mockImplementation(() => { throw new Error('PRIVATE file path'); });
    expect(await cmdVerse(['native-binding', '--id', 'chat-1', '--json'])).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  });
  it('registers saved-only observation without control authority', () => {
    const command = AGENT_COMMANDS.find(row => row.usage.startsWith('phm verse native-binding'))!;
    expect(command.safety).toBe('read'); expect(command.jsonShape).toContain('liveOwnerState unverified');
  });
});
