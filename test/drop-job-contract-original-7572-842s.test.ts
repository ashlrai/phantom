import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeDropJobFile, validateDropJob, writeDropJob } from '../src/core/fleet/drop-job-writer.js';
import * as mobile from '../src/web-ui/routes/verse/mobile/screens/drop-job-model.js';

const job = { id: 'EXAMPLE123', lane: 'claude', tier: 'work', body: 'A safe task' };
describe('original drop contract parity', () => {
  for (const repo of [undefined, 'ashlr-md']) {
    it(`writes exactly the mobile composition for ${repo ?? 'default repo'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'drop-contract-'));
      try {
        const input = { ...job, repo };
        const written = await writeDropJob(root, input);
        const content = await readFile(written.file, 'utf8');
        expect(content).toBe(composeDropJobFile(input));
        expect(content.startsWith(`#job repo=${repo ?? 'phantom'} lane=claude tier=work\n\n`)).toBe(true);
        expect(written.bytes).toBe(mobile.dropJobBytes(input));
        expect(mobile.validateDropJob(input)).toEqual({ ok: true, payload: input });
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  it('counts UTF-8 bytes including the header at the 8000-byte boundary', () => {
    const prefix = mobile.dropJobBytes({ ...job, body: '' });
    const input = { ...job, body: 'é'.repeat(Math.floor((8000 - prefix) / 2)) + 'x'.repeat((8000 - prefix) % 2) };
    expect(mobile.dropJobBytes(input)).toBe(8000);
    expect(validateDropJob(input).ok).toBe(true);
    expect(mobile.validateDropJob({ ...input, body: input.body + 'x' })).toEqual({ ok: false, reason: 'too-large' });
  });
  it('keeps server reason precedence for malformed and denied content', () => {
    for (const input of [
      { ...job, id: 'x', repo: 'unknown', lane: 'no', tier: 'no', body: '' },
      { ...job, body: 'bad\u0000 .github/workflow' },
      { ...job, repo: 'bad repo' },
    ]) {
      const result = validateDropJob(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(mobile.validateDropJob(input)).toEqual({ ok: false, reason: result.reasons[0] });
    }
  });
  it('validates without Buffer in an isolated process', () => {
    const script = `const m = await import('./src/core/fleet/drop-job-contract.ts'); globalThis.Buffer = undefined; if (!m.validateDropJob(${JSON.stringify(job)}).ok) process.exit(1);`;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});
