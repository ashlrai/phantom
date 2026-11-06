/**
 * The CHANGELOG must carry a section for the package.json version, placed after
 * the first Unreleased section, and extract-changelog must print it. A release
 * tag without this section fails the release workflow, so this guards the gap
 * that release-please leaves when it bumps the version with skip-changelog.
 * Pure filesystem reads and a child-process run of the script; no network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
const lines = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
const version = pkg.version;

beforeEach(() => {
  expect.hasAssertions();
});

describe('CHANGELOG.md current version section', () => {
  it('has exactly one heading for the package version', () => {
    // The bracket closes the version, so 3.29.1 never matches 3.29.16.
    const headings = lines.filter((line) => line.startsWith(`## [${version}]`));
    expect(headings).toHaveLength(1);
  });

  it('has a section body longer than 50 characters', () => {
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    const nextOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## ['));
    const end = nextOffset === -1 ? lines.length : start + 1 + nextOffset;
    const body = lines.slice(start + 1, end).join('\n').trim();
    expect(body.length).toBeGreaterThan(50);
  });

  it('places the version section after the first Unreleased heading', () => {
    const unreleased = lines.findIndex((line) => line.startsWith('## [') && line.includes('Unreleased'));
    const versionIndex = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    expect(unreleased).toBeGreaterThanOrEqual(0);
    expect(versionIndex).toBeGreaterThan(unreleased);
  });

  it('is printed by extract-changelog for the package version', () => {
    const printed = execFileSync('node', [join(REPO_ROOT, 'scripts/extract-changelog.mjs'), version], {
      encoding: 'utf8',
    });
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    const nextOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## ['));
    const end = nextOffset === -1 ? lines.length : start + 1 + nextOffset;
    const expected = lines.slice(start + 1, end).join('\n').trim();
    expect(printed.trim()).toBe(expected);
  });
});
