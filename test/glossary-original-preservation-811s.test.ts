import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const docs = resolve(process.cwd(), 'docs');
const read = (name: string) => readFileSync(resolve(docs, name), 'utf8');
const glossary = read('GLOSSARY.md');
const section = (name: string) => glossary.split(`## ${name}\n`)[1]?.split('\n## ')[0] ?? '';

describe('original glossary preservation', () => {
  it('distinguishes pull request checks from scheduled suites', () => {
    const gate = section('Merge Gate');
    expect(gate).toMatch(/pull request/i);
    expect(gate).toMatch(/fast gate.*typecheck.*tests selected/i);
    expect(gate).toMatch(/full suites and lint.*scheduled `master`/i);
    expect(gate).not.toMatch(/full lint, typecheck and tests before/i);
    expect(gate).toContain('(CONTRIBUTE-WITH-AN-AGENT.md)');
    expect(read('CONTRIBUTE-WITH-AN-AGENT.md')).toMatch(/Fast gate \(typecheck \+ affected tests\)/);
  });

  it('preserves owner messages and links to the console guide and FAQ', () => {
    expect(section('Inbox')).toMatch(/owner's prompts and interjections.*any channel/i);
    expect(section('Interjection')).toMatch(/owner.*steers running work without stopping/i);
    expect(section('Pane')).toContain('(PANES.md)');
    expect(glossary).toContain('(./FAQ.md)');
    expect(read('PANES.md')).toMatch(/pane/i);
    expect(read('FAQ.md')).toMatch(/FAQ|frequently asked/i);
  });
});
