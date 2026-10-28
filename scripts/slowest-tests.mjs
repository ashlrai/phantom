#!/usr/bin/env node
// Capture with: npx vitest run --reporter=json --outputFile=vitest-results.json
// Inspect with: node scripts/slowest-tests.mjs vitest-results.json
// Or pipe a JSON report into: node scripts/slowest-tests.mjs -
import { readFileSync } from 'node:fs';

const usage = 'Usage: node scripts/slowest-tests.mjs <vitest-results.json | ->';
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clean = value => Array.from(value, character => {
  const code = character.codePointAt(0);
  return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
}).join('');

function report(input) {
  if (!input || !Array.isArray(input.testResults)) {
    throw new Error('Expected a Vitest JSON object with testResults.');
  }
  const files = [];
  const cases = [];
  let missingFiles = 0;
  let missingCases = 0;
  for (const file of input.testResults) {
    if (!file || typeof file.name !== 'string' || !Array.isArray(file.assertionResults)) {
      throw new Error('Invalid Vitest file result.');
    }
    if (validTime(file.startTime) && validTime(file.endTime) && file.endTime >= file.startTime) {
      files.push({ label: clean(file.name), duration: file.endTime - file.startTime });
    } else {
      missingFiles++;
    }
    for (const test of file.assertionResults) {
      if (!test || typeof test.fullName !== 'string') {
        throw new Error('Invalid Vitest assertion result.');
      }
      if (validTime(test.duration)) {
        cases.push({ label: `${clean(file.name)} > ${clean(test.fullName)}`, duration: test.duration });
      } else {
        missingCases++;
      }
    }
  }
  const section = (title, rows, missing) => {
    rows.sort((a, b) => b.duration - a.duration || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return [title, ...rows.slice(0, 15).map((row, i) => `${i + 1}. ${row.duration.toFixed(2)} ms  ${row.label}`),
      ...(rows.length ? [] : ['(no measured results)']),
      `Omitted without valid timing: ${missing}`].join('\n');
  };
  return `${section('15 slowest files (elapsed time)', files, missingFiles)}\n\n${section('15 slowest cases', cases, missingCases)}\n`;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nReads Vitest JSON; reports up to 15 files and cases in descending milliseconds.\nFile times are endTime - startTime; missing case durations are omitted.`);
  } else {
    if (args.length !== 1 || (args[0].startsWith('-') && args[0] !== '-')) throw new Error(usage);
    let input;
    try {
      input = JSON.parse(readFileSync(args[0] === '-' ? 0 : args[0], 'utf8'));
    } catch {
      throw new Error('Could not read or parse Vitest JSON input.');
    }
    process.stdout.write(report(input));
  }
} catch (error) {
  console.error(`slowest-tests: ${error.message}`);
  process.exitCode = 1;
}
