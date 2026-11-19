import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentRegistry, stableAgentId } from '../src/core/agents/bus-identity.js';
import { attachBusCliSession } from '../src/core/agents/bus-cli-adapters.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'bus-provider-616s-'));
  dirs.push(base);
  return { root: join(base, 'fleet'), runsRoot: join(base, 'runs'), now: () => 1_000 };
}

function runtimes(options: ReturnType<typeof setup>): string[] {
  const read = readAgentRegistry(options);
  if (read.status !== 'ok') throw new Error('unreadable');
  return (read.registry.identities[0]?.runtimes ?? []).map(r => `${r.cli}:${r.provider}:${r.model}`);
}

describe('bus CLI provider compatibility (routing metadata only)', () => {
  it('attaches claude/glm, then codex/local, under one stable identity', () => {
    const options = setup();
    const a = attachBusCliSession({ handle: 'fake-agent', cli: 'claude', provider: 'glm', model: 'fake-model-a' }, {}, options);
    expect(a.status).toBe('created');
    const b = attachBusCliSession({ handle: 'fake-agent', cli: 'codex', provider: 'local', model: 'fake-model-b' }, {}, options);
    expect(b.status).toBe('updated');
    if (a.status !== 'created' || b.status !== 'updated') throw new Error('unexpected');
    expect(a.identity.id).toBe(stableAgentId('fake-agent'));
    expect(b.identity.id).toBe(a.identity.id);
    expect(runtimes(options)).toEqual(['claude:glm:fake-model-a', 'codex:local:fake-model-b']);
  });

  it('is idempotent on duplicate attach', () => {
    const options = setup();
    const input = { handle: 'fake-agent', cli: 'claude', provider: 'glm', model: 'fake-model-a' } as const;
    attachBusCliSession(input, {}, options);
    attachBusCliSession(input, {}, options);
    expect(runtimes(options)).toEqual(['claude:glm:fake-model-a']);
  });

  it('still refuses cross-CLI pairings without adding runtimes', () => {
    const options = setup();
    attachBusCliSession({ handle: 'fake-agent', cli: 'claude', model: 'fake-model-a' }, {}, options);
    expect(attachBusCliSession({ handle: 'fake-agent', cli: 'codex', provider: 'glm', model: 'x' }, {}, options)).toMatchObject({ status: 'invalid' });
    expect(attachBusCliSession({ handle: 'fake-agent', cli: 'claude', provider: 'local', model: 'x' }, {}, options)).toMatchObject({ status: 'invalid' });
    expect(runtimes(options)).toEqual(['claude:claude:fake-model-a']);
  });

  it('keeps default providers', () => {
    const options = setup();
    attachBusCliSession({ handle: 'fake-agent', cli: 'claude', model: null }, {}, options);
    attachBusCliSession({ handle: 'fake-agent', cli: 'codex', model: null }, {}, options);
    expect(runtimes(options)).toEqual(['claude:claude:null', 'codex:codex-personal:null']);
  });
});
