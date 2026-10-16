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
