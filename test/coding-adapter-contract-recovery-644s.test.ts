import { describe, expect, it } from 'vitest';
import { adapterById, listAdapters } from '../src/core/providers/coding-cli/adapter-contract.js';
import { cmdFleetAdapterContract } from '../src/cli/fleet-adapter-contract.js';

const GOAL = 'fix "the bug"; rm -rf $HOME && echo `x` | cat\nline two';
const CWD = '/tmp/work dir/with spaces';
const backends = { codex: { bin: 'fake-codex', billing: 'test-billing' } };

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cmdFleetAdapterContract(args, (l) => out.push(l), (l) => err.push(l));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('adapter contract (PR #5952 recovery)', () => {
  it('keeps each argv element intact for hostile text', () => {
    const codex = adapterById(backends, 'codex')!;
    expect(codex.execArgs(GOAL, CWD, 'm x')).toEqual(['exec', '--model', 'm x', '--cd', CWD, '--json', GOAL]);
    expect(codex.execArgs(GOAL, CWD, null)).toEqual(['exec', '--cd', CWD, '--json', GOAL]);
    expect(adapterById(backends, 'claude')!.execArgs(GOAL, CWD, 'm')).toEqual(['-p', GOAL, '--model', 'm', '--output-format', 'json', '--add-dir', CWD]);
    expect(adapterById(backends, 'grok')!.execArgs(GOAL, CWD, null)).toEqual(['--cwd', CWD, '--single', GOAL]);
    expect(adapterById(backends, 'codex')!.verifyArgs!('a b;c')).toContain('a b;c');
  });

  it('preserves stub and null distinctions', () => {
    const by = (id: string) => adapterById({}, id)!;
    expect(by('devin')).toMatchObject({ bin: null, statusArgs: null, verifyArgs: null, versionArgs: [], capabilities: { editInWorkspace: false } });
    expect(by('devin').execArgs(GOAL, CWD, 'm')).toEqual([]);
    expect(by('cursor')).toMatchObject({ statusArgs: null, verifyArgs: null });
    expect(by('cursor').versionArgs).toEqual(['--version']);
    expect(by('ollama')).toMatchObject({ statusArgs: ['list'], verifyArgs: null });
    expect(by('ollama').execArgs(GOAL, CWD, null)).toEqual([]);
    expect(by('codex').statusArgs).toEqual(['login', 'status']);
    expect(by('claude').statusArgs).toEqual(['auth', 'status']);
    expect(by('grok').statusArgs).toEqual(['models']);
    expect(listAdapters({}).map((a) => a.id)).toEqual(['codex', 'claude', 'grok', 'devin', 'cursor', 'ollama']);
    expect(adapterById({}, 'nope')).toBeNull();
  });

  it('takes bin/billing from the structural input, defaulting like the source', () => {
    expect(adapterById(backends, 'codex')).toMatchObject({ bin: 'fake-codex', billing: 'test-billing' });
    expect(adapterById({}, 'codex')).toMatchObject({ bin: null, billing: 'metered' });
  });
});

describe('cmdFleetAdapterContract', () => {
  it('emits parseable JSON with provenance and unknown availability', async () => {
    const r = await run(['--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.source).toEqual({ pr: 5952, head: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886', path: 'src/core/providers/coding-cli/adapters.ts' });
    expect(j.availability).toBe('unknown');
    expect(j.notice).toBe('historical contract; availability and account eligibility unknown');
    const byId = Object.fromEntries(j.adapters.map((a: { id: string }) => [a.id, a]));
    expect(byId.devin).toMatchObject({ stub: true, statusArgs: null, verifyArgsTemplate: null, execArgsTemplate: [] });
    expect(byId.ollama).toMatchObject({ stub: true, statusArgs: ['list'] });
    expect(byId.codex.stub).toBe(false);
    expect(byId.codex.execArgsTemplate).toEqual(['exec', '--model', 'fake-model-placeholder', '--cd', '/fake/cwd-placeholder', '--json', 'FAKE-GOAL-PLACEHOLDER']);
    expect(byId.codex.execArgsTemplateNoModel).not.toContain('--model');
  });

  it('selects one adapter and renders readable output', async () => {
    const one = JSON.parse((await run(['grok', '--json'])).out);
    expect(one.adapters.map((a: { id: string }) => a.id)).toEqual(['grok']);
    const human = await run(['devin']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('historical contract; availability and account eligibility unknown');
    expect(human.out).toContain('stub: no workspace exec');
    expect(human.out).toContain('null (none)');
  });

  it('prints help and rejects bad input clearly', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet adapter-contract');
    const bad = await run(['nope']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown adapter id "nope"');
    for (const args of [['--goal', 'x'], ['--cwd=/tmp'], ['codex', 'claude']]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
    }
  });
});
