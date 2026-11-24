/**
 * Judge each of Mason's asks (mason-asks.ts) from the code itself.
 *
 * checkMasonAsks is pure over a SourceIndex: the repo-relative files that
 * exist and the export names each one carries. readSourceIndex builds that
 * index from disk; it returns null when the root is not a source checkout
 * (an installed package ships dist/ only), and every ask then reads unknown
 * rather than missing.
 *
 * State per ask: done when every piece is present, missing when none is,
 * partial otherwise, unknown when there is no index or nothing to check.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MasonAsk, MasonAskPiece } from './mason-asks.js';

export type MasonAskState = 'done' | 'partial' | 'missing' | 'unknown';

export interface SourceIndex {
  paths: readonly string[];
  exports: Readonly<Record<string, readonly string[]>>;
}

export interface MasonAskStatus {
  id: string;
  title: string;
  state: MasonAskState;
  /** Paths of the pieces that are present. */
  evidence: string[];
  /** Plain words for each piece that is not present. */
  gaps: string[];
  next: string;
}

export interface MasonAsksReport {
  schema: 'fleet.asks.v1';
  asks: MasonAskStatus[];
}

/** Present when the file exists and, if named, carries the export. */
function piecePresent(piece: MasonAskPiece, paths: ReadonlySet<string>, index: SourceIndex): boolean {
  if (!piece.path || !paths.has(piece.path)) return false;
  return !piece.exportName || (index.exports[piece.path] ?? []).includes(piece.exportName);
}

function nextStep(state: MasonAskState, firstGap: MasonAskPiece | undefined): string {
  if (state === 'done') return 'None; check it by hand in the app.';
  if (state === 'unknown') return 'Run from a source checkout so the code can be read.';
  if (!firstGap) return 'None.';
  return firstGap.path ? `Restore ${firstGap.need} (${firstGap.path}).` : `Build ${firstGap.need}.`;
}

export function checkMasonAsks(asks: readonly MasonAsk[], index: SourceIndex | null): MasonAsksReport {
  const paths = new Set(index?.paths ?? []);
  return {
    schema: 'fleet.asks.v1',
    asks: asks.map(ask => {
      if (!index || ask.pieces.length === 0) {
        return { id: ask.id, title: ask.title, state: 'unknown', evidence: [], gaps: [], next: nextStep('unknown', undefined) };
      }
      const present = ask.pieces.filter(piece => piecePresent(piece, paths, index));
      const absent = ask.pieces.filter(piece => !present.includes(piece));
      const state: MasonAskState = absent.length === 0 ? 'done' : present.length === 0 ? 'missing' : 'partial';
      return {
        id: ask.id,
        title: ask.title,
        state,
        evidence: [...new Set(present.map(piece => piece.path!))],
        gaps: absent.map(piece => piece.need),
        next: nextStep(state, absent[0]),
      };
    }),
  };
}

const DECLARED_EXPORT = /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;

/** Names a TypeScript source exports at top level; re-exports from lists count by their public name. */
export function exportNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(DECLARED_EXPORT)) names.add(match[1]!);
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Sentinel for a source checkout; an installed package has no web-ui sources. */
const SOURCE_SENTINEL = 'src/web-ui/routes/verse';

export function readSourceIndex(root: string, asks: readonly MasonAsk[]): SourceIndex | null {
  if (!existsSync(join(root, SOURCE_SENTINEL))) return null;
  const paths: string[] = [];
  const exports: Record<string, string[]> = {};
  for (const ask of asks) {
    for (const piece of ask.pieces) {
      if (!piece.path || Object.hasOwn(exports, piece.path)) continue;
      const file = join(root, piece.path);
      if (!existsSync(file)) continue;
      paths.push(piece.path);
      exports[piece.path] = piece.exportName ? exportNames(readFileSync(file, 'utf8')) : [];
    }
  }
  return { paths, exports };
}

export function renderMasonAsksText(report: MasonAsksReport): string {
  return report.asks.map(ask => `${ask.id} ${ask.state.padEnd(7)} ${ask.title}: ${ask.next}`).join('\n') + '\n';
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

export function renderMasonAsksMarkdown(report: MasonAsksReport, asks: readonly MasonAsk[]): string {
  const counts = (['done', 'partial', 'missing', 'unknown'] as const)
    .map(state => `${report.asks.filter(ask => ask.state === state).length} ${state}`).join(', ');
  const lines = [
    '# Mason asks status',
    '',
    'Generated by `phm fleet asks status --markdown`. Do not edit by hand; rerun the command.',
    '',
    'Mason\'s Nov 4-5 asks for the desktop app and phone view, judged from the code on master.',
    'An ask is done when every piece it needs exists and is reachable from the app or a CLI verb.',
    'The ask list lives in `src/core/fleet/mason-asks.ts`.',
    '',
    `Summary: ${counts}.`,
    '',
    '| Ask | Title | State | Next step |',
    '| --- | --- | --- | --- |',
    ...report.asks.map(ask => `| ${ask.id} | ${cell(ask.title)} | ${ask.state} | ${cell(ask.next)} |`),
    '',
    '## Detail',
  ];
  for (const status of report.asks) {
    const ask = asks.find(item => item.id === status.id);
    lines.push('', `### ${status.id} ${status.title}: ${status.state}`, '');
    if (ask) lines.push(ask.ask, '');
    lines.push('Evidence:', '');
    lines.push(...(status.evidence.length ? status.evidence.map(path => `- \`${path}\``) : ['- none']));
    lines.push('', 'Gaps:', '');
    lines.push(...(status.gaps.length ? status.gaps.map(gap => `- ${gap}`) : ['- none']));
  }
  return lines.join('\n') + '\n';
}
