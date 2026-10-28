import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNightlyRetro } from '../src/core/learn/retro/nightly.js';
import { extractNightlyReview } from '../src/core/learn/retro/extract.js';
import { learnHome, NIGHTLY_MAX_RECORDS, nightlyProposalsPath, readNightlyState, updateNightlyState } from '../src/core/learn/retro/store.js';
import * as privateWrites from '../src/core/util/private-file-write.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');
const DAY = 86_400_000;
const ENABLED = { foundry: { selfImprove: true } };
const fixtures = fileURLToPath(new URL('./fixtures/retro-nightly/', import.meta.url));
let home: string;

async function seed(): Promise<void> {
  const input = join(learnHome(), 'retro-input');
  await mkdir(input, { recursive: true, mode: 0o700 });
  for (const name of ['jobs.jsonl', 'review-blocks.jsonl']) {
    await writeFile(join(input, name), await readFile(join(fixtures, name)), { mode: 0o600 });
  }
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'phantom-nightly-safety-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('nightly persistence safety regressions', () => {
  it.each(['.ashlr', 'learn'])('refuses a redirected %s directory before writing through it', async (component) => {
    const target = join(home, 'TEST-redirect-target');
    await mkdir(target, { mode: 0o700 });
    if (component === 'learn') await mkdir(join(home, '.ashlr'), { mode: 0o700 });
    const link = component === '.ashlr' ? join(home, '.ashlr') : learnHome();
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects array-valued statuses instead of coercing them to an outcome', async () => {
    await seed();
    const input = join(learnHome(), 'retro-input', 'jobs.jsonl');
    const raw = JSON.parse((await readFile(input, 'utf8')).split('\n')[0]!) as Record<string, unknown>;
    await writeFile(input, `${JSON.stringify({ ...raw, status: ['failed'] })}\n`);
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
    expect(await readNightlyState()).toBeNull();
  });

  it('rejects array-valued persisted causes instead of coercing them to a lesson', () => {
    expect(() => extractNightlyReview({
      v: 1, id: 'TEST-review', repo: 'ashlrai/phantom', jobId: 'TEST-failure',
      kind: 'review-block', updatedAt: '2026-10-25T23:00:00.000Z', cause: ['verification'],
    }, true)).toThrow('Invalid nightly cause');
  });

  it.each(['2026-02-30', '2026-13-01', '2026-10-27'])(
    'refuses an impossible or future completed night %s without overwriting evidence', async (completedNight) => {
      await seed();
      expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
      const state = await readNightlyState();
      const invalid = `${JSON.stringify({ ...state, completedNight })}\n`;
      await writeFile(nightlyProposalsPath(), invalid);
      expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('unavailable');
      expect(await readFile(nightlyProposalsPath(), 'utf8')).toBe(invalid);
    },
  );

  it.each(['jobs', 'reviews', 'priors', 'lessons', 'proposals'] as const)(
    'rejects excessive %s before replacing the readable snapshot', async (field) => {
      await seed();
      expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
      const bytes = await readFile(nightlyProposalsPath(), 'utf8');
      const state = (await readNightlyState())!;
      const oversized = { ...state, [field]: Array.from({ length: NIGHTLY_MAX_RECORDS + 1 }, () => state[field][0]) };
      await expect(updateNightlyState(async () => oversized)).rejects.toThrow('Nightly output exceeds record bound');
      expect(await readFile(nightlyProposalsPath(), 'utf8')).toBe(bytes);
      expect((await runNightlyRetro(ENABLED, NOW + DAY)).status).toBe('completed');
    },
  );

  it('leaves the previous night intact on write failure and retries without duplicate effects', async () => {
    await seed();
    expect((await runNightlyRetro(ENABLED, NOW)).status).toBe('completed');
    const beforeBytes = await readFile(nightlyProposalsPath(), 'utf8');
    const before = await readNightlyState();
    const writer = vi.spyOn(privateWrites, 'writePrivateFileAtomicallyAsync').mockRejectedValueOnce(new Error('TEST storage unavailable'));
    expect((await runNightlyRetro(ENABLED, NOW + DAY)).status).toBe('unavailable');
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await readFile(nightlyProposalsPath(), 'utf8')).toBe(beforeBytes);
    writer.mockRestore();
    expect((await runNightlyRetro(ENABLED, NOW + DAY)).status).toBe('completed');
    expect(await readNightlyState()).toEqual({ ...before, completedNight: '2026-10-27' });
    expect((await readdir(learnHome())).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });
});
