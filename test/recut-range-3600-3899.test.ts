import { expect, it } from 'vitest';
import { runAgentsCli } from '../src/cli/agents-bus-contract.js';

it('routes agent profile commands and rejects invalid profile ids through the CLI', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await runAgentsCli(['show', '../outside', '--json'], text => output.push(text), text => errors.push(text));
  expect(code).toBe(2);
  expect(output).toEqual([]);
  expect(JSON.parse(errors[0]!)).toMatchObject({ ok: false });
});

it.each(['list', 'show', 'validate', 'versions'])('rejects repeated --json before dispatching profile %s', async (verb) => {
  const output: string[] = [];
  const errors: string[] = [];
  const args = verb === 'list' ? [verb] : [verb, '../outside'];
  const code = await runAgentsCli([...args, '--json', '--json'], text => output.push(text), text => errors.push(text));
  expect(code).toBe(2);
  expect(output).toEqual([]);
  expect(errors.map(text => JSON.parse(text))).toEqual([{ error: 'invalid-argument' }]);
});
