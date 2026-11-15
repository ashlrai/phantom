/**
 * Canonical forum bytes for HMAC identity. The signed material is the post
 * the caller claims, not a command line.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { scrubSecrets } from '../../util/scrub.js';
import {
  FORUM_BODY_MAX, FORUM_CHANNEL_IDS, FORUM_KINDS, FORUM_LANES, FORUM_STEWARD,
  type ForumChannelId, type ForumKind, type ForumLane, type ForumPayload, type NorthStar,
} from './types.js';

export const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const CLIENT_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const PRINCIPAL = /^[a-z0-9][a-z0-9:@._-]{0,127}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CONTROL = /(?![\n\t])\p{Cc}/u;
const MENTION = /@([a-z][a-z0-9-]{0,63})/g;

export function isAgentId(value: string): boolean {
  return AGENT_ID.test(value) && value !== FORUM_STEWARD;
}

export function isPrincipal(value: string): boolean {
  return PRINCIPAL.test(value) && scrubSecrets(value) === value;
}

export function isChannelId(value: string): value is ForumChannelId {
  return (FORUM_CHANNEL_IDS as readonly string[]).includes(value);
}

export function isKind(value: string): value is ForumKind {
  return (FORUM_KINDS as readonly string[]).includes(value);
}

export function isLane(value: string): value is ForumLane {
  return (FORUM_LANES as readonly string[]).includes(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL.test(trimmed) || scrubSecrets(trimmed) !== trimmed) return null;
  return trimmed;
}

function countOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined;
  return value as number;
}

function metrics(value: unknown): NorthStar | null {
  if (!plain(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['merges', 'mainHealth', 'releases', 'stars', 'capturedAt'].includes(key))) return null;
  const merges = countOrNull(value.merges ?? null);
  const releases = countOrNull(value.releases ?? null);
  const stars = countOrNull(value.stars ?? null);
  const mainHealth = value.mainHealth ?? 'unknown';
  const capturedAt = value.capturedAt ?? null;
  if (merges === undefined || releases === undefined || stars === undefined) return null;
  if (mainHealth !== 'green' && mainHealth !== 'red' && mainHealth !== 'unknown') return null;
  if (capturedAt !== null && text(capturedAt, 40) === null) return null;
  return { merges, mainHealth, releases, stars, capturedAt: capturedAt === null ? null : String(capturedAt) };
}

export function parsePayload(kind: ForumKind, raw: unknown): { ok: true; payload: ForumPayload } | { ok: false; reason: 'invalid' } {
  const value = raw === undefined ? {} : raw;
  if (!plain(value)) return { ok: false, reason: 'invalid' };
  const keys = Object.keys(value);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  switch (kind) {
    case 'note':
      return keys.length === 0 ? { ok: true, payload: { kind: 'note' } } : { ok: false, reason: 'invalid' };
    case 'proposal': {
      const title = text(value.title, 120);
      const decision = value.decision ?? 'open';
      if (!title || !only('title', 'decision')) return { ok: false, reason: 'invalid' };
      if (decision !== 'open' && decision !== 'accepted' && decision !== 'declined') return { ok: false, reason: 'invalid' };
      return { ok: true, payload: { kind: 'proposal', title, decision } };
    }
    case 'commitment': {
      const owner = typeof value.owner === 'string' && isAgentId(value.owner) ? value.owner : null;
      const summary = text(value.summary, 200);
      const deadline = text(value.deadline, 40);
      if (!owner || !summary || !deadline || !Number.isFinite(Date.parse(deadline)) || !only('owner', 'deadline', 'summary', 'jobId', 'fallbackLane')) {
        return { ok: false, reason: 'invalid' };
      }
      const payload: ForumPayload = { kind: 'commitment', owner, deadline, summary, status: 'open' };
      if (value.jobId !== undefined) {
        if (typeof value.jobId !== 'string' || !JOB_ID.test(value.jobId)) return { ok: false, reason: 'invalid' };
        payload.jobId = value.jobId;
      }
      if (value.fallbackLane !== undefined) {
        if (typeof value.fallbackLane !== 'string' || !isLane(value.fallbackLane)) return { ok: false, reason: 'invalid' };
        payload.fallbackLane = value.fallbackLane;
      }
      return { ok: true, payload };
    }
    case 'review-request': {
      const subject = text(value.subject, 200);
      const reviewer = typeof value.reviewer === 'string' && isAgentId(value.reviewer) ? value.reviewer : null;
      if (!subject || !reviewer || !only('subject', 'reviewer')) return { ok: false, reason: 'invalid' };
      return { ok: true, payload: { kind: 'review-request', subject, reviewer } };
    }
    case 'blocker': {
      const blockedOn = text(value.blockedOn, 200);
      if (!blockedOn || !only('blockedOn')) return { ok: false, reason: 'invalid' };
      return { ok: true, payload: { kind: 'blocker', blockedOn } };
    }
    case 'retro': {
      const period = text(value.period, 40);
      if (!period || !only('period', 'metrics')) return { ok: false, reason: 'invalid' };
      const parsed = metrics(value.metrics ?? { merges: null, mainHealth: 'unknown', releases: null, stars: null, capturedAt: null });
      if (!parsed) return { ok: false, reason: 'invalid' };
      return { ok: true, payload: { kind: 'retro', period, metrics: parsed } };
    }
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

export function signable(payload: ForumPayload): unknown {
  switch (payload.kind) {
    case 'note':
      return {};
    case 'proposal':
      return { decision: payload.decision, title: payload.title };
    case 'commitment': {
      const out: Record<string, string> = { deadline: payload.deadline, owner: payload.owner, summary: payload.summary };
      if (payload.fallbackLane) out.fallbackLane = payload.fallbackLane;
      if (payload.jobId) out.jobId = payload.jobId;
      return out;
    }
    case 'review-request':
      return { reviewer: payload.reviewer, subject: payload.subject };
    case 'blocker':
      return { blockedOn: payload.blockedOn };
    case 'retro':
      return { metrics: payload.metrics, period: payload.period };
    default: {
      const neverPayload: never = payload;
      return neverPayload;
    }
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!plain(value)) return 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function canonicalPost(input: {
  authorId: string; channelId: string; threadId: string; parentId: string;
  kind: string; body: string; clientId: string; payload: unknown;
}): string {
  return ['forum.v1', input.authorId, input.channelId, input.threadId, input.parentId, input.kind, input.body, input.clientId, stableJson(input.payload)].join('\n');
}

export function signPost(keyHex: string, canonical: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(canonical).digest('hex');
}

export function verifyPost(keyHex: string, canonical: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{64}$/.test(keyHex)) return false;
  const left = Buffer.from(signPost(keyHex, canonical), 'hex');
  const right = Buffer.from(signature, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseMentions(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((match) => match[1]!))];
}

export function checkBody(body: string): { ok: true; body: string } | { ok: false; reason: 'invalid' | 'secret-shaped' } {
  if (typeof body !== 'string' || !body.trim() || body.length > FORUM_BODY_MAX || CONTROL.test(body)) return { ok: false, reason: 'invalid' };
  const normalized = body.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return { ok: false, reason: 'invalid' };
  if (scrubSecrets(normalized) !== normalized) return { ok: false, reason: 'secret-shaped' };
  return { ok: true, body: normalized };
}

export function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= 180 ? flat : `${flat.slice(0, 179)}…`;
}

export function structuredTargets(payload: ForumPayload): string[] {
  switch (payload.kind) {
    case 'commitment':
      return [payload.owner];
    case 'review-request':
      return [payload.reviewer];
    case 'note':
    case 'proposal':
    case 'blocker':
    case 'retro':
      return [];
    default: {
      const neverPayload: never = payload;
      return neverPayload;
    }
  }
}

export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
