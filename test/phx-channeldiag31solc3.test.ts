import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdComms } from '../src/cli/comms.js';
import { setTelegramTransportForTests } from '../src/core/integrations/telegram.js';

let home: string;
const token = 'fake-diag-token-never-output';
const chatId = '987654321';
const identity = 'fake-diag-person@example.invalid';
let log: ReturnType<typeof vi.spyOn>, err: ReturnType<typeof vi.spyOn>;
const provider = vi.fn(() => { throw new Error('provider calls forbidden'); });
function config(botToken: string | null = token, channel = 'telegram', enabled = true) {
  writeFileSync(join(home, '.ashlr/config.json'), JSON.stringify({ comms: {
    enabled, channel, telegram: { botToken: botToken ?? undefined, chatId }, imessageHandle: identity,
  } }));
}
function health(minutes = 0, error: string | null = null) {
  const date = new Date(Date.now() - minutes * 60_000).toISOString();
  writeFileSync(join(home, '.ashlr/comms/telegram-health.json'), JSON.stringify({ lastPoll: date, lastSuccess: date, error }));
}
async function diagnose() {
  await cmdComms(['diagnose', '--json']);
  return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
}
function snapshot(path = home): unknown {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).map(entry =>
    [entry.name, entry.isDirectory() ? snapshot(join(path, entry.name)) : readFileSync(join(path, entry.name), 'utf8')]));
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'channel-diag-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  mkdirSync(join(home, '.ashlr/comms'), { recursive: true });
  mkdirSync(join(home, '.ashlr/fleet/bus-inbox'), { recursive: true, mode: 0o700 });
  chmodSync(join(home, '.ashlr/fleet'), 0o700);
  writeFileSync(join(home, '.ashlr/fleet/bus-inbox/messages.json'), '[]', { mode: 0o600 });
  mkdirSync(join(home, '.ashlr-runs/leader'), { recursive: true });
  writeFileSync(join(home, '.ashlr-runs/leader/MASON-INBOX.md'), identity);
  config(); health();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
  setTelegramTransportForTests(provider);
  vi.stubGlobal('fetch', provider);
});
afterEach(() => {
  const output = JSON.stringify([log.mock.calls, err.mock.calls]);
  for (const secret of [token, chatId, identity]) expect(output).not.toContain(secret);
  expect(provider).not.toHaveBeenCalled();
  provider.mockClear();
  setTelegramTransportForTests(null);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
it('joins healthy configured local evidence without claiming delivery or mutating state', async () => {
  const before = snapshot();
  const result = await diagnose();
  expect(result).toMatchObject({ schemaVersion: 1, readOnly: true, configured: true,
    credential: { present: true, source: 'config' }, requests: { pending: 0, outstanding: 0 } });
  expect(result.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'telegram-poller', state: 'ok' }),
    expect.objectContaining({ id: 'local-bus', state: 'ok' }),
    expect.objectContaining({ id: 'local-receiver', state: 'ok' }),
    expect.objectContaining({ id: 'delivery', state: 'unsupported' }),
  ]));
  expect(result.checks.every((check: { reason: string; nextStep: string }) => check.reason && check.nextStep.startsWith('phm comms '))).toBe(true);
  expect(snapshot()).toEqual(before);
});
it('reports stale poller independently of configuration', async () => {
  health(8);
  const result = await diagnose();
  expect(result.configured).toBe(true);
  expect(result.checks).toContainEqual(expect.objectContaining({ reason: 'poller-stale-or-never-polled' }));
});
it('reports missing credential despite a fresh heartbeat', async () => {
  config(null);
  expect((await diagnose()).credential).toEqual({ present: false, source: 'missing' });
});
it('identifies the established environment credential source', async () => {
  config(null); vi.stubEnv('TELEGRAM_BOT_TOKEN', token);
  expect((await diagnose()).credential).toEqual({ present: true, source: 'environment' });
});
it('reports pending and outstanding counts without printing request content', async () => {
  writeFileSync(join(home, '.ashlr/comms/requests.jsonl'), [
    { status: 'pending', type: 'report', text: identity },
    { status: 'sent', type: 'question', text: token },
  ].map(row => JSON.stringify(row)).join('\n'));
  const result = await diagnose();
  expect(result.requests).toMatchObject({ pending: 1, outstanding: 1 });
  expect(result.checks).toContainEqual(expect.objectContaining({ reason: 'pending-requests-observed' }));
});
it('reports unavailable bus separately from healthy poller', async () => {
  writeFileSync(join(home, '.ashlr/fleet/bus-inbox/messages.json'), token);
  const result = await diagnose();
  expect(result.checks).toContainEqual(expect.objectContaining({ id: 'local-bus', reason: 'bus-source-unavailable' }));
  expect(result.checks).toContainEqual(expect.objectContaining({ id: 'telegram-poller', state: 'ok' }));
});
it('reports missing receiver source rather than healthy', async () => {
  rmSync(join(home, '.ashlr-runs'), { recursive: true });
  expect((await diagnose()).checks).toContainEqual(expect.objectContaining({ reason: 'receiver-inbox-source-missing', state: 'unavailable' }));
});
it('sanitizes health errors and malformed configuration', async () => {
  health(0, token + identity);
  expect((await diagnose()).checks).toContainEqual(expect.objectContaining({ reason: 'telegram-health-error' }));
  writeFileSync(join(home, '.ashlr/config.json'), token);
  expect((await diagnose()).checks).toContainEqual(expect.objectContaining({ reason: 'configuration-unreadable' }));
});
it('does not seed a missing config and supports safe human output', async () => {
  rmSync(join(home, '.ashlr/config.json'));
  await cmdComms(['diagnose']);
  expect(existsSync(join(home, '.ashlr/config.json'))).toBe(false);
  expect(log.mock.calls.flat().join(' ')).toContain('delivery unverified');
});
it('rejects sending options before diagnosing', async () => {
  expect(await cmdComms(['diagnose', '--send'])).toBe(2);
});
it('leaves existing health output unchanged', async () => {
  expect(await cmdComms(['health', '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ tokenPresent: true, pollerAlive: true, error: null });
});
