import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateOutputs, outputRegressions, type GoldenTask } from '../src/core/eval/agent-output.js';

const patch = 'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-old\n+new\n';
describe('agent output evaluation', () => {
  it('runs every lane against isolated snapshots and reports dimension regressions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'output-eval-'));
    try {
      writeFileSync(join(dir, 'value.txt'), 'old\n');
      writeFileSync(join(dir, 'test.cjs'), "if (require('fs').readFileSync('value.txt', 'utf8') !== 'new\\n') process.exit(1);\n");
      const task: GoldenTask = { id: 'one', repoPath: dir, problemStatement: 'fix', goldTestCommand: 'node test.cjs', failToPassTests: [], required: ['+new'], forbidden: ['secret'], maxChangedLines: 2 };
      const good = { lane: 'work', model: 'a', runner: async () => patch };
      const bad = { lane: 'fast', model: 'b', runner: async () => '' };
      const report = await evaluateOutputs([task], [bad, good]);
      expect(report.entries.map(e => e.passRate)).toEqual([1, 0]);
      const next = await evaluateOutputs([task], [{ ...good, runner: async () => '' }]);
      expect(outputRegressions(report, next).map(a => a.dimension)).toEqual(['tests', 'diffQuality', 'instructions']);
      expect(outputRegressions(next, report)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects empty and duplicate input', async () => {
    await expect(evaluateOutputs([], [])).rejects.toThrow();
  });
});
