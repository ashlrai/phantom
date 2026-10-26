/**
 * Local engines never carry main-merge authority (inbox/merge.ts
 * evaluateMergeAuthority), even when config promotes them to tier 'frontier'
 * or lists them in mergeAuthority. Pure: no git, GitHub or model.
 */
import { describe, expect, it } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';

const p = (engineModel: string): Proposal => ({
  id: 'x', repo: '/tmp/repo', origin: 'swarm', kind: 'patch', title: 'x', summary: '',
  diff: 'diff --git a/x b/x\n', status: 'pending', createdAt: new Date().toISOString(),
  engineTier: 'frontier', engineModel,
} as Proposal);

describe('evaluateMergeAuthority refuses local engines listed in mergeAuthority', () => {
  it('a promoted local engine id in mergeAuthority is refused', () => {
    const cfg = { foundry: { mergeAuthority: [{ engine: 'local-coder', model: 'qwen3-coder' }, { engine: 'claude', model: 'claude-opus-4-8' }] } } as unknown as AshlrConfig;
    const v = evaluateMergeAuthority(p('local-coder:qwen3-coder'), cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/runs locally/);
    expect(evaluateMergeAuthority(p('ollama:qwen3:8b'), { foundry: { mergeAuthority: [{ engine: 'ollama', model: 'qwen3:8b' }] } } as unknown as AshlrConfig).authorized).toBe(false);
    expect(evaluateMergeAuthority(p('claude:claude-opus-4-8'), cfg).authorized).toBe(true);
  });

  it('a frontier-tier engine whose endpoint is 127.0.0.1 is refused even when listed', () => {
    const listed = [{ engine: 'nim', model: 'kimi-k2' }];
    const loop = { foundry: { mergeAuthority: listed, nim: { baseUrl: 'http://127.0.0.1:8000/v1', tier: 'frontier' } } } as unknown as AshlrConfig;
    expect(evaluateMergeAuthority(p('nim:kimi-k2'), loop)).toMatchObject({ authorized: false });
    const engines = { foundry: { mergeAuthority: listed, engines: { nim: { defaultBaseUrl: 'http://localhost:9000/v1' } } } } as unknown as AshlrConfig;
    expect(evaluateMergeAuthority(p('nim:kimi-k2'), engines).authorized).toBe(false);
    const remote = { foundry: { mergeAuthority: listed, nim: { baseUrl: 'https://integrate.api.nvidia.com/v1' } } } as unknown as AshlrConfig;
    expect(evaluateMergeAuthority(p('nim:kimi-k2'), remote).authorized).toBe(true);
  });
});
