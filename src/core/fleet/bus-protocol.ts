/**
 * Bus protocol v1 surface; the implementation lives in bus-envelope.ts.
 * Re-exporting it here keeps the runtime import closure of the Tier-1
 * authority roots flat — this module never joins the closure — while callers
 * keep a dedicated protocol import path. See bus-envelope.ts for semantics.
 */
export {
  BUS_PAYLOAD_REF_MAX,
  BUS_PROTOCOL_KEY,
  BUS_PROTOCOL_KINDS,
  BUS_PROTOCOL_VERSION,
  BUS_TOPIC_NAMESPACES,
  isClaimableWork,
  isTopicName,
  isTopicPattern,
  protocolIssue,
  protocolOf,
  topicMatches,
} from './bus-envelope.js';
export type { BusProtocol, BusProtocolKind } from './bus-envelope.js';
