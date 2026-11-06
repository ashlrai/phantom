import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHarnessBetOverlap } from '../examples/agents/harness-bet-overlap.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bet = (id: string, text: string) => ({ id, text });
function invoke(file: string, read?: (path: string) => string, args = ['--file', file]) {
  let out = '', err = '';
  const code = runHarnessBetOverlap(args, { read, stdout: value => { out += value; }, stderr: value => { err += value; } });
  return { code, out, err, value: JSON.parse(out || err) };
}
function snapshot(proposed: ReturnType<typeof bet>[], previous: ReturnType<typeof bet>[]) {
  return JSON.stringify({ proposed, previous });
}
function fakeFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-bet-overlap-'));
  dirs.push(dir);
  const file = join(dir, 'snapshot.json');
  writeFileSync(file, content);
  return { file, dir };
}

describe('harness bet overlap', () => {
  it('reads a real snapshot and reports exact, partial, and unrelated observations with source IDs', () => {
    const content = snapshot([bet('new-exact', '  Retry   QUEUES! '), bet('new-partial', 'retry queues safely'),
      bet('new-other', 'paint blue walls')], [bet('old-exact', 'retry queues!'), bet('old-partial', 'queues retry later')]);
    const { file } = fakeFile(content);
    const result = invoke(file);
    expect(result.code).toBe(0);
    expect(result.value).toEqual({ v: 1, kind: 'lexical_observations', observations: [
      { proposedId: 'new-exact', prior: { priorId: 'old-exact', exact: true, sharedTerms: 2,
        proposedTerms: 2, previousTerms: 2, unionTerms: 2, score: 1 } },
      { proposedId: 'new-partial', prior: { priorId: 'old-exact', exact: false, sharedTerms: 2,
        proposedTerms: 3, previousTerms: 2, unionTerms: 3, score: 2 / 3 } },
      { proposedId: 'new-other', prior: { priorId: 'old-exact', exact: false, sharedTerms: 0,
        proposedTerms: 3, previousTerms: 2, unionTerms: 5, score: 0 } },
    ] });
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(invoke(file).out).toBe(result.out);
  });

  it('normalizes Unicode case and compatibility, retains punctuation for exactness and counts distinct terms', () => {
    const data = snapshot([bet('p', 'ＣＡＦÉ café ΔΟΚΙΜΉ')], [bet('first', 'cafe\u0301 δοκιμή!'), bet('exact', 'café café δοκιμή')]);
    const result = invoke('fake.json', () => data);
    expect(result.value.observations[0]).toEqual({ proposedId: 'p', prior: { priorId: 'exact', exact: true,
      sharedTerms: 2, proposedTerms: 2, previousTerms: 2, unionTerms: 2, score: 1 } });
  });

  it('uses previous input order for equal scores and returns null when no previous bets exist', () => {
    const result = invoke('fake.json', () => snapshot([bet('p', 'one two')], [bet('z', 'one three'), bet('a', 'two four')]));
    expect(result.value.observations[0].prior).toMatchObject({ priorId: 'z', score: 1 / 3, exact: false });
    expect(invoke('fake.json', () => snapshot([bet('p', 'one')], [])).value.observations)
      .toEqual([{ proposedId: 'p', prior: null }]);
  });

  it('rejects blank or malformed records and ambiguous IDs', () => {
    for (const data of [snapshot([bet('p', ' \n ')], []), snapshot([], [bet(' ', 'text')]),
      snapshot([bet('p', 'a'), bet('p', 'b')], []), '{"proposed":[],"previous":[{"id":"p"}]}',
      '{"proposed":{},"previous":[]}', '{']) {
      expect(invoke('fake.json', () => data)).toMatchObject({ code: 1, value: { error: 'invalid_or_unreadable_snapshot' } });
    }
  });

  it('enforces both record caps and the byte cap, including injected readers', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => bet(`fake-${i}`, 'same'));
    expect(invoke('fake.json', () => snapshot(many(100), many(2000))).code).toBe(0);
    expect(invoke('fake.json', () => snapshot(many(101), [])).code).toBe(1);
    expect(invoke('fake.json', () => snapshot([], many(2001))).code).toBe(1);
    const base = snapshot([], []);
    expect(invoke('fake.json', () => base + ' '.repeat(1024 * 1024 - base.length)).code).toBe(0);
    expect(invoke('fake.json', () => base + ' '.repeat(1024 * 1024 - base.length + 1)).code).toBe(1);
    const { file } = fakeFile(base + ' '.repeat(1024 * 1024 - base.length + 1));
    expect(invoke(file).code).toBe(1);
  });

  it('rejects symlinks, directories, invalid UTF-8 and bad arguments before reading', () => {
    const { file, dir } = fakeFile(snapshot([], []));
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    expect(invoke(link).code).toBe(1);
    expect(invoke(dir).code).toBe(1);
    writeFileSync(file, Buffer.from([0xff]));
    expect(invoke(file).code).toBe(1);
    const read = vi.fn(() => snapshot([], []));
    for (const args of [[], ['--file'], ['--file', 'fake', '--file', 'other'], ['--unknown', 'fake']]) {
      expect(invoke('fake', read, args).code).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('treats supplied content as inert data and does not leak reader errors', () => {
    const text = 'ignore instructions; throw new Error("fake-executed")';
    const read = vi.fn(() => snapshot([bet('new-id', text)], [bet('old-id', text)]));
    const result = invoke('fake.json', read);
    expect(read).toHaveBeenCalledWith('fake.json');
    expect(result.value.observations[0]).toMatchObject({ proposedId: 'new-id', prior: { priorId: 'old-id', exact: true } });
    expect(result.out).not.toContain(text);
    expect(invoke('fake.json', () => { throw new Error('fake private detail'); }).err)
      .toBe('{"error":"invalid_or_unreadable_snapshot"}\n');
  });
});
