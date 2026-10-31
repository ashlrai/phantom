import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const plan = readFileSync('ci/cache-plan.md', 'utf8');
const snippets = [...plan.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => parse(match[1]));

describe('CI cache handoff', () => {
  it('provides parseable warmer and consumer templates with matching keys', () => {
    expect(snippets).toHaveLength(3);
    const npm = snippets[0]['cache-npm-master'];
    expect(npm.if).toContain("refs/heads/master");
    const restore = npm.steps.find((step: { id?: string }) => step.id === 'npm-cache');
    const save = npm.steps.find((step: { name?: string }) => step.name === 'Save npm downloads');
    expect(restore.with.path).toBe('~/.npm');
    expect(restore.with.key).toBe(save.with.key);
    expect(restore.with.key).toContain("hashFiles('package-lock.json')");
    const bun = snippets[1];
    expect(bun[0].with.path).toBe('~/.bun/install/cache');
    expect(bun[0].with.key).toBe(bun[2].with.key);
    expect(bun[0].with.key).toContain("hashFiles('bun.lock')");
    expect(bun[2].if).toContain("refs/heads/master");
    const rust = snippets[2][0];
    expect(rust.uses).toMatch(/^Swatinem\/rust-cache@[a-f0-9]{40}$/);
    expect(rust.with.workspaces).toBe('desktop/src-tauri -> target');
    expect(rust.with.key).toContain("hashFiles('desktop/src-tauri/Cargo.lock')");
    expect(rust.with['save-if']).toContain("refs/heads/master");
  });
});
