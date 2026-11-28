/** Fixed outbound protocol text that can return as inbound in an owner self-chat. */
export const PHANTOM_PAIR_INVITE_TEXT = 'Phantom: reply YES to get fleet updates here.';

const ACK_SHAPES = [
  /^Received by Phantom\. Receipt: \S{1,200}$/,
  /^Already received by Phantom; no duplicate interjection added\. Receipt: \S{1,200}$/,
  /^Already received by Phantom from another channel; this one is attached to that instruction \(entry [A-Za-z0-9._:-]{1,64}\)\. Receipt: \S{1,200}$/,
];

/** Match complete known payloads only; ordinary owner instructions remain input. */
export function isPhantomOutboundEcho(text: string): boolean {
  const body = text.trim();
  return body === PHANTOM_PAIR_INVITE_TEXT || ACK_SHAPES.some(shape => shape.test(body));
}
