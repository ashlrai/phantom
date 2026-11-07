import { it, expect, vi } from 'vitest';
import { apiPost, ApiError } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';
import { parsePlanCommand } from './composer-text.js';
import { runPlanCommand } from './planner-run-command.js';
vi.mock('../../../data/client.js', async original => ({ ...await original<typeof import('../../../data/client.js')>(), apiPost: vi.fn() }));
vi.mock('../../../data/auth-store.js', () => ({ getMutationToken: vi.fn(() => 'local'), touchMutationHold: vi.fn() }));
it('parses bounded reasons and reports pass outcomes and refusals', async () => {
  expect(parsePlanCommand('/planet')).toBeNull();
  expect(parsePlanCommand('/plan')).toEqual({ reason: '' });
  expect(parsePlanCommand('/plan ' + 'x'.repeat(201))?.reason).toHaveLength(200);
  vi.mocked(apiPost).mockResolvedValue({ v: 1, provider: 'local', outcome: 'ran', exitCode: 0 });
  expect(await runPlanCommand('/plan check')).toEqual({ ok: true, text: 'Planner pass ran on local: ran (exit 0)' });
  expect(apiPost).toHaveBeenCalledWith('/api/verse/leader/planner/run', { reason: 'check' }, 'local');
  for (const [detail, text] of [['no-slate', 'No planner slate declared'], ['no-prompt-declared', 'No prompt declared in the slate'], ['pass-in-flight', 'A planner pass is already running']]) {
    vi.mocked(apiPost).mockRejectedValue(new ApiError('conflict', 409, '/', detail));
    expect((await runPlanCommand('/plan')).text).toContain(text);
  }
  vi.mocked(getMutationToken).mockReturnValue(null);
  vi.mocked(apiPost).mockClear();
  expect((await runPlanCommand('/plan')).ok).toBe(false);
  expect(apiPost).not.toHaveBeenCalled();
});
