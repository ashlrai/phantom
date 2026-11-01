import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cmdCommsBus, type CommsBusPeersDeps } from '../src/cli/comms-bus.js';
import type { LocusPeersEndpoint } from '../src/core/fleet/adapters/codex-peers.js';

const roots: string[] = [];
let prevPath: string | undefined;

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-peers-wire31-'));
  roots.push(dir);
  return dir;
}

/** Prepend dir so a stub `locus` command resolves ahead of the real PATH. */
function stubPath(dir: string): void {
  process.env.PATH = dir + delimiter + (process.env.PATH ?? '');
}

/**
 * A fake `locus` command speaking `peers <op> --session-id <id> --client codex
 * --json`. Every call appends `<op>|<session-id>` to the returned argv file so
 * tests can assert register/inbox/unregister order. The script never reads
 * stdin, auth files or the network.
 */
function installFakeLocus(dir: string, behavior: 'ok' | 'refuse' | 'fail' | 'bad-json' = 'ok'): string {
  const argvFile = join(dir, 'argv.txt');
  const reply = behavior === 'ok' ? `case "$op" in
  register|unregister) printf '{"ok":true}\\n' ;;
  inbox) printf '{"ok":true,"messages":[{"sessionId":"%s","text":"peer hello"}]}\\n' "$sid" ;;
  *) exit 1 ;;
esac` : behavior === 'refuse' ? `printf '{"ok":false}\\n'` : behavior === 'bad-json' ? 'printf "not json\\n"' : 'exit 1';
  writeFileSync(join(dir, 'locus'), `#!/bin/sh
op="$2"
sid=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then sid="$2"; shift 2; else shift; fi
done
printf '%s|%s\\n' "$op" "$sid" >> "${argvFile}"
${reply}
`, { mode: 0o755 });
  return argvFile;
}

async function runPeers(args: string[], deps?: CommsBusPeersDeps): Promise<{ code: number; out: Record<string, unknown>[] }> {
  const out: Record<string, unknown>[] = [];
  const code = await cmdCommsBus(['peers', ...args], {}, {
    emit: (json) => { out.push(JSON.parse(json) as Record<string, unknown>); },
    ...(deps === undefined ? {} : { peers: deps }),
  });
  return { code, out };
}

beforeEach(() => { prevPath = process.env.PATH; });
afterEach(() => {
  if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('phm comms bus peers — codex-peers behind the Locus peers contract', () => {
  it('prints usage on --help and exits 0 without probing locus', async () => {
    const original = console.log;
    let printed = '';
    console.log = (line?: unknown) => { printed += `${String(line)}\n`; };
    try {
      expect(await cmdCommsBus(['peers', '--help'])).toBe(0);
    } finally {
      console.log = original;
    }
    expect(printed).toContain('phm comms bus peers');
  });

  it.each([
    ['--session-id', 'bad id'],
    ['--session-id', '../auth'],
    ['--session-id', 'x'.repeat(129)],
    ['--session-id=--flag'],
    ['--session-id='],
    ['--session-id'],
    ['--bogus'],
    ['--session-id', 'a', '--session-id', 'b'],
  ])('rejects %j with status invalid before any probe or I/O', async (args) => {
    const available = vi.fn(() => true);
    const { code, out } = await runPeers(args, { available });
    expect(code).toBe(2);
    expect(out).toEqual([{ status: 'invalid' }]);
    expect(available).not.toHaveBeenCalled();
  });

  it('is off when the locus CLI is missing: a clear unavailable result', async () => {
    const { code, out } = await runPeers([], { available: () => false });
    expect(code).toBe(1);
    expect(out).toEqual([{ status: 'unavailable', peers: { client: 'codex', transport: 'locus-peers', locus: 'missing' } }]);
  });

  it('refuses a session read when locus is missing, without calling the endpoint', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async () => ({ ok: true }));
    const { code, out } = await runPeers(['--session-id', 'codex-peer-2'], { available: () => false, endpoint: { request } });
    expect(code).toBe(1);
    expect(out[0]).toMatchObject({ status: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('reports the codex peers transport when locus is present', async () => {
    const { code, out } = await runPeers([], { available: () => true });
    expect(code).toBe(0);
    expect(out).toEqual([{
      status: 'ok',
      peers: { client: 'codex', transport: 'locus-peers', locus: 'present', contract: 'unverified' },
      read: 'peers --session-id <id>',
    }]);
  });

  it('reads one untrusted inbox snapshot through the injected endpoint', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async (op, sessionId) =>
      op === 'inbox' ? { ok: true, messages: [{ sessionId, text: 'peer hello' }] } : { ok: true });
    const { code, out } = await runPeers(['--session-id', 'codex-peer-7'], { available: () => true, endpoint: { request } });
    expect(code).toBe(0);
    expect(out).toEqual([{
      status: 'ok',
      peers: {
        client: 'codex', transport: 'locus-peers', source: 'locus-peers', trust: 'untrusted',
        sessionId: 'codex-peer-7', messages: [{ sessionId: 'codex-peer-7', text: 'peer hello' }],
      },
    }]);
    expect(request.mock.calls.map(([op, sid]) => `${op}:${sid}`)).toEqual([
      'register:codex-peer-7', 'inbox:codex-peer-7', 'unregister:codex-peer-7',
    ]);
  });

  it('supports the --session-id=<id> inline form', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async (op) =>
      op === 'inbox' ? { ok: true, messages: [] } : { ok: true });
    const { code, out } = await runPeers(['--session-id=codex-peer-3'], { available: () => true, endpoint: { request } });
    expect(code).toBe(0);
    expect(out[0]).toMatchObject({ status: 'ok', peers: { sessionId: 'codex-peer-3', messages: [] } });
  });

  it('fails closed on registration refusal without reading the inbox', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async () => ({ ok: false }));
    const { code, out } = await runPeers(['--session-id', 'codex-peer-4'], { available: () => true, endpoint: { request } });
    expect(code).toBe(1);
    expect(out[0]).toMatchObject({ status: 'unavailable' });
    expect(request.mock.calls.map(([op]) => op)).toEqual(['register']);
  });

  it('still unregisters when the inbox read fails', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async (op) => (op === 'inbox' ? { ok: false } : { ok: true }));
    const { code, out } = await runPeers(['--session-id', 'codex-peer-8'], { available: () => true, endpoint: { request } });
    expect(code).toBe(1);
    expect(out[0]).toMatchObject({ status: 'unavailable' });
    expect(request.mock.calls.map(([op]) => op)).toEqual(['register', 'inbox', 'unregister']);
  });

  it('returns unavailable and never echoes endpoint error text', async () => {
    const request = vi.fn<LocusPeersEndpoint['request']>(async () => {
      throw new Error('locus stderr: private token material');
    });
    const { code, out } = await runPeers(['--session-id', 'codex-peer-1'], { available: () => true, endpoint: { request } });
    expect(code).toBe(1);
    expect(out).toEqual([{ status: 'unavailable', peers: { client: 'codex', transport: 'locus-peers' } }]);
    expect(JSON.stringify(out)).not.toContain('private token');
  });
});

describe.skipIf(process.platform === 'win32')('fake locus command on PATH', () => {
  it('probes the codex peers transport through the real locus CLI gate', async () => {
    const dir = fixtureDir();
    installFakeLocus(dir);
    stubPath(dir);
    const { code, out } = await runPeers([]);
    expect(code).toBe(0);
    expect(out[0]).toMatchObject({ status: 'ok', peers: { client: 'codex', transport: 'locus-peers', locus: 'present' } });
  });

  it('reads the peers inbox end-to-end through the fake locus command', async () => {
    const dir = fixtureDir();
    const argv = installFakeLocus(dir);
    stubPath(dir);
    const { code, out } = await runPeers(['--session-id', 'codex-peer-9']);
    expect(code).toBe(0);
    expect(out).toEqual([{
      status: 'ok',
      peers: {
        client: 'codex', transport: 'locus-peers', source: 'locus-peers', trust: 'untrusted',
        sessionId: 'codex-peer-9', messages: [{ sessionId: 'codex-peer-9', text: 'peer hello' }],
      },
    }]);
    expect(readFileSync(argv, 'utf8').trim().split('\n')).toEqual([
      'register|codex-peer-9', 'inbox|codex-peer-9', 'unregister|codex-peer-9',
    ]);
  });

  it.each(['fail', 'bad-json'] as const)('fails closed when the locus command %s', async (behavior) => {
    const dir = fixtureDir();
    installFakeLocus(dir, behavior);
    stubPath(dir);
    const { code, out } = await runPeers(['--session-id', 'codex-peer-1']);
    expect(code).toBe(1);
    expect(out[0]).toMatchObject({ status: 'unavailable' });
  });

  it('reports unavailable when locus is absent from PATH entirely', async () => {
    process.env.PATH = fixtureDir();
    const { code, out } = await runPeers([]);
    expect(code).toBe(1);
    expect(out[0]).toMatchObject({ status: 'unavailable', peers: { locus: 'missing' } });
  });
});
