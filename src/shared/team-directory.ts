import { z } from 'zod';

// eslint-disable-next-line no-control-regex -- names must not inject terminal control bytes
const text = z.string().trim().min(1).regex(/^[^\x00-\x1f\x7f]+$/), name = text.max(100);
const lane = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const seats = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9:._/-]{0,79}$/)).max(64);
const role = z.enum(['founder', 'engineer', 'viewer']);
const storedId = z.string().regex(/^[a-z0-9][a-z0-9._:/@-]{0,127}$/i);
export const personInputSchema = z.object({
  displayName: name, role: role.default('engineer'), email: z.email().max(254).optional(),
  slack: z.string().regex(/^[UW][A-Z0-9]{2,31}$/).optional(), phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  lanes: z.array(lane).max(16).default([]), seats: seats.default([]),
}).strict();
export const personSchema = z.object({
  id: storedId, displayName: name, role,
  identities: z.array(z.object({ kind: z.enum(['email', 'slack', 'phone']), value: text.max(254),
    state: z.enum(['verified', 'pending', 'unknown']).catch('unknown') }).strict()).max(3),
  lanes: z.array(lane).max(16), seats: z.array(storedId), status: z.enum(['pending', 'member']),
}).strict();
export const directorySchema = z.object({ version: z.literal(1), team: z.string(), people: z.array(personSchema),
  orgState: z.enum(['available', 'absent', 'unknown']) }).strict();
export type TeamPerson = z.infer<typeof personSchema>;
export type TeamDirectory = z.infer<typeof directorySchema>;
export type TeamPersonInput = z.input<typeof personInputSchema>;
