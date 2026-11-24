import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = resolve(root, 'CONTRIBUTING.md');
const text = readFileSync(doc, 'utf8');

describe('contributor introduction preserved from PR #7065', () => {
  it('keeps the mission, contributor audience and current contribution path', () => {
    expect(statSync(doc).isFile()).toBe(true);
    expect(text).toContain('Phantom (`@ashlr/phantom`');
    expect(text).toContain('**Mission:** chasing open-source RSI (recursive self-improvement)');
    expect(text).toContain('**Who contributes:** mostly coding agents');
    expect(text).toContain('passwords, 2FA, device approvals and payments');
    expect(text).toContain('[the mission](README.md#mission)');
    expect(text).toContain('[the ecosystem](README.md#the-phantom-ecosystem)');
    expect(text).toContain('**First contribution?**');
    expect(text).toContain('docs/CONTRIBUTE-WITH-AN-AGENT.md');
  });

  it('resolves every relative inline and reference link to a file', () => {
    const markdown = text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '');
    const targets = [
      ...[...markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!),
      ...[...markdown.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map((m) => m[1]!),
    ];
    expect(targets.length).toBeGreaterThan(0);
    for (const href of targets) {
      const target = href.replace(/^<|>$/g, '');
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
      expect(statSync(path ? resolve(dirname(doc), path) : doc).isFile(), href).toBe(true);
    }
  });
});
