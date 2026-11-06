import { useWindowTitle } from './window-title.js';

/**
 * The window title follows the fleet (shell/fleet-runs-badge.ts), which first
 * paint does not need: VerseApp mounts this lazily so the badge's query and
 * model stay out of the chat's critical JS.
 */
export default function WindowTitle() {
  useWindowTitle();
  return null;
}
