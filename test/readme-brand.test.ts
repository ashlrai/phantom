/** README front-door contract: concrete pitch, usable quickstart and source-backed visuals/badges. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const topHalf = readme.split('## The desktop app (macOS)')[0]!;

describe('README top-half brand contract', () => {
  it('opens with the one-line pitch', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toMatch(/^# (?:<img [^>]+> )?Phantom$/);
    const pitch = lines.find((line) => line.startsWith('**') && line.endsWith('**'));
    expect(pitch).toMatch(/open-source workbench/i);
    expect(pitch).toMatch(/coding agents/i);
    expect(pitch).toMatch(/fleet/i);
    expect(pitch).toMatch(/reviewing their work/i);
    expect(pitch).not.toMatch(/runs all engineering/i);
  });

  it('has exactly one Quickstart section with the real install commands', () => {
    expect(readme.match(/^## Quickstart$/gm)).toHaveLength(1);
    const quickstart = readme.split('## Quickstart')[1]!.split(/^## /m)[0]!;
    expect(quickstart).toContain('npm install -g @ashlr/phantom');
    expect(quickstart).toContain('phm verse');
    expect(quickstart).toContain('http://127.0.0.1:7777/verse/');
  });

  it('links the phm.dev/connect onboarding path', () => {
    expect(readme).toContain('](https://phm.dev/connect)');
  });

  it('keeps the candidate-version honesty line exactly once', () => {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const line = `This source tree targets version ${version}; check canonical release availability and exact matching assets before installation.`;
    expect(readme.split(line)).toHaveLength(2);
  });

  it('shows current screenshots or a diagram before the desktop section', () => {
    expect(topHalf).toMatch(/!\[[^\]]*\]\([^)]*docs\/images\/[^)]+\)/);
    expect(topHalf).toContain('```mermaid');
  });

  it('links the live CI, npm version, license, repository, release and community badges', () => {
    const badges = [...readme.split("## Mission")[0]!.matchAll(/\[!\[[^\]]*\]\(([^)]+)\)\]\(([^)]+)\)/g)];
    expect(badges.map(([, image, target]) => [image, target])).toEqual([
      ['https://github.com/ashlrai/phantom/actions/workflows/ci.yml/badge.svg', 'https://github.com/ashlrai/phantom/actions/workflows/ci.yml'],
      ['https://img.shields.io/npm/v/%40ashlr%2Fphantom', 'https://www.npmjs.com/package/@ashlr/phantom'],
      ['https://img.shields.io/github/license/ashlrai/phantom', 'LICENSE'],
      ['https://img.shields.io/github/stars/ashlrai/phantom?logo=github', 'https://github.com/ashlrai/phantom/stargazers'],
      ['https://img.shields.io/npm/dm/%40ashlr%2Fphantom?logo=npm&label=npm%20downloads', 'https://www.npmjs.com/package/@ashlr/phantom'],
      ['https://img.shields.io/github/v/release/ashlrai/phantom?sort=semver', 'https://github.com/ashlrai/phantom/releases/latest'],
      ['https://img.shields.io/badge/Discord-The%20Dev%20Shack-5865F2?logo=discord&logoColor=white', 'https://discord.gg/jBQrSU6XeD'],
    ]);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; license: string };
    expect(pkg).toMatchObject({ name: '@ashlr/phantom', license: 'MIT' });
    expect(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')).toContain('name:');
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain('MIT');
  });

  it('ships the fleet overview with sample data distinct from the current-source capture', () => {
    const path = 'docs/images/phantom-fleet-overview.png';
    expect(readme).toMatch(/!\[[^\]]*resource balances[^\]]*\]\(docs\/images\/phantom-fleet-overview\.png\)/);
    expect(readme).toContain('Phantom Fleet overview with sample data.');
    expect(readme).toContain('362 merges in 24 hours');
    expect(readme).toContain('Leader inbox with dictation');
    expect(readme).toContain('separate Devin Cloud and Local rows');
    expect(readme).toContain('[See the current Fleet capture with demo data](docs/images/phantom-fleet-demo.png)');
    const png = readFileSync(join(ROOT, path));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1920);
    expect(png.readUInt32BE(20)).toBe(1422);
  });

  it('ships retina captures with descriptive alt text and explicit demo provenance', () => {
    for (const name of ['bus', 'workbench']) {
      const path = `docs/images/phantom-${name}-demo.png`;
      const href = `https://github.com/ashlrai/phantom/blob/master/${path}`;
      expect(readme).toContain(`](${href})`);
      const alt = readme.split(`](${href})`)[0]!.split('![').at(-1)!;
      expect(alt.length).toBeGreaterThan(60);
      expect(alt).toMatch(/sample|demo/i);
      const png = readFileSync(join(ROOT, path));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(2880);
      expect(png.readUInt32BE(20)).toBe(2000);
    }
    const provenance = readFileSync(join(ROOT, 'docs/images/CAPTURES.md'), 'utf8');
    expect(provenance).toContain('synthetic');
    expect(provenance).toContain('native');
    expect(provenance).toMatch(/[a-f0-9]{40}/);
  });
});
