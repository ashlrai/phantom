import { describe, expect, it, vi } from 'vitest';
import { decide, DecideInputError } from '../src/core/decide/index.js';
import type { DecideDeps, DecideReply } from '../src/core/decide/index.js';
import type { DecideLogEntry } from '../src/core/decide/options.js';
import { cmdDecide } from '../src/cli/decide.js';
import { readTelemetry } from '../src/core/metrics/telemetry.js';
import { rollup } from '../src/core/metrics/scoring.js';

const reply = (text: string): DecideReply => ({ ok: true, text, model: 'test-model' });
/** A fake model runner that returns the given replies in order, and a fixed clock. */
function fake(...replies: DecideReply[]) {
  const prompts: string[] = [], logged: DecideLogEntry[] = [];
  let tick = 0;
  const deps: DecideDeps = {
    run: async ({ prompt }) => { prompts.push(prompt); return replies[prompts.length - 1]!; },
    now: () => (tick += 5), log: entry => { logged.push(entry); },
  };
  return { deps, prompts, logged };
}
const input = { question: 'Is the sky blue?', options: ['yes', 'no'] as const };

describe('decide({question, options, context})', () => {
  it('returns a valid choice in the stable version 1 shape and logs it once', async () => {
    const { deps, prompts, logged } = fake(reply('{"choice": "yes", "confidence": 0.9, "reason": "The note says so."}'));
    const result = await decide({ ...input, context: 'The sky is blue today.', use: 'test' }, deps);
    expect(result).toEqual({ version: 1, choice: 'yes', confidence: 0.9, reason: 'The note says so.', model: 'test-model', latency_ms: 5 });
    expect(Object.keys(result)).toEqual(['version', 'choice', 'confidence', 'reason', 'model', 'latency_ms']);
    expect(prompts).toEqual(['Question: Is the sky blue?\nOptions:\n- yes\n- no\n\nContext:\nThe sky is blue today.']);
    expect(logged).toEqual([{ result, options: 2, attempts: 1, use: 'test' }]);
  });

  it('retries once after an invalid reply and accepts a valid second reply', async () => {
    const { deps, prompts, logged } = fake(reply('{"choice": "maybe", "confidence": 0.9}'), reply('Sure:\n```json\n{"choice": "no", "confidence": 0.6, "reason": "Clouds."}\n```'));
    expect(await decide(input, deps)).toMatchObject({ choice: 'no', confidence: 0.6, reason: 'Clouds.' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your last reply was not valid.');
    expect(logged[0]!.attempts).toBe(2);
  });

  it('returns unknown after two invalid replies instead of guessing', async () => {
    const { deps, prompts } = fake(reply('yes'), reply('{"choice": "yes", "confidence": 7}'));
    expect(await decide(input, deps)).toEqual({ version: 1, choice: 'unknown', confidence: 0, model: 'test-model', latency_ms: 5,
      reason: 'The model replied twice without choosing one of the options.' });
    expect(prompts).toHaveLength(2);
  });

  it('rejects an empty option list and other bad input in plain words, before any model call', async () => {
    const { deps, prompts } = fake();
    await expect(decide({ question: 'Pick one', options: [] }, deps)).rejects.toThrow(new DecideInputError('Give at least one option to choose from, for example: yes,no.'));
    await expect(decide({ question: ' ', options: ['a'] }, deps)).rejects.toThrow('Give a question to decide.');
    await expect(decide({ question: 'Pick one', options: ['a', 'unknown'] }, deps)).rejects.toThrow('An option cannot be called "unknown". That word means no answer.');
    await expect(decide({ question: 'Pick one', options: ['a', 'a'] }, deps)).rejects.toThrow('Option "a" is listed twice.');
    expect(prompts).toEqual([]);
  });

  it('shows unknown as unknown: a model that cannot tell is not retried, and no reachable model names no model', async () => {
    const unsure = fake(reply('{"choice": "unknown", "confidence": 0.8, "reason": "Nothing here says."}'));
    expect(await decide(input, unsure.deps)).toMatchObject({ choice: 'unknown', confidence: 0, reason: 'Nothing here says.' });
    expect(unsure.prompts).toHaveLength(1);
    const down = fake({ ok: false, reason: 'No seat is available.' });
    expect(await decide(input, down.deps)).toMatchObject({ choice: 'unknown', confidence: 0, model: 'unknown', reason: 'No model answered: No seat is available.' });
    const thrown = await decide(input, { run: async () => { throw new Error('boom'); }, log: () => { throw new Error('log down'); } });
    expect(thrown).toMatchObject({ choice: 'unknown', reason: 'No model answered: The model call failed.' });
  });

  it('writes one decision line to the telemetry log by default, without the question, and keeps it out of session scores', async () => {
    const result = await decide(input, { run: fake(reply('{"choice": "yes", "confidence": 1, "reason": "Plain."}')).deps.run });
    const events = readTelemetry().filter(event => event.kind === 'decision');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'decision', agent: 'decide', choice: 'yes', options: 2, confidence: 1, attempts: 1, model: 'test-model', ms: result.latency_ms });
    expect(JSON.stringify(events[0])).not.toContain('sky');
    expect(rollup(events).byAgent).toEqual([]);
  });
});

describe('phm decide', () => {
  const run = async (args: string[], result = { version: 1 as const, choice: 'b', confidence: 0.75, reason: 'It fits.', model: 'test-model', latency_ms: 12 }) => {
    const out: string[] = [], err: string[] = [];
    const decideFake = vi.fn(async () => result);
    const code = await cmdDecide(args, { decide: decideFake, readContext: async () => 'file text', out: line => out.push(line), err: line => err.push(line) });
    return { code, out, err, decideFake };
  };

  it('prints the typed result as JSON and passes the question, options and context file through', async () => {
    const { code, out, decideFake } = await run(['--question', 'Which one?', '--options', 'a, b,c', '--context', 'notes.txt', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ version: 1, choice: 'b', confidence: 0.75, reason: 'It fits.', model: 'test-model', latency_ms: 12 });
    expect(decideFake).toHaveBeenCalledWith({ question: 'Which one?', options: ['a', 'b', 'c'], context: 'file text', use: 'cli' });
  });

  it('prints plain words, and exits 1 with the word unknown when there is no answer', async () => {
    expect((await run(['--question', 'Which one?', '--options', 'a,b'])).out).toEqual(['Choice: b\nConfidence: 75%\nWhy: It fits.\nModel: test-model, 12 ms']);
    const none = await run(['--question', 'Which one?', '--options', 'a,b'], { version: 1, choice: 'unknown', confidence: 0, reason: 'No model answered: none.', model: 'unknown', latency_ms: 3 });
    expect(none.code).toBe(1);
    expect(none.out).toEqual(['Choice: unknown\nWhy: No model answered: none.\nModel: unknown, 3 ms']);
  });

  it('exits 2 with a plain error for an empty option list or a bad flag, and 0 for help', async () => {
    const out: string[] = [], err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line), decide: undefined };
    expect(await cmdDecide(['--question', 'Which one?', '--options', ' , '], io)).toBe(2);
    expect(err).toEqual(['phm decide: Give at least one option to choose from, for example: yes,no.']);
    expect(await cmdDecide(['--bogus'], io)).toBe(2);
    expect(await cmdDecide(['--help'], io)).toBe(0);
    expect(out[0]).toContain('Usage: phm decide --question <text> --options <a,b,c> [--context <file>] [--json]');
  });
});
