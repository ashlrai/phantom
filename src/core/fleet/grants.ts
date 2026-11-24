/** M2 metadata contracts only. No cryptographic verification or authority is implemented. */
import { z } from 'zod';
import { agentHandleSchema } from '../agents/bus-identity.js';

export const ownerPrincipalSchema = z.string().regex(/^own_[a-f0-9]{32}(?![\s\S])/);
/** `local` is an unresolved local-owner marker, never an enrolled owner id. */
export const localPrincipalSchema = z.union([z.literal('local'), ownerPrincipalSchema]);
export type LocalPrincipal = z.infer<typeof localPrincipalSchema>;
const kid = z.string().regex(/^kid_[a-f0-9]{32}(?![\s\S])/);
const grantId = z.string().regex(/^grt_[a-f0-9]{32}(?![\s\S])/);
const epoch = z.number().int().nonnegative().safe();
const nonce = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw](?![\s\S])/);
const backend = z.enum(['secure-enclave', 'tpm', 'fido2']);
const signature = z.object({
  alg: z.literal('ES256'), kid, backend,
  sig: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw](?![\s\S])/),
}).strict();
const replayFields = {
  v: z.literal(1), issuer: ownerPrincipalSchema, aud: ownerPrincipalSchema,
  kid, nonce, nbf: epoch, exp: epoch, issuedAt: epoch, alg: z.literal('ES256'), signature,
};
const channel = z.string().regex(/^group:[a-z0-9][a-z0-9_-]{0,31}(?![\s\S])/);
export const grantScopeSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('bus.read'), channel }).strict(),
  z.object({ verb: z.literal('bus.post'), channel }).strict(),
  z.object({ verb: z.literal('roster.view') }).strict(),
  z.object({ verb: z.literal('bundle.pull') }).strict(),
]);
export const grantSchema = z.object({
  ...replayFields, ctx: z.literal('phantom.fleet.grant.v1'), kind: z.literal('fleet.grant'), id: grantId,
  grantee: z.object({ owner: ownerPrincipalSchema, agents: z.array(agentHandleSchema).min(1).max(256) }).strict(),
  scope: z.array(grantScopeSchema).min(1).max(64),
  limits: z.object({ maxMessagesPerHour: z.number().int().nonnegative().safe(), spend: z.literal('none'), egress: z.literal('none') }).strict(),
}).strict().refine(value => value.nbf < value.exp && value.issuedAt <= value.exp, 'Invalid grant validity window')
  .refine(value => value.aud === value.grantee.owner && value.kid === value.signature.kid, 'Inconsistent grant metadata');
export type FleetGrant = z.infer<typeof grantSchema>;

/** Revocation data is carried for inspection only; it cannot activate grants. */
export const revocationSchema = z.object({
  ...replayFields, ctx: z.literal('phantom.fleet.revocation.v1'), kind: z.literal('fleet.revocation'),
  seq: z.number().int().nonnegative().safe(), nextUpdate: epoch,
  devices: z.array(z.object({ kid, backend, alg: z.literal('ES256') }).strict()).max(256),
  auditChainHead: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  revoked: z.object({
    grants: z.array(grantId).max(1024), owners: z.array(ownerPrincipalSchema).max(256),
    devices: z.array(kid).max(256), agents: z.array(agentHandleSchema).max(256),
  }).strict(),
}).strict().refine(value => value.nbf < value.exp && value.nextUpdate > value.issuedAt &&
  value.nextUpdate <= value.issuedAt + 900 && value.kid === value.signature.kid, 'Invalid revocation metadata');
export type FleetRevocation = z.infer<typeof revocationSchema>;

/** Intentionally unconditional. Labels, valid metadata and configuration grant no authority in M2. */
export function checkGrant(_input: unknown): { decision: 'deny'; reason: 'cross-owner-disabled-m2' } {
  return { decision: 'deny', reason: 'cross-owner-disabled-m2' };
}
