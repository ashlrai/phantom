import { MasonThreadCard } from './MasonThreadCard.js';
import { MasonThreadReply } from './MasonThreadReply.js';

/** Desktop: the one timeline plus a box to answer the Leader (the phone has its own composer). */
export function MasonThreadPane() {
  return <><MasonThreadCard /><MasonThreadReply /></>;
}
