#!/usr/bin/env node
/* global process, console */
// Turns a failed check's log into GitHub annotations and a short step summary.
// Output only: the caller still decides pass or fail.
import { appendFileSync, readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

const SUMMARY_LINES = 5;
// Same shape ci-baseline reads from tsc/tsgo: path(line,col): error TSnnnn: message.
const TSC_LINE = /^([^\s()]+)\((\d+),(\d+)\):\s*(error\s+TS\d+:.*)$/;
const TRAILER = /^(?:\d+ allowed=\d+|leaks found: \d+)$/i;

export function pickFailureLines(text, limit = SUMMARY_LINES) {
  const lines = stripVTControlCharacters(String(text)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tsc = lines.filter((line) => TSC_LINE.test(line));
  const trailers = lines.filter((line) => TRAILER.test(line));
  const findings = lines.filter((line) => !TSC_LINE.test(line) && !TRAILER.test(line));
  const ordered = [];
  for (const line of [...tsc, ...findings, ...trailers]) {
    if (ordered.includes(line)) continue;
    ordered.push(line);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

export function annotationFor(line) {
  const match = TSC_LINE.exec(line);
  if (match) return `::error file=${match[1]},line=${match[2]},col=${match[3]}::${match[4]}`;
  return `::error::${line}`;
}

export function summarizeFailure({ title, text, limit = SUMMARY_LINES }) {
  const lines = pickFailureLines(text, limit);
  const annotations = lines.map(annotationFor);
  const summary = [`### ${title}`, ...lines.map((line) => `- ${line}`)].join('\n');
  return { lines, annotations, summary };
}

function emit(result, summaryPath) {
  for (const line of result.annotations) console.log(line);
  if (summaryPath && result.summary) appendFileSync(summaryPath, `${result.summary}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('ci-failure-summary.mjs')) {
  const titleFlag = process.argv.indexOf('--title');
  const fileFlag = process.argv.indexOf('--file');
  const title = titleFlag === -1 ? 'Check failed' : process.argv[titleFlag + 1];
  const file = fileFlag === -1 ? '' : process.argv[fileFlag + 1];
  if (!title || !file) {
    console.error('usage: ci-failure-summary.mjs --title <name> --file <log>');
    process.exitCode = 2;
  } else {
    emit(summarizeFailure({ title, text: readFileSync(file, 'utf8') }), process.env.GITHUB_STEP_SUMMARY);
  }
}
