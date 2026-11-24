#!/usr/bin/env node
/* global process, console */
// Decide whether a diff can behave differently on Linux, Windows and macOS.
// Docs-only and unrelated source changes stay on the Linux fast gate.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './ci-changed-paths.mjs';

const SCRIPT = /\.(?:sh|bash|zsh|ps1|bat|cmd)$/i;
const MANIFEST = /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|Cargo\.toml|Cargo\.lock|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;
const WORKFLOW = /^\.github\/workflows\//;
const INSTALLER = /(?:^|\/)[^/]*install[^/]*$/i;
const BIN = /(?:^|\/)bin\//;
const PATH_CODE = /(?:^|\/)[^/]*path[^/]*\.(?:ts|tsx|js|mjs|cjs)$/i;
const OS_TREE = /^(?:desktop|contrib)\//;

export function pathIsOsSensitive(file) {
  const name = String(file).replace(/\\/g, '/');
  return SCRIPT.test(name)
    || MANIFEST.test(name)
    || WORKFLOW.test(name)
    || INSTALLER.test(name)
    || BIN.test(name)
    || PATH_CODE.test(name)
    || OS_TREE.test(name);
}

export function diffNeedsOsLegs(paths) {
  return paths.some(pathIsOsSensitive);
}

function writeOutput(value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `os_sensitive=${value}\n`);
  console.log(`os sensitive: ${value}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const event = process.env.EVENT_NAME ?? '';
  if (event !== 'pull_request' && event !== 'merge_group') {
    writeOutput('false');
  } else {
    try {
      const paths = changedPaths({
        base: process.env.ASHLR_CI_BASE_SHA,
        head: process.env.ASHLR_CI_HEAD_SHA,
        cwd: process.cwd(),
      });
      writeOutput(diffNeedsOsLegs(paths) ? 'true' : 'false');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
