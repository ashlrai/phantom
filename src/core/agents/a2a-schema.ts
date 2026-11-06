import { z } from 'zod';

const nonBlank = z.string().trim().min(1);

/** Configuration shape only. Evidence must be verified before any future use. */
export const a2aCounterpartSchema = z.object({
  localOptIn: z.literal(true),
  remoteOptInEvidence: nonBlank,
  channel: z.enum(['email', 'slack', 'imessage']),
  scope: z.array(nonBlank).min(1),
}).strict();

export const a2aConfigSchema = z.object({
  enabled: z.boolean().default(false),
  counterparts: z.array(a2aCounterpartSchema).default([]),
}).strict();

export type A2aConfig = z.infer<typeof a2aConfigSchema>;
