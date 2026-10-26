import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdImprove } from '../src/cli/improve.js';
import { gatherProposals, openProposalPr } from '../src/core/improve/loop.js';
import { defaultStewardPolicy, runSteward } from '../src/core/steward/disk.js';

vi.mock('../src/core/improve/loop.js', () => ({ gatherProposals: vi.fn(() => []), openProposalPr: vi.fn(), renderProposal: vi.fn() }));
vi.mock('../src/core/steward/disk.js', () => ({ defaultStewardPolicy: vi.fn(), runSteward: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('improvement CLI protected merge boundary', () => {
  it('refuses auto-merge before gathering local context or scanning disk', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdImprove(['propose', '--open-pr', '--repo', '/unused', '--auto-merge'])).toBe(2);
    expect(gatherProposals).not.toHaveBeenCalled();
    expect(defaultStewardPolicy).not.toHaveBeenCalled();
    expect(runSteward).not.toHaveBeenCalled();
    expect(openProposalPr).not.toHaveBeenCalled();
  });
});

describe('improvement CLI --json with --open-pr', () => {
  const proposal = { id: 'p1' } as unknown as ReturnType<typeof gatherProposals>[number];

  it('prints one JSON object listing opened PRs instead of bare PR lines', async () => {
    vi.mocked(gatherProposals).mockReturnValueOnce([proposal]);
    vi.mocked(openProposalPr).mockReturnValueOnce('https://example.invalid/pr/1');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdImprove(['propose', '--open-pr', '--repo', '/unused', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ opened: [{ id: 'p1', pr: 'https://example.invalid/pr/1' }] });
  });

  it('reports a failed PR and a missing --repo as JSON errors with non-zero exits', async () => {
    vi.mocked(gatherProposals).mockReturnValueOnce([proposal]).mockReturnValueOnce([proposal]);
    vi.mocked(openProposalPr).mockImplementationOnce(() => { throw new Error('no origin'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdImprove(['propose', '--open-pr', '--repo', '/unused', '--json'])).toBe(1);
    expect(await cmdImprove(['propose', '--open-pr', '--json'])).toBe(2);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown)).toEqual([
      { opened: [], error: 'p1: no origin' },
      { opened: [], error: '--open-pr needs --repo <checkout>' },
    ]);
  });
});
