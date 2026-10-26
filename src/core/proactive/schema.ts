/** Discoverable native tool inputs; runtime parsers independently validate every field. */
const identifier = { type: 'string', minLength: 1, maxLength: 256 };
const slug = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' };
const nullableIdentifier = { anyOf: [identifier, { type: 'null' }] };
const fields = {
  displayName: { type: 'string', minLength: 1, maxLength: 120 },
  avatar: { type: 'object', properties: { color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, variant: { type: 'string', enum: ['classic', 'round', 'pixel'] } }, required: ['color', 'variant'], additionalProperties: false },
  responsibility: { type: 'string', maxLength: 4000 },
  capabilityIds: { type: 'array', maxItems: 32, uniqueItems: true, items: slug, description: 'User-declared capability IDs; unverified metadata, never proof of transport or entitlement.' },
  preferences: { type: 'object', properties: { priority: { type: 'integer', minimum: 0, maximum: 100, default: 50 }, maxConcurrent: { type: 'integer', minimum: 1, maximum: 32, default: 1 }, projectBindingIds: { type: 'array', maxItems: 32, uniqueItems: true, items: identifier, default: [], description: 'Declared project preference restriction; empty means unspecified. Never grants project access.' } }, additionalProperties: false },
  computer: { type: 'object', properties: { kind: { type: 'string', enum: ['hosted', 'connected-local', 'unknown'] }, label: { type: 'string', maxLength: 120 }, providerComputerId: nullableIdentifier }, required: ['kind', 'label', 'providerComputerId'], additionalProperties: false },
  services: { type: 'array', maxItems: 100, items: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, label: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['id', 'label'], additionalProperties: false } },
  fundingReference: { anyOf: [{ type: 'null' }, { type: 'object', properties: { kind: { type: 'string', enum: ['subscription', 'promotional-api', 'unknown'] }, accountId: identifier, poolId: nullableIdentifier }, required: ['kind', 'accountId', 'poolId'], additionalProperties: false }], description: 'Same-account metadata reference, never proof of balance, expiry or spending eligibility.' },
  enabled: { type: 'boolean', description: 'Save an intended planning preference for supported future invocation. Current planners do not consume profiles; this does not enable transport or spending.' },
};
export const PROACTIVE_PROFILE_INPUT_SCHEMA = {
  type: 'object', properties: { identity: { type: 'object', properties: { provider: slug, accountId: identifier, agentId: identifier }, required: ['provider', 'accountId', 'agentId'], additionalProperties: false }, ...fields },
  required: ['identity', 'displayName'], additionalProperties: false,
};
export const PROACTIVE_PROFILE_PATCH_SCHEMA = {
  type: 'object', properties: { expectedVersion: { type: 'integer', minimum: 1 }, ...fields }, required: ['expectedVersion'], additionalProperties: false,
};
