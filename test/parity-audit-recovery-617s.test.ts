import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync('docs/PARITY.md', 'utf8');

describe('docs/PARITY.md capability audit (recovered from #6484)', () => {
  it('covers every agent class', () => {
    for (const cls of ['codex-cmp', 'codex-local', 'claude-api', 'zai', 'gemini', 'devin', 'Sandboxed fleet engine',
      'Node-pool workers', 'iMessage teammates', 'Desktop apps', 'Interactive sessions']) {
      expect(doc, cls).toContain(cls);
    }
  });

  it('cites only evidence paths that exist', () => {
    const paths = [...doc.matchAll(/`((?:src|contrib|docs|test)\/[\w./-]+\.\w+)`/g)].map(m => m[1]!);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) expect(existsSync(p), p).toBe(true);
  });

  it('separates declared access from live state and Slack receipts from claims', () => {
    expect(doc).toMatch(/does not prove/);
    expect(doc).toMatch(/not a health check/);
    expect(doc).toMatch(/Slack receipt[^.]*is a message, not a live claim/s);
    expect(doc).toContain('phm tools parity');
  });

  it('does not equate loopback inference with a web ban, and links absolutely', () => {
    expect(doc).not.toMatch(/loopback-only[^.]*(break|prohibit)/i);
    expect(doc).toMatch(/separate from declared tool access/);
    expect(doc).not.toMatch(/\]\((?!https?:|#)[^)]+\)/);
  });
});
