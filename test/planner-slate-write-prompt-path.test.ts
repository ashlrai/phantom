import { expect, it } from 'vitest';
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlannerSlate, writePlannerSlate } from '../src/core/fleet/planner-slate-write.js';
import { readPlannerPromptPath } from '../src/core/fleet/planner-prompt.js';
it('strictly validates prompt paths and preserves them through private storage', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'slate-prompt-')));
  const base = { v: 1, candidates: [{ provider: 'local', argv: ['unused'] }] };
  const parse = (promptPath: unknown) => parsePlannerSlate(Buffer.from(JSON.stringify({ ...base, promptPath })));
  try {
    for (const bad of ['relative', '/nul\0path', '/' + 'x'.repeat(1024), null, 42]) expect(parse(bad)).toBeNull();
    expect(parsePlannerSlate(Buffer.from(JSON.stringify({ ...base, unknown: true })))).toBeNull();
    expect(parse('/' + 'x'.repeat(1023))).not.toBeNull();
    const slate = parse(join(root, 'brief'))!;
    expect(writePlannerSlate(root, slate)).toBe('written');
    expect(await readPlannerPromptPath(root)).toBe(slate.promptPath);
    expect(writePlannerSlate(root, slate)).toBe('unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
