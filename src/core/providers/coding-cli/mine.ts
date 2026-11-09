/**
 * Local backlog mining. Reads the spend ledger, a CI-failure file, and a
 * review-comment file, then returns candidate items. It does not open issues
 * or post comments.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readSpendDecisions, type SpendDecision } from './ledger.js';

export interface MineSources {
  ledgerPath: string;
  ciPath?: string;
  reviewsPath?: string;
}

export interface BacklogCandidate {
  id: string;
  source: 'ledger' | 'ci' | 'review';
  summary: string;
  evidence: string;
}

export interface BacklogFile {
  version: 1;
  published: false;
  candidates: BacklogCandidate[];
}

export class MineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MineInputError';
  }
}

function readOptionalJson(path: string | undefined): unknown {
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new MineInputError(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MineInputError(`cannot parse ${path}`);
  }
}

function asRecords(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>)[key])
      ? (value as Record<string, unknown>)[key] as unknown[]
      : [];
  return list.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

function textOf(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

function ledgerCandidates(rows: readonly SpendDecision[]): BacklogCandidate[] {
  const out: BacklogCandidate[] = [];
  for (const row of rows) {
    if (row.verification === 'failed') {
      out.push({
        id: `ledger:${row.poolId}:verification-failed:${row.ts}`,
        source: 'ledger',
        summary: `${row.poolId} failed verification`,
        evidence: `${row.backend} ${row.ts} verification failed`,
      });
    }
    if (row.ci === 'failed') {
      out.push({
        id: `ledger:${row.poolId}:ci-failed:${row.ts}`,
        source: 'ledger',
        summary: `${row.poolId} failed CI`,
        evidence: `${row.backend} ${row.ts} ci failed`,
      });
    }
  }
  return out;
}

function ciCandidates(value: unknown): BacklogCandidate[] {
  return asRecords(value, 'runs').flatMap((row) => {
    const conclusion = textOf(row, 'conclusion') || textOf(row, 'status');
    if (!/fail/i.test(conclusion)) return [];
    const name = textOf(row, 'name') || 'ci';
    const url = textOf(row, 'url') || textOf(row, 'htmlUrl');
    const evidence = [conclusion, url].filter((part) => part.length > 0).join(' ');
    return [{
      id: `ci:${name}:${evidence}`,
      source: 'ci' as const,
      summary: `CI failed: ${name}`,
      evidence,
    }];
  });
}

function reviewCandidates(value: unknown): BacklogCandidate[] {
  return asRecords(value, 'comments').flatMap((row) => {
    const body = textOf(row, 'body');
    if (!body) return [];
    const path = textOf(row, 'path');
    const pr = typeof row['pr'] === 'number' ? String(row['pr']) : typeof row['pullRequest'] === 'number' ? String(row['pullRequest']) : '';
    const where = [pr ? `pr ${pr}` : '', path].filter((part) => part.length > 0).join(' ');
    const summary = body.length > 180 ? `${body.slice(0, 177)}...` : body;
    return [{
      id: `review:${where}:${summary}`,
      source: 'review' as const,
      summary,
      evidence: where || 'review comment',
    }];
  });
}

export function mineBacklog(sources: MineSources): BacklogFile {
  const seen = new Set<string>();
  const candidates = [
    ...ledgerCandidates(readSpendDecisions(sources.ledgerPath)),
    ...ciCandidates(readOptionalJson(sources.ciPath)),
    ...reviewCandidates(readOptionalJson(sources.reviewsPath)),
  ].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { version: 1, published: false, candidates };
}

export function writeBacklog(path: string, file: BacklogFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
