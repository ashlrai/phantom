import { describe, expect, it } from 'vitest';

import { adapterById } from '../src/core/providers/coding-cli/adapters.js';
import { loadCatalog } from '../src/core/providers/coding-cli/catalog.js';

describe('coding CLI goal arguments', () => {
  const catalog = loadCatalog();
  const cwd = '/work/phantom';

  it.each([null, 'accepted-model'])('keeps Codex options before the goal with model %s', (model) => {
    const goal = '--dangerously-bypass-approvals-and-sandbox\nFix the parser';
    expect(adapterById(catalog, 'codex')!.execArgs(goal, cwd, model)).toEqual([
      'exec', ...(model ? ['--model', model] : []), '--cd', cwd, '--json', '--', goal,
    ]);
  });

  it.each([null, 'accepted-model'])('keeps Claude options before the goal with model %s', (model) => {
    const goal = '--dangerously-skip-permissions\nFix the parser';
    expect(adapterById(catalog, 'claude')!.execArgs(goal, cwd, model)).toEqual([
      '-p', ...(model ? ['--model', model] : []), '--output-format', 'json', '--add-dir', cwd, '--', goal,
    ]);
  });

  it.each([null, 'accepted-model'])('binds the Grok goal to its single option with model %s', (model) => {
    const goal = '--model=untrusted-model\nFix the parser';
    expect(adapterById(catalog, 'grok')!.execArgs(goal, cwd, model)).toEqual([
      ...(model ? ['--model', model] : []), '--cwd', cwd, `--single=${goal}`,
    ]);
  });
});
