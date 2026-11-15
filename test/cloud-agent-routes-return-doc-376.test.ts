import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync('docs/CLOUD-AGENT-ROUTES.md', 'utf8');
const source = readFileSync('src/core/fleet/coordination-return.ts', 'utf8');
const section = doc.match(/^## Claim work\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
const outcomeUnion = source.match(/interface FleetClaimReturnResult\s*\{[\s\S]*?\boutcome:\s*([^;]+);/);

describe('cloud agent claim return documentation', () => {
  it('documents the return route with real outcomes and no token-shaped values', () => {
    expect(section).toBeDefined();
    expect(section).toContain('ashlr fleet coordination return');
    expect(outcomeUnion).not.toBeNull();
    const outcomes = [...outcomeUnion![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(outcomes.length).toBeGreaterThan(0);
    const mentioned = [...section!.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map(match => match[1]);
    expect(mentioned).toContain('already-returned');
    expect(mentioned).toContain('released-unposted');
    for (const outcome of mentioned) expect(outcomes).toContain(outcome);
    expect(section).not.toMatch(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/);
  });
});
