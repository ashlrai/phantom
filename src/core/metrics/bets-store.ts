/**
 * Append-only bet ledger at <runs>/metrics/bets.jsonl and the kill-fast
 * scoring cycle. Lines are only ever appended (O_APPEND, one write per line);
 * nothing here rewrites or truncates the ledger.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { BETS_LEDGER_SCHEMA, foldBets, launchEvent, scoreBet, type Bet, type BetDecision, type BetLaunchInput, type BetLedgerEvent, type BetsFold, BetInputError } from './bets.js';
import { betObservation, dayStamp, jobTimelines, loopMetricValue, type LoopReport } from './loop.js';
import { collectLoop, readTail, type LoopReaders } from './loop-collect.js';

const LEDGER_MAX = 8 * 1024 * 1024;

export const betsLedgerPath = (runsDir: string) => join(runsDir, 'metrics', 'bets.jsonl');

export async function readBets(runsDir: string): Promise<BetsFold> {
  return foldBets((await readTail(betsLedgerPath(runsDir), LEDGER_MAX))?.text ?? null);
}

function append(runsDir: string, events: readonly BetLedgerEvent[]): void {
  if (!events.length) return;
  ensurePrivateDirectory(join(runsDir, 'metrics'));
  appendFileSync(betsLedgerPath(runsDir), events.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600, flag: 'a' });
}

/** Most recent loop report on disk (today's file), used as the launch baseline. */
export async function latestLoopReport(runsDir: string, at: Date): Promise<LoopReport | null> {
  const text = (await readTail(join(runsDir, 'metrics', `loop-${dayStamp(at)}.json`), LEDGER_MAX))?.text ?? null;
  try { const r = text ? JSON.parse(text) as LoopReport : null; return r?.schema === 'metrics.loop.v1' ? r : null; } catch { return null; }
}

export async function launchBet(runsDir: string, input: BetLaunchInput, at: Date): Promise<Bet> {
  const { bets } = await readBets(runsDir);
  if (bets.some(b => b.id === input.id)) throw new BetInputError(`bet ${input.id} already exists`);
  let baseline = input.baseline;
  if (baseline === undefined) {
    const report = await latestLoopReport(runsDir, at);
    baseline = report ? loopMetricValue(report, input.metric) : null;
  }
  const event = launchEvent({ ...input, baseline }, at.toISOString());
  append(runsDir, [event]);
  return foldBets(JSON.stringify(event)).bets[0]!;
}

export async function killBet(runsDir: string, id: string, reason: string, at: Date): Promise<Bet> {
  const { bets } = await readBets(runsDir);
  const bet = bets.find(b => b.id === id);
  if (!bet) throw new BetInputError(`no bet ${id}`);
  if (bet.status !== 'launched') throw new BetInputError(`bet ${id} is already ${bet.status}`);
  if (!reason.trim() || reason.length > 500 || /[\p{Cc}]/u.test(reason)) throw new BetInputError('reason must be 1 to 500 printable characters');
  append(runsDir, [{ schema: BETS_LEDGER_SCHEMA, event: 'kill', ts: at.toISOString(), id, reason: `killed by operator: ${reason.trim()}` }]);
  return { ...bet, status: 'killed', decidedAt: at.toISOString(), reason: `killed by operator: ${reason.trim()}` };
}

export interface ScoreCycle { decisions: BetDecision[]; written: boolean; shareFile: string | null }

/**
 * One scoring cycle: collect the loop once, score every launched bet against
 * it and append each decision (hold included) with its numbers. Also refresh
 * bets-share.json, the file dispatchd can read. dryRun computes without writing.
 */
export async function scoreCycle(readers: LoopReaders, opts: { dryRun?: boolean } = {}): Promise<ScoreCycle> {
  const { bets } = await readBets(readers.runsDir);
  const collection = await collectLoop(readers);
  const jobs = jobTimelines(collection.jobsText, readers.now());
  const decisions = bets.filter(b => b.status === 'launched').map(b => scoreBet(b, betObservation(b, jobs, collection.report)));
  if (opts.dryRun) return { decisions, written: false, shareFile: null };
  const ts = new Date(readers.now()).toISOString();
  append(readers.runsDir, decisions.map(decision => ({ schema: BETS_LEDGER_SCHEMA, event: 'score' as const, ts, decision })));
  ensurePrivateDirectory(join(readers.runsDir, 'metrics'));
  const shareFile = join(readers.runsDir, 'metrics', 'bets-share.json');
  writePrivateFileAtomic(shareFile, `${JSON.stringify({ ...collection.share, at: ts }, null, 2)}\n`);
  return { decisions, written: true, shareFile };
}
