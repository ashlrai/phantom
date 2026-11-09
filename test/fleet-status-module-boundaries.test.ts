import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const directory = new URL('../src/core/fleet/', import.meta.url);

describe('fleet status module boundaries', () => {
  it('keeps the public entry point and each implementation module below 2000 lines', () => {
    const files = readdirSync(directory).filter((name) => /^status(?:-.*)?\.ts$/.test(name));
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), 'utf8');
      expect(source.trimEnd().split('\n').length, file).toBeLessThan(2000);
      expect(source, file).not.toContain('\u2014');
    }
  });

  it('keeps daemon activity observations out of readiness authority after extraction', () => {
    const source = readFileSync(new URL('status-readiness.ts', directory), 'utf8');
    const readiness = source.match(/function shipReadinessSources[\s\S]*?const guardHealth/)?.[0];
    expect(readiness).toBeDefined();
    expect(readiness).not.toMatch(/daemon\.activity|tickInProgress|childActivity/);
  });
});
