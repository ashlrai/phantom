import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';

let base: string;
let root: string;
let previousRuns: string | undefined;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-bus-cli-'));
  root = join(base, 'fleet');
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = join(base, 'runs');
});
afterEach(() => {
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  rmSync(base, { recursive: true, force: true });
});

async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await runAgentsBusUnified([...args, '--root', root, '--json'], t => out.push(t), t => err.push(t), env);
  return { code, json: out.length ? JSON.parse(out.join('\n')) : JSON.parse(err.join('\n')) };
}

describe('phm agents bus (unified)', () => {
  it('registers, messages, hands off and reads an inbox end to end', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude', '--model', 'opus'])).json).toMatchObject({ status: 'created', identity: { handle: 'atlas' } });
    expect((await run(['id', 'register'], { PHM_AGENT_ID: 'nova', CODEX_SANDBOX: 'seatbelt' })).json)
      .toMatchObject({ status: 'created', identity: { runtimes: [{ cli: 'codex', provider: 'codex-personal' }] } });
    expect((await run(['id', 'register', 'orion', '--alias', 'dot-main', '--alias', 'lane-x'])).json)
      .toMatchObject({ status: 'created', identity: { aliases: ['dot-main', 'lane-x'], runtimes: [] } });
    const list = await run(['id', 'list']);
    expect(list.json.identities.map((i: { handle: string }) => i.handle)).toEqual(['atlas', 'nova', 'orion']);

    expect((await run(['dm', '--to', 'nova', '--text', 'hello', '--priority', 'P0', '--id', 'cli-dm'], { PHM_AGENT_ID: 'atlas' })).json)
      .toMatchObject({ status: 'posted', to: 'agent:nova', wake: 'queued' });
    expect((await run(['channel', 'create', 'release', '--from', 'atlas', '--member', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['channel', 'join', 'release', '--agent', 'dot-main'])).json).toMatchObject({ status: 'updated', channel: { members: ['atlas', 'nova', 'orion'] } });
    expect((await run(['channel', 'post', 'release', '--from', 'orion', '--text', 'ship it', '--id', 'cli-ch'])).json).toMatchObject({ status: 'posted', wake: 'not-requested' });
    expect((await run(['handoff', '--from', 'atlas', '--to', 'nova', '--task', 'RQ-CLI-1', '--prompt', 'take over', '--id', 'cli-ho'])).json)
      .toMatchObject({ status: 'posted', wake: 'queued' });

    const inbox = await run(['inbox', 'nova']);
    expect(inbox.code).toBe(0);
    expect(inbox.json.messages.map((m: { envelope: { id: string }; kind: string }) => `${m.envelope.id}:${m.kind}`))
      .toEqual(['cli-dm:dm', 'cli-ho:handoff', 'cli-ch:channel']);
    const framed = await run(['inbox', '--frame', 'cursor'], { PHM_AGENT_ID: 'nova' });
    expect(framed.json.framed).toContain('BEGIN UNTRUSTED AGENT BUS MESSAGES');
    const wakes = await run(['wakes', 'nova']);
    expect(wakes.json.wakes.map((w: { id: string }) => w.id)).toEqual(['cli-dm', 'cli-ho']);
    const adapters = await run(['adapters']);
    expect(adapters.json.adapters.map((a: { cli: string }) => a.cli)).toEqual(['claude', 'codex', 'devin', 'cursor', 'grok']);
  });

  it('returns 1 for refusals and 2 for usage errors', async () => {
    expect(await run(['dm', '--to', 'nova', '--text', 'x'])).toMatchObject({ code: 2, json: { error: 'invalid-argument' } });
    expect(await run(['dm', '--from', 'ghost', '--to', 'nova', '--text', 'x'])).toMatchObject({ code: 1, json: { status: 'unknown-sender' } });
    expect(await run(['dm', '--from', 'a', '--to', 'b', '--text', 'x', '--wake', '--no-wake'])).toMatchObject({ code: 2 });
    expect(await run(['id', 'register', 'atlas', '--cli', 'gemini'])).toMatchObject({ code: 2 });
    expect(await run(['inbox', 'atlas', '--limit', '-1'])).toMatchObject({ code: 2 });
    expect(await run(['bogus'])).toMatchObject({ code: 2 });
    expect(await run(['id', 'list', 'extra'])).toMatchObject({ code: 2 });
  });

  it('is reachable from phm agents and listed in its help', async () => {
    const out: string[] = [];
    expect(await runAgentsCli(['--help'], t => out.push(t), () => {})).toBe(0);
    expect(out.join('\n')).toContain('ashlr agents bus dm --to <agent>');
    const routed: string[] = [];
    expect(await runAgentsCli(['bus', 'adapters', '--json'], t => routed.push(t), () => {})).toBe(0);
    expect(JSON.parse(routed[0]!).adapters).toHaveLength(5);
    // The pre-existing contract verb is untouched.
    const contract: string[] = [];
    expect(await runAgentsCli(['bus', 'contract', '--json'], t => contract.push(t), () => {})).toBe(0);
    expect(JSON.parse(contract[0]!).schemaVersion).toBe('agent-bus.v2');
  });
});
