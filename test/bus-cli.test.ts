import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdBus } from '../src/cli/bus.js';
import { createBusMailbox, type BusMailbox } from '../src/core/fleet/bus-mailbox.js';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
let home: string;
let time: number;
let bus: BusMailbox;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
const envelope = (overrides: Partial<BusEnvelope> = {}): BusEnvelope => ({
  id: 'message-1', from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 1000,
  body: { text: 'FAKE local test message', reference: 'phm_example' }, ...overrides,
});
const sendArgs = ['send', '--from', 'codex-cmp', '--to', 'fleet', '--body', '{"hello":"world"}'];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-bus-test-'));
  time = 1000;
  bus = createBusMailbox(home, () => time);
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

async function invoke(args: string[], load = () => bus) {
  stdout.mockClear(); stderr.mockClear();
  const code = await cmdBus(args, load);
  const lines = stdout.mock.calls.map(call => String(call[0]));
  return { code, lines, error: stderr.mock.calls.map(call => String(call[0])).join('\n') };
}
async function json(args: string[], load = () => bus) {
  const result = await invoke([...args, '--json'], load);
  expect(result.lines).toHaveLength(1);
  expect(result.error).toBe('');
  return { ...result, value: JSON.parse(result.lines[0]!) };
}
function child(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'bus', ...args], {
    cwd: repo, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
  });
}

describe('phm bus CLI', () => {
  it('sends an opaque body with defaults and reads it without acknowledging', async () => {
    const sent = await json(sendArgs);
    expect(sent.code).toBe(0);
    expect(sent.value).toEqual({ ok: true, id: expect.stringMatching(/^[a-f0-9-]{36}$/), replayed: false });
    const first = await json(['inbox', '--to', 'fleet']);
    expect(first.value).toEqual({ ok: true, hasMore: false, messages: [{
      id: sent.value.id, from: 'codex-cmp', to: 'fleet', priority: 'P2', ttl: 300000, body: { hello: 'world' },
    }] });
    expect((await json(['inbox', '--to', 'fleet'])).value).toEqual(first.value);
    expect((await json(['inbox', '--to', 'other'])).value.messages).toEqual([]);
  });

  it('honors explicit identity, priority, TTL and idempotent ack', async () => {
    const args = [...sendArgs, '--id', 'retry-1', '--priority', 'P0', '--ttl', '50'];
    expect((await json(args)).value.replayed).toBe(false);
    expect((await json(args)).value.replayed).toBe(true);
    time += 10;
    expect((await json(['inbox', '--to', 'fleet'])).value.messages[0]).toMatchObject({ id: 'retry-1', priority: 'P0', ttl: 40 });
    expect((await json(['ack', 'retry-1', '--to', 'other'])).code).toBe(1);
    expect((await json(['ack', 'retry-1', '--to', 'fleet'])).value).toEqual({ ok: true, id: 'retry-1', acknowledged: true, replayed: false });
    expect((await json(['ack', 'retry-1', '--to', 'fleet'])).value.replayed).toBe(true);
    expect((await json(['inbox', '--to', 'fleet'])).value.messages).toEqual([]);
  });

  it.each(['null', 'false', '0', '""', '[]', '{"nested":[true,"東京"]}'])(
    'preserves JSON body %s', async body => {
      expect((await json(['send', '--from', 'a', '--to', 'b', '--body', body])).code).toBe(0);
      expect((await json(['inbox', '--to', 'b'])).value.messages[0].body).toEqual(JSON.parse(body));
    },
  );

  it.each([
    [], ['send'], ['unknown'], ['toString'], ['constructor'], ['send', '--json', '--json'],
    ['send', '--from'], [...sendArgs, '--ttl'], [...sendArgs, '--ttl', '--id', 'm'],
    [...sendArgs, '--to', 'second'], [...sendArgs, '--priority', 'urgent'],
    [...sendArgs, '--typo'], [...sendArgs, 'extra'], ['inbox'], ['inbox', '--to', 'fleet', 'extra'],
    ['inbox', '--to', 'fleet', '--body', '{}'], ['ack', '--to', 'fleet'],
    ['ack', 'a', 'b', '--to', 'fleet'], ['ack', 'a', '--to', 'fleet', '--ttl', '5'],
    ['inbox', '--to', ''], ['inbox', '--to', 'two words'], ['inbox', '--to', 'trailing\n'],
    ['send', '--from', 'a', '--to', 'b', '--body', '{'],
    ['send', '--from', 'a', '--to', 'b', '--body', '--help'],
  ].map(args => [args]))('rejects malformed argv before loading core: %j', async args => {
    const load = vi.fn(() => bus);
    const result = await json(args, load);
    expect(result.code).toBe(2);
    expect(result.value.ok).toBe(false);
    expect(result.value.error.code).toBe('usage');
    expect(load).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it.each(['0', '-1', '1.2', '1e3', '10ms', '9007199254740992', 'Infinity', 'NaN'])(
    'rejects an invalid TTL without coercion: %s', async ttl => {
      expect((await json([...sendArgs, '--ttl', ttl])).code).toBe(2);
      expect(readdirSync(home)).toEqual([]);
    },
  );
  it.each(['0', '1001', '-2', '2.5', '2items'])(
    'rejects invalid inbox limit %s', async limit => {
      expect((await json(['inbox', '--to', 'fleet', '--limit', limit])).code).toBe(2);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.each([['--help'], ['-h'], ['send', '--help'], ['ack', '-h'], ['inbox', '--help']].map(args => [args]))(
    'help is side-effect free: %j', async args => {
      const load = vi.fn(() => bus);
      const result = await json(args, load);
      expect(result.code).toBe(0);
      expect(result.value.usage).toContain('phm bus');
      expect(load).not.toHaveBeenCalled();
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it('accepts the global JSON flag before the verb', async () => {
    const result = await invoke(['--json', ...sendArgs]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.lines[0]!).ok).toBe(true);
  });

  it.each(['-message', '-h', '--json', '--id'])('round-trips flag-shaped message ID %s', async id => {
    expect((await json([...sendArgs, `--id=${id}`])).code).toBe(0);
    const ack = await invoke(['ack', '--to', 'fleet', '--json', '--', id]);
    expect(ack.code).toBe(0);
    expect(JSON.parse(ack.lines[0]!)).toEqual({ ok: true, id, acknowledged: true, replayed: false });
    expect(bus.inbox('fleet').messages).toEqual([]);
  });

  it('does not interpret literal --json as a JSON output flag', async () => {
    await json([...sendArgs, '--id=--json']);
    const result = await invoke(['ack', '--to', 'fleet', '--', '--json']);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(['Acknowledged: --json']);
  });

  it('accepts equals syntax for flag-shaped routing labels and body strings', async () => {
    expect((await json(['send', '--from=--sender', '--to=--recipient', '--body="--help"'])).code).toBe(0);
    expect((await json(['inbox', '--to=--recipient'])).value.messages[0]).toMatchObject({ from: '--sender', to: '--recipient', body: '--help' });
  });

  it('has useful human success, empty inbox and error output', async () => {
    expect((await invoke(['inbox', '--to', 'fleet'])).lines).toEqual(['No pending messages.']);
    expect((await invoke([...sendArgs, '--id', 'm'])).lines[0]).toContain('accepted: m');
    expect((await invoke(['inbox', '--to', 'fleet'])).lines[0]).toContain('{"hello":"world"}');
    expect((await invoke(['ack', 'm', '--to', 'fleet'])).lines).toEqual(['Acknowledged: m']);
    const invalid = await invoke(['unknown']);
    expect(invalid.code).toBe(2);
    expect(invalid.lines).toEqual([]);
    expect(invalid.error).toContain('Usage: phm bus');
  });

  it('never prints or persists runtime-built FAKE credentials', async () => {
    const FAKE = ['gh', 'p_', 'FAKE', 'Ab12'.repeat(10)].join('');
    const result = await json(['send', '--from', 'a', '--to', 'b', '--body', JSON.stringify({ value: FAKE })]);
    expect(result.code).toBe(1);
    expect(result.value.error.code).toBe('credentials');
    expect(result.lines.join('').includes(FAKE)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    const unknown = await json([...sendArgs, '--' + FAKE]);
    expect(unknown.code).toBe(2);
    expect(unknown.lines.join('').includes(FAKE)).toBe(false);
  });

  it('keeps unexpected core exceptions out of stdout and stderr', async () => {
    const result = await json(sendArgs, () => { throw new Error('FAKE private path and raw data'); });
    expect(result.code).toBe(1);
    expect(result.value).toEqual({ ok: false, error: { code: 'operation-failed', message: 'Bus operation failed.' } });
  });

  it('rejects oversized and excessively nested JSON before storage', async () => {
    const large = await json(['send', '--from', 'a', '--to', 'b', '--body', JSON.stringify('x'.repeat(MAX_BUS_ENVELOPE_BYTES))]);
    expect(large.code).toBe(2);
    const deep = await json(['send', '--from', 'a', '--to', 'b', '--body', '['.repeat(33) + '0' + ']'.repeat(33)]);
    expect(deep.code).toBe(2);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('local durable bus core', () => {
  it('persists across instances; expiration and replay do not renew TTL', () => {
    bus.send(envelope());
    time += 999;
    expect(createBusMailbox(home, () => time).inbox('fleet').messages[0].ttl).toBe(1);
    time++;
    expect(bus.send(envelope()).replayed).toBe(true);
    expect(bus.inbox('fleet').messages).toEqual([]);
    expect(bus.ack('message-1', 'fleet').acknowledged).toBe(true);
  });

  it('orders by priority then acceptance and reports truncation', async () => {
    bus.send(envelope({ id: 'low', priority: 'P3' }));
    bus.send(envelope({ id: 'first', priority: 'P0' }));
    time++;
    bus.send(envelope({ id: 'second', priority: 'P0' }));
    bus.send(envelope({ id: 'middle', priority: 'P1' }));
    const result = await json(['inbox', '--to', 'fleet', '--limit', '2']);
    expect(result.value.hasMore).toBe(true);
    expect(result.value.messages.map((m: BusEnvelope) => m.id)).toEqual(['first', 'second']);
    expect(bus.inbox('fleet').messages.map(m => m.id)).toEqual(['first', 'second', 'middle', 'low']);
    const human = await invoke(['inbox', '--to', 'fleet', '--limit', '1']);
    expect(human.lines[0]).toContain('More pending messages');
  });

  it('rejects same-ID content or recipient conflicts and preserves the original', async () => {
    bus.send(envelope());
    expect(() => bus.send(envelope({ body: 'changed' }))).toThrow('different contents');
    expect(() => bus.send(envelope({ to: 'other' }))).toThrow('different contents');
    expect(bus.inbox('fleet').messages).toEqual([envelope()]);
    const missing = await json(['ack', 'unknown', '--to', 'fleet']);
    expect(missing.code).toBe(1);
    expect(missing.value.error.code).toBe('not-found');
    expect(readdirSync(join(home, 'bus', 'records'))).toHaveLength(1);
  });

  it('hashes path-shaped labels and message IDs instead of using them as paths', () => {
    const input = envelope({ id: '../outside/message', to: '../../recipient' });
    bus.send(input);
    expect(bus.inbox(input.to).messages).toEqual([input]);
    bus.ack(input.id, input.to);
    expect(bus.inbox(input.to).messages).toEqual([]);
    expect(readdirSync(home)).toEqual(['bus']);
    expect(readdirSync(join(home, 'bus', 'records')).every(name => /^[ma]-[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  });

  it('missing inbox and failed ack create no store', () => {
    expect(bus.inbox('fleet')).toEqual({ messages: [], hasMore: false });
    expect(() => bus.ack('missing', 'fleet')).toThrow('not found');
    expect(readdirSync(home)).toEqual([]);
  });

  it('reserves count capacity for acknowledgments, preserving read and replay at capacity', () => {
    const limited = createBusMailbox(home, () => time, { maxMessages: 2 });
    limited.send(envelope({ id: 'one' }));
    limited.send(envelope({ id: 'two' }));
    expect(() => limited.send(envelope({ id: 'three' }))).toThrow('capacity');
    expect(limited.send(envelope({ id: 'one' })).replayed).toBe(true);
    expect(limited.inbox('fleet').messages).toHaveLength(2);
    limited.ack('one', 'fleet'); limited.ack('two', 'fleet');
    expect(limited.inbox('fleet').messages).toEqual([]);
    expect(readdirSync(join(home, 'bus', 'records'))).toHaveLength(4);
  });

  it('reserves byte capacity for acknowledgments and rejects oversized new traffic safely', () => {
    const limited = createBusMailbox(home, () => time, { maxBytes: 2048 });
    limited.send(envelope());
    expect(() => limited.send(envelope({ id: 'large', body: 'x'.repeat(1200) }))).toThrow('capacity');
    expect(limited.inbox('fleet').messages).toEqual([envelope()]);
    expect(limited.ack('message-1', 'fleet').acknowledged).toBe(true);
    expect(limited.inbox('fleet').messages).toEqual([]);
  });

  it('recovers a linked publication at capacity before refusing new traffic', () => {
    const limited = createBusMailbox(home, () => time, { maxMessages: 1 });
    limited.send(envelope());
    const name = readdirSync(join(home, 'bus', 'records'))[0]!;
    const record = join(home, 'bus', 'records', name);
    const body = JSON.stringify(JSON.parse(readFileSync(record, 'utf8')));
    const stage = `.${name.slice(0, -5)}.${createHash('sha256').update(body).digest('hex')}.stage`;
    linkSync(record, join(home, 'bus', 'staging', stage));
    expect(() => limited.inbox('fleet')).toThrow('storage');
    expect(() => limited.send(envelope({ id: 'new' }))).toThrow('capacity');
    expect(readdirSync(join(home, 'bus', 'staging'))).toEqual([]);
    expect(limited.inbox('fleet').messages).toEqual([envelope()]);
    expect(limited.ack('message-1', 'fleet').acknowledged).toBe(true);
  });

  it('writes private directories and files', () => {
    bus.send(envelope()); bus.ack('message-1', 'fleet');
    if (process.platform !== 'win32') {
      for (const dir of ['bus', 'bus/records', 'bus/staging']) expect(lstatSync(join(home, dir)).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(join(home, 'bus', 'records'))) expect(lstatSync(join(home, 'bus', 'records', name)).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses corruption rather than returning a partial empty inbox or acknowledging', async () => {
    bus.send(envelope());
    const record = join(home, 'bus', 'records', readdirSync(join(home, 'bus', 'records'))[0]!);
    writeFileSync(record, '{malformed');
    const result = await json(['inbox', '--to', 'fleet']);
    expect(result.code).toBe(1);
    expect(result.value.error.code).toBe('storage');
    expect(() => bus.ack('message-1', 'fleet')).toThrow('storage');
    expect(readFileSync(record, 'utf8')).toBe('{malformed');
  });

  it('refuses symlinked store roots and preserves their target', () => {
    const target = join(home, 'target');
    // Directory symlinks require extra privilege on Windows; a file-shaped
    // store is still an unsafe path there and must fail the same way.
    if (process.platform === 'win32') writeFileSync(join(home, 'bus'), 'FAKE sentinel');
    else { writeFileSync(target, 'FAKE sentinel'); symlinkSync(target, join(home, 'bus')); }
    expect(() => bus.send(envelope())).toThrow('storage');
    expect(() => bus.inbox('fleet')).toThrow('storage');
    expect(readFileSync(process.platform === 'win32' ? join(home, 'bus') : target, 'utf8')).toBe('FAKE sentinel');
  });

  it('refuses unsafe record permissions or symlinks', () => {
    bus.send(envelope());
    const record = join(home, 'bus', 'records', readdirSync(join(home, 'bus', 'records'))[0]!);
    if (process.platform === 'win32') writeFileSync(record, 'FAKE invalid');
    else chmodSync(record, 0o644);
    expect(() => bus.inbox('fleet')).toThrow('storage');
  });

  it('refuses dangling storage symlinks rather than reporting an empty inbox', () => {
    if (process.platform === 'win32') writeFileSync(join(home, 'bus'), 'FAKE unsafe path');
    else symlinkSync(join(home, 'missing'), join(home, 'bus'));
    expect(() => bus.inbox('fleet')).toThrow('storage');
  });

  it('rejects non-JSON objects without invoking their hooks or writing', () => {
    const hook = vi.fn(() => 'FAKE');
    const checked = validateBusEnvelope(envelope({ body: { toJSON: hook } as never }));
    expect(checked.ok).toBe(false);
    expect(() => bus.send(envelope({ body: { toJSON: hook } as never }))).toThrow('envelope');
    expect(hook).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('real phm bus dispatch', () => {
  it('completes send -> inbox -> ack across fresh CLI processes with JSON-only output', () => {
    const run = (args: string[]) => {
      const result = child([...args, '--json']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout);
    };
    expect(run([...sendArgs, '--id', 'process-message']).ok).toBe(true);
    expect(run(['inbox', '--to', 'fleet']).messages[0].id).toBe('process-message');
    expect(run(['ack', 'process-message', '--to', 'fleet']).acknowledged).toBe(true);
    expect(run(['inbox', '--to', 'fleet']).messages).toEqual([]);
    const invalid = child(['send', '--typo', '--json']);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toBe('');
    expect(JSON.parse(invalid.stdout).error.code).toBe('usage');
  });

  it('help and empty inbox leave a fresh HOME unchanged', () => {
    const help = child(['--help', '--json']);
    expect(help.status).toBe(0);
    expect(JSON.parse(help.stdout).usage).toContain('send');
    const inbox = child(['inbox', '--to', 'fleet', '--json']);
    expect(inbox.status).toBe(0);
    expect(JSON.parse(inbox.stdout).messages).toEqual([]);
    expect(existsSync(join(home, '.ashlr', 'bus'))).toBe(false);
  });

  it('deduplicates simultaneous same-ID sends without lost writes', async () => {
    // Race first-use initialization too; children share only this fake home.
    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'bus', ...sendArgs, '--id', 'concurrent', '--json'], {
        cwd: repo, timeout: 20_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = ''; let err = '';
      processChild.stdout.on('data', data => { out += String(data); });
      processChild.stderr.on('data', data => { err += String(data); });
      processChild.on('error', reject);
      processChild.on('close', code => resolve({ code, out, err }));
    })));
    expect(results.map(r => r.code)).toEqual([0, 0, 0]);
    expect(results.every(r => !r.err)).toBe(true);
    expect(results.map(r => JSON.parse(r.out).replayed).filter(r => !r)).toHaveLength(1);
    const inbox = JSON.parse(child(['inbox', '--to', 'fleet', '--json']).stdout);
    expect(inbox.messages.filter((m: BusEnvelope) => m.id === 'concurrent')).toHaveLength(1);
  });
});
