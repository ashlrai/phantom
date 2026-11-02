#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph, type GraphSnapshot } from '../../src/core/graph/loader.js';
import { graphNeighborhood } from '../../src/core/graph/neighborhood.js';

const HELP = `Usage: npx tsx examples/upgrade/graph-upgrade-audit.ts --node ID

Check a saved graph reference without printing graph records.
Exit codes: 0 verified, 1 mismatch or failure, 2 usage, 3 insufficient evidence.
`;
const ISSUE_CODES = new Set(['malformed', 'bad-version', 'secret-field', 'bad-ref', 'duplicate-ref', 'unresolved-edge', 'graph-limit']);
const FLEET_ID = /^(fleet|repo|lane|seat|hold):/;
const MAX_ISSUES = 128;

type Dependencies = {
  load?: typeof loadGraph;
  neighborhood?: typeof graphNeighborhood;
  write?: (text: string) => void;
};

/** Return an exit code and write one bounded JSON result (or help). */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const emit = (value: object, exit: number) => {
    write(`${JSON.stringify(value)}\n`);
    return exit;
  };
  const fail = (code: string, message: string, exit: number) =>
    emit({ schemaVersion: 1, status: 'error', error: { code, message } }, exit);
  if (args.length === 1 && args[0] === '--help') {
    write(HELP);
    return 0;
  }
  const id = args[1];
  if (args.length !== 2 || args[0] !== '--node' || !id || id !== id.trim()
    || id.length > 160 || id.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/.test(id)) {
    return fail('GRAPH_USAGE', 'Expected --node followed by a valid ID. Use --help for usage.', 2);
  }
  try {
    const graph = await (deps.load ?? loadGraph)();
    if (graph.status === 'unavailable') {
      return emit({ schemaVersion: 1, status: 'unavailable', available: false, rootFound: null }, 3);
    }
    if (graph.status !== 'ready' || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('Invalid graph');
    }
    const metadata = summarize(graph);
    // 500 is the reader's node cap: this also detects a further node on a long chain.
    const neighborhood = (deps.neighborhood ?? graphNeighborhood)(graph, id, 'both', 500);
    if (!neighborhood) {
      // The current public seed only inventories these fleet kinds, never tasks or outputs.
      const conclusive = metadata.evidenceComplete && FLEET_ID.test(id);
      return emit({ schemaVersion: 1, status: conclusive ? 'not_found' : 'insufficient_evidence',
        available: true, rootFound: false, counts: null, truncated: null, ...metadata }, conclusive ? 1 : 3);
    }
    const counts = { tasks: 0, outputs: 0 };
    for (const node of neighborhood.nodes) {
      if (node.kind === 'task') counts.tasks++;
      if (node.kind === 'output') counts.outputs++;
    }
    const verified = metadata.evidenceComplete && !neighborhood.truncated;
    return emit({ schemaVersion: 1, status: verified ? 'verified' : 'insufficient_evidence',
      available: true, rootFound: true, counts, truncated: neighborhood.truncated, ...metadata }, verified ? 0 : 3);
  } catch {
    return fail('GRAPH_READ_FAILED', 'Could not audit graph data.', 1);
  }
}

function summarize(graph: GraphSnapshot) {
  const sources = graph.sources ? {
    fleetJson: graph.sources.fleetJson.state,
    seats: graph.sources.seats.state,
  } : null;
  const rawIssues = graph.issues;
  const issues = rawIssues ? rawIssues.slice(0, MAX_ISSUES).map(issue => ({
    code: ISSUE_CODES.has(issue.code) ? issue.code : 'unknown',
    relatedNodeCount: Array.isArray(issue.nodeIds) ? issue.nodeIds.length : 0,
  })) : null;
  const issuesTruncated = rawIssues ? rawIssues.length > MAX_ISSUES : null;
  const evidenceComplete = graph.complete === true && sources?.fleetJson === 'loaded'
    && sources.seats === 'loaded' && issues !== null && issues.length === 0 && !issuesTruncated;
  return { complete: graph.complete ?? null, sources, issues, issuesTruncated, evidenceComplete };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
