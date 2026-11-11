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
