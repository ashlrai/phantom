import { expect, it } from 'vitest';
import {
  compareReleaseVersions, parseReleaseVersion, releaseVersionLine, releaseVersionVerdict, treeVersionFromPackageJson,
} from '../src/core/verse/release-version-guard.js';

it('parses only strict x.y.z release versions', () => {
  expect(parseReleaseVersion('3.30.0')).toEqual([3, 30, 0]);
  expect(parseReleaseVersion('3.29.16')).toEqual([3, 29, 16]);
  expect(parseReleaseVersion('0.0.1')).toEqual([0, 0, 1]);
  for (const bad of [null, undefined, 3300, {}, 'v3.30.0', '3.30', '3.30.0.1', '3.30.0-beta.1', ' 3.30.0', '3.30.0 ', '3.30000.0', 'a.b.c', '', '3.30.x']) {
    expect(parseReleaseVersion(bad), JSON.stringify(bad)).toBeNull();
  }
});

it('orders release versions numerically, segment by segment', () => {
  expect(compareReleaseVersions([3, 29, 16], [3, 30, 0])).toBe(-1);
  expect(compareReleaseVersions([3, 30, 0], [3, 30, 0])).toBe(0);
  expect(compareReleaseVersions([3, 30, 1], [3, 30, 0])).toBe(1);
  expect(compareReleaseVersions([4, 0, 0], [3, 99, 99])).toBe(1);
  expect(compareReleaseVersions([3, 9, 9], [3, 10, 0])).toBe(-1);
});

it('verdicts: downgrade / match / ahead / unknown', () => {
  expect(releaseVersionVerdict('3.29.16', '3.30.0')).toBe('downgrade');
  expect(releaseVersionVerdict('3.30.0', '3.30.0')).toBe('match');
  expect(releaseVersionVerdict('3.30.1', '3.30.0')).toBe('ahead');
  expect(releaseVersionVerdict(null, '3.30.0')).toBe('unknown');
  expect(releaseVersionVerdict('3.30.0', null)).toBe('unknown');
  expect(releaseVersionVerdict(null, null)).toBe('unknown');
  expect(releaseVersionVerdict('v3.30.0', '3.30.0')).toBe('unknown');
  expect(releaseVersionVerdict('3.30.0', 'v3.30.0')).toBe('unknown');
});

it('reads the tree version only from a parseable package.json with a semver', () => {
  expect(treeVersionFromPackageJson('{"name":"@ashlr/phantom","version":"3.30.0"}')).toBe('3.30.0');
  expect(treeVersionFromPackageJson('{oops')).toBeNull();
  expect(treeVersionFromPackageJson('{"version":"next"}')).toBeNull();
  expect(treeVersionFromPackageJson('{"version":3300}')).toBeNull();
  expect(treeVersionFromPackageJson('{"version":"v3.30.0"}')).toBeNull();
  expect(treeVersionFromPackageJson('{}')).toBeNull();
  expect(treeVersionFromPackageJson('["3.30.0"]')).toBeNull();
  expect(treeVersionFromPackageJson('null')).toBeNull();
  expect(treeVersionFromPackageJson(null)).toBeNull();
});

it('names the fix in the downgrade line and stays neutral elsewhere', () => {
  expect(releaseVersionLine(1479, '3.29.16', '3.30.0', 'downgrade')).toBe(
    "Release PR #1479 would ship 3.29.16 but the tree targets 3.30.0; fix release-please's version (a Release-As footer or the manifest) or merge with confirmVersion.");
  expect(releaseVersionLine(1479, '3.30.0', '3.30.0', 'match')).toContain('#1479');
  expect(releaseVersionLine(1479, '3.30.1', '3.30.0', 'ahead')).toContain('ahead');
  expect(releaseVersionLine(1479, null, '3.30.0', 'unknown')).toContain('#1479');
});
