import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { readPlannerPromptPath } from '../src/core/fleet/planner-prompt.js';

it('reads only absolute, NUL-free prompt paths from a bounded slate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-'));
  try {
    await mkdir(join(root, 'queue'));
    expect(await readPlannerPromptPath(root)).toBeNull();
    for (const promptPath of [undefined, 'relative', '/bad\0path', '/prompt']) {
      await writeFile(join(root, 'queue/planner-candidates.json'), JSON.stringify({ promptPath }));
      expect(await readPlannerPromptPath(root)).toBe(promptPath === '/prompt' ? '/prompt' : null);
    }
    await writeFile(join(root, 'queue/planner-candidates.json'), JSON.stringify({ promptPath: '/prompt', padding: ' '.repeat(65536) }));
    expect(await readPlannerPromptPath(root)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
