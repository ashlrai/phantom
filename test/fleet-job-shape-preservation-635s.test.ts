import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cmdFleetJobShape, JOB_SHAPE_MAX_BYTES } from '../src/cli/fleet-job-shape.js';
import { CONTEXT_CAP, JOB_SHAPE_SOURCE, jobShapeHeuristic } from '../src/core/fleet/recorded-job-shape.js';

// Plainly fake prompt text. The sentinel must never appear in any CLI output.
const SENTINEL = 'PLAIN_FAKE_PROMPT_SENTINEL_635S';
let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-shape-635s-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

async function promptFile(body: string | Buffer): Promise<string> {
  const path = join(dir, `prompt-${counter++}.txt`);
  await writeFile(path, body);
  return path;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(' ')); });
  return { out, err, text: () => [...out, ...err].join('\n') };
}

const filler = (n: number) => 'x'.repeat(n);

it('pins the source provenance to PR #5952 at head 3d6c8fb7c7', () => {
  expect(JOB_SHAPE_SOURCE.pr).toBe(5952);
  expect(JOB_SHAPE_SOURCE.head).toBe('3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886');
  expect(JOB_SHAPE_SOURCE.path).toBe('src/core/decide/job-shape.ts');
});

it('keeps complexity bands at the source length thresholds (800 medium, 8000 high)', () => {
  expect(jobShapeHeuristic(filler(799))).toMatchObject({ complexity: 'low', contextTokens: 799, source: 'heuristic' });
  expect(jobShapeHeuristic(filler(800))).toMatchObject({ complexity: 'medium', contextTokens: 800 });
  expect(jobShapeHeuristic(filler(7999))).toMatchObject({ complexity: 'medium', contextTokens: 7999 });
  expect(jobShapeHeuristic(filler(8000))).toMatchObject({ complexity: 'high', contextTokens: 8000 });
});

it('escalates complexity to high on architecture or migration words regardless of length', () => {
  expect(jobShapeHeuristic('plan the architecture change').complexity).toBe('high');
  expect(jobShapeHeuristic('a migration of the table').complexity).toBe('high');
  expect(jobShapeHeuristic('please redesign this').complexity).toBe('high');
  expect(jobShapeHeuristic('small typo fix').complexity).toBe('low');
});

it('caps contextTokens at the source cap and treats it as a character count', () => {
  expect(CONTEXT_CAP).toBe(200_000);
  expect(jobShapeHeuristic(filler(200_000)).contextTokens).toBe(200_000);
  expect(jobShapeHeuristic(filler(250_000)).contextTokens).toBe(200_000);
  expect(jobShapeHeuristic(filler(250_000)).complexity).toBe('high');
});

it('marks urgent or immediate wording interactive and everything else batch', () => {
  expect(jobShapeHeuristic('this is urgent').latency).toBe('interactive');
  expect(jobShapeHeuristic('fix it ASAP').latency).toBe('interactive');
  expect(jobShapeHeuristic('do it now').latency).toBe('interactive');
  expect(jobShapeHeuristic('when convenient').latency).toBe('batch');
});

it('escalates risk to high on security words and only on whole words', () => {
  for (const word of ['security', 'credentials', 'auth', 'merge', 'secret', 'token', 'vulnerability']) {
    expect(jobShapeHeuristic(`review the ${word} path`).risk, word).toBe('high');
  }
  expect(jobShapeHeuristic('rename the widget').risk).toBe('low');
  // Whole-word match only: the source regex does not match inside longer words.
  expect(jobShapeHeuristic('authentication flow').risk).toBe('low');
});

it('returns the low/low/0/batch shape for empty and non-string text', () => {
  const empty = { complexity: 'low', risk: 'low', contextTokens: 0, latency: 'batch', source: 'heuristic' };
  expect(jobShapeHeuristic('')).toEqual(empty);
  expect(jobShapeHeuristic(undefined as unknown as string)).toEqual(empty);
  expect(jobShapeHeuristic(42 as unknown as string)).toEqual(empty);
});

it('prints advisory JSON with explicit non-token provenance and no prompt text', async () => {
  const path = await promptFile(`${SENTINEL} urgent credentials rotation`);
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path, '--json'])).toBe(0);
  const body = JSON.parse(io.out[0]!);
  expect(body).toMatchObject({
    schema: 'fleet.job-shape.v1',
    advisory: true,
    authority: 'none',
    shape: { complexity: 'low', risk: 'high', latency: 'interactive', source: 'heuristic' },
    context: { unit: 'utf16_code_units', provider_tokens: false, heuristic: true, cap: CONTEXT_CAP },
  });
  expect(body.input.characters).toBe(body.shape.contextTokens);
  expect(io.text()).not.toContain(SENTINEL);
  expect(io.text()).not.toContain(dir);
});

it('prints a human summary that says it is heuristic and advisory, without prompt text', async () => {
  const path = await promptFile(`${SENTINEL} plain text`);
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path])).toBe(0);
  expect(io.out.join('\n')).toContain('advisory, no authority');
  expect(io.out.join('\n')).toContain('not provider tokens');
  expect(io.text()).not.toContain(SENTINEL);
});

it('reports empty files as an empty shape with exit 0', async () => {
  const path = await promptFile('');
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path, '--json'])).toBe(0);
  const body = JSON.parse(io.out[0]!);
  expect(body.input).toEqual({ bytes: 0, characters: 0, empty: true });
  expect(body.shape).toMatchObject({ complexity: 'low', risk: 'low', latency: 'batch', contextTokens: 0 });
});

it('accepts a file exactly at the byte cap and caps the measured context', async () => {
  const path = await promptFile(filler(JOB_SHAPE_MAX_BYTES));
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path, '--json'])).toBe(0);
  const body = JSON.parse(io.out[0]!);
  expect(body.input.bytes).toBe(JOB_SHAPE_MAX_BYTES);
  expect(body.shape.contextTokens).toBe(CONTEXT_CAP);
});

it('refuses a file one byte over the cap with a fixed message', async () => {
  const path = await promptFile(filler(JOB_SHAPE_MAX_BYTES + 1));
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path, '--json'])).toBe(1);
  const body = JSON.parse(io.out[0]!);
  expect(body).toMatchObject({ advisory: true, authority: 'none' });
  expect(body.error).toContain('exceeds');
  expect(body.shape).toBeUndefined();
  expect(io.text()).not.toContain(dir);
});

it('refuses missing files without echoing the path or the raw system error', async () => {
  const io = capture();
  expect(await cmdFleetJobShape(['--file', join(dir, 'does-not-exist.txt')])).toBe(1);
  expect(io.err.join('\n')).toContain('input file not found');
  expect(io.text()).not.toContain('ENOENT');
  expect(io.text()).not.toContain(dir);
});

it('refuses symbolic links instead of following them', async () => {
  const target = await promptFile(`${SENTINEL} target`);
  const link = join(dir, `link-${counter++}.txt`);
  await symlink(target, link);
  const io = capture();
  expect(await cmdFleetJobShape(['--file', link])).toBe(1);
  expect(io.err.join('\n')).toContain('symbolic links are refused');
  expect(io.text()).not.toContain(SENTINEL);
});

it('refuses directories as not regular files', async () => {
  const sub = join(dir, `dir-${counter++}`);
  await mkdir(sub);
  const io = capture();
  expect(await cmdFleetJobShape(['--file', sub])).toBe(1);
  expect(io.err.join('\n')).toContain('not a regular file');
});

it('refuses binary content containing a NUL byte', async () => {
  const path = await promptFile(Buffer.from(`${SENTINEL}\0tail`));
  const io = capture();
  expect(await cmdFleetJobShape(['--file', path])).toBe(1);
  expect(io.err.join('\n')).toContain('NUL byte');
  expect(io.text()).not.toContain(SENTINEL);
});

it('prints usage and exits 0 for --help and -h without reading anything', async () => {
  const io = capture();
  expect(await cmdFleetJobShape(['--help'])).toBe(0);
  expect(await cmdFleetJobShape(['--file', '/nonexistent', '-h'])).toBe(0);
  expect(io.out.join('\n')).toContain('Usage: phm fleet job-shape --file <prompt-file> [--json]');
  expect(io.out.join('\n')).toContain('grants no dispatch, admission, claim or spend authority');
});

it.each([
  ['no arguments', []],
  ['missing --file', ['--json']],
  ['--file without a value', ['--file']],
  ['--file followed by a flag', ['--file', '--json']],
  ['empty --file value', ['--file', '']],
  ['NUL in --file value', ['--file', 'a\0b']],
  ['equals form', ['--file=/tmp/x']],
  ['duplicate --file', ['--file', '/tmp/a', '--file', '/tmp/b']],
  ['duplicate --json', ['--file', '/tmp/a', '--json', '--json']],
  ['unknown flag', ['--file', '/tmp/a', '--model', 'x']],
  ['stray positional', ['/tmp/a']],
] as const)('rejects malformed arguments: %s', async (_name, args) => {
  const io = capture();
  expect(await cmdFleetJobShape([...args])).toBe(2);
  expect(io.err.join('\n')).toContain('Usage: phm fleet job-shape');
});
