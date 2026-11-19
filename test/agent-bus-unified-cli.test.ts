import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { runAgentsBusUnified } from '../src/cli/agents-bus-unified.js';
import * as seats from '../src/core/bots/seats.js';

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
  it('lists configured seat participants additively without registering identities or channels', async () => {
    const participant = { participantId: 'review-seat', provider: 'devin' as const, displayName: 'Reviewer', capabilities: ['code'],
      status: 'idle' as const, wake: { kind: 'poll' as const, target: 'review-seat' } };
    const read = vi.spyOn(seats, 'seatParticipants').mockResolvedValueOnce([participant]);
    try {
      expect(await run(['id', 'list'])).toMatchObject({ code: 0, json: { identities: [], channels: [], participants: [participant] } });
    } finally { read.mockRestore(); }
    expect((await run(['id', 'list'])).json.participants).toEqual([]);
  });
  it('surfaces unavailable seat rosters without registering identities', async () => {
    const read = vi.spyOn(seats, 'seatParticipants').mockRejectedValueOnce(new Error('Unsafe seat file.'));
    try {
      await expect(run(['id', 'list'])).rejects.toThrow('Unsafe seat file.');
    } finally { read.mockRestore(); }
    expect((await run(['id', 'list'])).json.identities).toEqual([]);
  });
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

  it('announces and updates v2 work on the same bus, owner-only for status', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect((await run(['id', 'register', 'nova'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-W', '--title', 'Ship it',
      '--repo', 'ashlrai/phantom', '--claim', 'repo:ashlrai/phantom', '--id', 'cli-w'])).json)
      .toMatchObject({ status: 'posted', to: 'leaders', wake: 'not-requested' });
    expect((await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-CLI-W2', '--title', 'Second',
      '--repo', 'ashlrai/phantom', '--provider', 'devin',
      '--tier', 'work', '--scope', 'bus lane', '--acceptance', 'feed shows done', '--id', 'cli-w2'])).json)
      .toMatchObject({ status: 'posted' });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-CLI-W', '--status', 'running',
      '--detail', 'picked up', '--id', 'cli-ws'])).json).toMatchObject({ status: 'posted', to: 'leaders' });
    // Only the announcing identity may move the job.
    expect(await run(['work', 'status', '--from', 'nova', '--job', 'RQ-CLI-W', '--status', 'done']))
      .toMatchObject({ code: 1, json: { status: 'refused' } });
    expect((await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-GONE', '--status', 'done'])).json)
      .toMatchObject({ status: 'invalid' });
  });

  it('refuses bad work verbs and flags with usage errors', async () => {
    expect((await run(['id', 'register', 'atlas', '--cli', 'claude'])).json).toMatchObject({ status: 'created' });
    expect(await run(['work', 'post', '--from', 'atlas', '--title', 'x', '--repo', 'a/b']))
      .toMatchObject({ code: 2, json: { error: 'invalid-argument' } });
    expect(await run(['work', 'status', '--from', 'atlas', '--job', 'RQ-X', '--status', 'bogus']))
      .toMatchObject({ code: 2 });
    expect(await run(['work', 'post', '--from', 'atlas', '--job', 'RQ-X', '--title', 'x', '--repo', 'a/b',
      '--tier', 'work'])).toMatchObject({ code: 2 });
    expect(await run(['work', 'frobnicate'])).toMatchObject({ code: 2 });
    // An identity with no runtime and no --provider cannot announce.
    expect((await run(['id', 'register', 'orion'])).json).toMatchObject({ status: 'created' });
    expect((await run(['work', 'post', '--from', 'orion', '--job', 'RQ-X', '--title', 'x',
      '--repo', 'a/b'])).json).toMatchObject({ status: 'invalid' });
    expect((await run(['work', 'post', '--from', 'orion', '--job', 'RQ-X', '--title', 'x',
      '--repo', 'a/b', '--provider', 'local'])).json).toMatchObject({ status: 'posted' });
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
