/**
 * Append-only bus store: one JSONL file per topic under ~/.ashlr-runs/bus/, each append
 * taken under a per-topic local-store lock. Acks live in one shared append-only file.
 * Corrupt lines are skipped on read, never rewritten; nothing here deletes data.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { type BusMessage, type BusSender, busMessageIssues, isBusLabel, isBusVendor } from './message.js';

export const BUS_ACKS_FILE = '_acks.jsonl';
export const MAX_BUS_TOPIC_BYTES = 8 * 1024 * 1024;
export const MAX_BUS_TOPIC_MESSAGES = 5_000;
const LOCK_WAIT_MS = 5_000;

export interface BusStoreOptions { dir?: string }

export interface BusAck { schema: 'bus.ack.v1'; messageId: string; by: BusSender; at: string }

export function busDir(options: BusStoreOptions = {}): string {
  return options.dir ?? process.env['PHM_BUS_DIR'] ?? join(homedir(), '.ashlr-runs', 'bus');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function withLock<T>(dir: string, name: string, fn: () => T): T | 'unavailable' {
  ensureDir(dir);
  const lock = acquireLocalStoreLock(join(dir, `_${name}.lock`), LOCK_WAIT_MS);
  if (!lock) return 'unavailable';
  try { return fn(); } finally { releaseLocalStoreLock(lock); }
}

function appendLine(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  const fd = openSync(file, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readLines<T>(file: string, accept: (value: unknown) => value is T): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (accept(value)) out.push(value);
    } catch { /* torn or corrupt line: skip, never rewrite */ }
  }
  return out;
}

const isMessage = (v: unknown): v is BusMessage => busMessageIssues(v).length === 0;
const isAck = (v: unknown): v is BusAck => {
  const r = v as Partial<BusAck> | null;
  return r !== null && typeof r === 'object' && r.schema === 'bus.ack.v1' && typeof r.messageId === 'string'
    && typeof r.at === 'string' && r.by !== null && typeof r.by === 'object'
    && isBusLabel(r.by.agent) && isBusVendor(r.by.vendor);
};

export type BusAppendResult = 'posted' | 'duplicate' | 'full' | 'invalid' | 'unavailable';

/** Append one already-validated message to its topic file. Same id twice is a duplicate, not a second line. */
export function appendBusMessage(topic: string, message: BusMessage, options: BusStoreOptions = {}): BusAppendResult {
  if (!isBusLabel(topic) || busMessageIssues(message).length > 0) return 'invalid';
  const dir = busDir(options);
  const file = join(dir, `${topic}.jsonl`);
  const result = withLock<BusAppendResult>(dir, `topic-${topic}`, () => {
    const existing = readLines(file, isMessage);
    if (existing.some(m => m.id === message.id)) return 'duplicate';
    if (existing.length >= MAX_BUS_TOPIC_MESSAGES || (existsSync(file) && statSync(file).size >= MAX_BUS_TOPIC_BYTES)) return 'full';
    appendLine(file, message);
    return 'posted';
  });
  return result;
}

export function listBusTopics(options: BusStoreOptions = {}): string[] {
  const dir = busDir(options);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl') && f !== BUS_ACKS_FILE)
    .map(f => f.slice(0, -'.jsonl'.length))
    .filter(isBusLabel)
    .sort();
}

/** Messages of the named topics (all topics when omitted), oldest first by createdAt then id. */
export function readBusTopicMessages(topics: string[] | undefined, options: BusStoreOptions = {}): BusMessage[] {
  const dir = busDir(options);
  const names = topics ?? listBusTopics(options);
  const all = names.flatMap(t => (isBusLabel(t) ? readLines(join(dir, `${t}.jsonl`), isMessage) : []));
  return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function readBusAcks(options: BusStoreOptions = {}): BusAck[] {
  return readLines(join(busDir(options), BUS_ACKS_FILE), isAck);
}

export type BusAckResult = 'acked' | 'duplicate' | 'unavailable';

/** Record that `by` has handled `messageId`. Idempotent per (message, agent). */
export function appendBusAck(ack: BusAck, options: BusStoreOptions = {}): BusAckResult {
  const dir = busDir(options);
  const file = join(dir, BUS_ACKS_FILE);
  return withLock<BusAckResult>(dir, 'acks', () => {
    if (readLines(file, isAck).some(a => a.messageId === ack.messageId && a.by.agent === ack.by.agent)) return 'duplicate';
    appendLine(file, ack);
    return 'acked';
  });
}
