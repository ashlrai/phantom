import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export type ReleaseCheckState = 'pass' | 'fail' | 'pending' | 'skipped';
export interface ReleaseCheck { name: string; state: ReleaseCheckState; url: string | null }
export interface ReleasePr {
  number: number; title: string; url: string; version: string | null;
  openedAt: string; updatedAt: string; mergeable: string | null;
  checks: ReleaseCheck[]; failing: string[]; pending: number; blocked: boolean; summary: string;
}
export interface ReleasePrData {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'degraded';
  repos: { repo: string; path: string; pr: ReleasePr | null; notes: string[] }[];
}
export type ReleasePrResult = { kind: 'available'; data: ReleasePrData } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');

function isReleasePr(value: unknown): boolean {
  if (!object(value)) return false;
  return Number.isSafeInteger(value.number) && typeof value.title === 'string' && typeof value.url === 'string'
    && nullableString(value.version) && typeof value.openedAt === 'string' && typeof value.updatedAt === 'string'
    && nullableString(value.mergeable) && typeof value.summary === 'string' && typeof value.blocked === 'boolean'
    && Number.isSafeInteger(value.pending) && (value.pending as number) >= 0 && strings(value.failing)
    && Array.isArray(value.checks) && value.checks.every(check => object(check) && typeof check.name === 'string'
      && ['pass', 'fail', 'pending', 'skipped'].includes(String(check.state)) && nullableString(check.url));
}

function isReleasePrData(value: unknown): value is ReleasePrData {
  return object(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && (value.sourceState === 'healthy' || value.sourceState === 'degraded') && Array.isArray(value.repos)
    && value.repos.every(repo => object(repo) && typeof repo.repo === 'string' && typeof repo.path === 'string'
      && strings(repo.notes) && (repo.pr === null || isReleasePr(repo.pr)));
}

export const releasePrQuery: QueryDef<ReleasePrResult> = {
  key: 'verse-release-pr',
  fetch: async signal => {
    try {
      const data = await apiGet<unknown>('/api/verse/release-pr', signal);
      if (!isReleasePrData(data)) throw new Error('Invalid release PR response');
      return { kind: 'available', data };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
