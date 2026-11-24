#!/usr/bin/env node
/**
 * Compare two authority-surface manifests and print the files-changed count.
 * The workflow job is read-only: it posts this summary and does not fail a
 * pull request because the digest moved.
 */
import { appendFileSync, readFileSync } from 'node:fs';

export function authoritySurfaceDelta(base, head) {
  const baseFiles = new Map((base.files ?? []).map((file) => [file.path, file.sha256]));
  const headFiles = new Map((head.files ?? []).map((file) => [file.path, file.sha256]));
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  let filesChanged = 0;
  for (const path of paths) {
    if (baseFiles.get(path) !== headFiles.get(path)) filesChanged += 1;
  }
  const basePackages = new Map((base.packages ?? []).map((pkg) => [pkg.name, pkg.version]));
  const headPackages = new Map((head.packages ?? []).map((pkg) => [pkg.name, pkg.version]));
  const names = new Set([...basePackages.keys(), ...headPackages.keys()]);
  let packagesChanged = 0;
  for (const name of names) {
    if (basePackages.get(name) !== headPackages.get(name)) packagesChanged += 1;
  }
  const digestChanged = base.digest !== head.digest;
  return {
    filesChanged,
    packagesChanged,
    digestChanged,
    label: digestChanged ? 'authority-delta' : null,
  };
}

function summary(delta) {
  return [
    'files-changed: ' + delta.filesChanged,
    'packages-changed: ' + delta.packagesChanged,
    'digest-changed: ' + (delta.digestChanged ? 'yes' : 'no'),
    'label: ' + (delta.label ?? 'none'),
  ].join('\n');
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('authority-surface-delta.mjs');
if (invokedDirectly) {
  if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node scripts/authority-surface-delta.mjs <base.json> <head.json>');
    process.exitCode = 2;
  } else {
    const base = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const head = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const text = summary(authoritySurfaceDelta(base, head));
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  }
}
