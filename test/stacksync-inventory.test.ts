import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const count = z.number().int().nonnegative().nullable();
const usd = z.string().regex(/^\d+(?:\.\d+)?$/).nullable();
const time = z.iso.datetime().nullable();
const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  advisoryOnly: z.literal(true),
  stacksync: z.object({
    provider: z.literal('stacksync-eos'),
    apiBaseUrl: z.literal('https://eos.stacksync.com'),
    attemptedAt: z.iso.datetime(), observedAt: time,
    inventoryStatus: z.enum(['available', 'partial', 'unavailable']),
    reasonCode: z.string().regex(/^[a-z_]+$/),
    accountVerified: z.boolean(), workspaceVerified: z.boolean(),
    creditBalanceUsd: usd, monthlyIncludedCreditsUsd: usd,
    creditExpiresAt: time, creditResetsAt: time,
    productsEnabled: z.object({
      postgres: z.boolean().nullable(), projectVariables: z.boolean().nullable(),
      inference: z.boolean().nullable(), storage: z.boolean().nullable(), requestLogs: z.boolean().nullable(),
    }).strict(),
    inventory: z.object({
      databaseCount: count, appCount: count, inferenceKeyCount: count, modelCount: count, storageBucketCount: count,
    }).strict(),
    inference: z.object({ spentUsd: usd, reservedUsd: usd, remainingUsd: usd }).strict(),
    storage: z.object({ usedBytes: count, reservedBytes: count, byteLimit: count, objectCount: count, objectLimit: count }).strict(),
    executionEligible: z.literal(false),
  }).strict(),
}).strict();

const snapshot: unknown = JSON.parse(readFileSync(new URL('../queue/resources-ledger.json', import.meta.url), 'utf8'));

describe('StackSync advisory inventory evidence', () => {
  it('allows only typed metadata, decimal USD values and no credential-bearing extra fields', () => {
    expect(inventorySchema.safeParse(snapshot).success).toBe(true);
    const parsed = inventorySchema.parse(snapshot);
    expect(inventorySchema.safeParse({ ...parsed, stacksync: { ...parsed.stacksync, api_key: 'fixture' } }).success).toBe(false);
    expect(usd.safeParse(1000).success).toBe(false);
    expect(usd.safeParse('0.000448').success).toBe(true);
  });

  it('never turns failed inventory or owner-reported credits into measured capacity', () => {
    const row = inventorySchema.parse(snapshot).stacksync;
    expect(row.inventoryStatus).toBe('unavailable');
    expect(row.accountVerified || row.workspaceVerified || row.executionEligible).toBe(false);
    expect(row.observedAt).toBeNull();
    expect([row.creditBalanceUsd, row.monthlyIncludedCreditsUsd, row.creditExpiresAt, row.creditResetsAt,
      ...Object.values(row.productsEnabled), ...Object.values(row.inventory),
      ...Object.values(row.inference), ...Object.values(row.storage)].every(value => value === null)).toBe(true);
  });
});
