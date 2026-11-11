import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { validateAgentProfile, writeAgentProfile } from '../src/core/agents/agent-profile.js';
import { checkSend } from '../src/core/agents/send-policy.js';

describe('recut of #4869: agent profiles CLI and restrictive send policy', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(async () => {
    prev = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'recut-4869-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    let out = ''; let err = '';
    const code = await runAgentsCli(args, t => { out += t; }, t => { err += t; });
    return { code, out, err };
  }

  it('lists, shows, validates and versions a profile via the agents verb', async () => {
    expect(JSON.parse((await run(['list', '--json'])).out)).toEqual({ profiles: [] });
    await writeAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'] }, home);
    const listed = JSON.parse((await run(['list', '--json'])).out);
    expect(listed.profiles.map((p: { id: string }) => p.id)).toEqual(['helper']);
    expect(JSON.parse((await run(['validate', 'helper', '--json'])).out)).toEqual({ id: 'helper', valid: true, version: 1 });
    expect(JSON.parse((await run(['versions', 'helper', '--json'])).out)).toEqual({ id: 'helper', versions: [1] });
    expect(JSON.parse((await run(['show', 'helper', '--json'])).out).profile.id).toBe('helper');
  });

  it('rejects path-like ids with exit 2 and keeps the bus verbs working', async () => {
    const bad = await run(['show', '../outside', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.err)).toMatchObject({ ok: false });
    expect((await run(['bus', 'contract', '--json'])).code).toBe(0);
  });

  it('never allows an outside send while limits are incomplete', () => {
    const profile = validateAgentProfile({ id: 'helper', displayName: 'Helper', doctrine: 'doctrine.md', channels: ['email'] });
    expect(checkSend(profile, 'email', 'a@example.com', 0)).toMatchObject({ decision: 'draft', reason: 'limits-incomplete' });
    expect(checkSend(profile, 'sms', 'a@example.com', 0).decision).toBe('deny');
  });
});
