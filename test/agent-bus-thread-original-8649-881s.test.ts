import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';
import { readBusThread } from '../src/core/fleet/bus-thread-context.js';

let base: string, root: string, previousRuns: string | undefined;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-thread-original-'));
  root = join(base, 'fleet');
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = join(base, 'runs');
});
afterEach(() => {
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  rmSync(base, { recursive: true, force: true });
});
async function run(args: string[], json = true) {
  const out: string[] = [], err: string[] = [];
  const code = await runAgentsCli(['bus', ...args, '--root', root, ...(json ? ['--json'] : [])], t => out.push(t), t => err.push(t));
  return { code, text: out.join('\n'), err: err.join('\n'), json: json ? JSON.parse((out.length ? out : err).join('\n')) : undefined };
}
async function seed() {
  for (const handle of ['atlas', 'nova']) expect((await run(['id', 'register', handle])).code).toBe(0);
  for (const [id, from, to, text, reply] of [
    ['th-1', 'atlas', 'nova', 'root ask', ''], ['th-2', 'nova', 'atlas', 'first reply', 'th-1'],
    ['th-3', 'atlas', 'nova', 'second reply', 'th-2'], ['th-x', 'atlas', 'nova', 'unrelated', ''],
  ]) expect((await run(['dm', '--from', from!, '--to', to!, '--text', text!, '--id', id!, ...(reply ? ['--reply-to', reply] : [])])).code).toBe(0);
}
describe('original unified bus thread', () => {
  it('projects root and descendant subtree through the dispatcher, preserving JSON and human labels', async () => {
    await seed();
    const thread = await run(['thread', 'th-1']);
    expect(thread.code).toBe(0);
    // Ignore TTL differences caused by reading at different instants.
    const direct = readBusThread('th-1', { root });
    expect(thread.json).toMatchObject({ ...direct, messages: expect.any(Array) });
    expect(thread.json.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['th-1', 'th-2', 'th-3']);
    const mid = await run(['thread', 'th-2']);
    expect(mid.code).toBe(0);
    expect(mid.json.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['th-2', 'th-3']);
    const human = await run(['thread', 'th-1'], false);
    expect(human.code).toBe(0);
    expect(human.text).toContain('th-1 (root)');
    expect(human.text).toContain('from atlas -> nova');
    expect(human.text).toContain('first reply');
    expect(human.text).not.toContain('th-x');
    expect(await run(['thread', 'missing'])).toMatchObject({ code: 1, json: { rootFound: false, complete: true } });
    expect(await run(['thread', 'bad id'])).toMatchObject({ code: 1, json: { status: 'invalid' } });
    expect((await run(['thread'])).code).toBe(2);
    expect((await run(['thread', 'th-1', 'extra'])).code).toBe(2);
  });
  it('fails closed for an unreadable store and falls back to raw labels for an unreadable registry', async () => {
    await seed();
    writeFileSync(join(root, 'agent-identities', 'registry.json'), '{broken');
    const human = await run(['thread', 'th-1'], false);
    expect(human.code).toBe(0);
    expect(human.text).toContain('from agent:atlas -> agent:nova');
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
    const broken = await run(['thread', 'th-1']);
    expect(broken).toMatchObject({ code: 1, json: { complete: false, rootFound: false } });
    expect(broken.json.sourceFailure).not.toBeNull();
  });
});
