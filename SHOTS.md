# Live Phantom screenshots

Last capture attempt: **2026-11-16 ET**. No live screenshots were captured:
the host denied `open -a Phantom`, and desktop-operator reported no visible
Phantom window. Accessibility and Screen Recording checks passed. The existing
README images remain synthetic; their provenance is in
[CAPTURES.md](docs/images/CAPTURES.md).

## Re-shoot

1. Open the installed Phantom app (`ai.ashlr.desktop`) in a logged-in macOS
   desktop session. `open -a Phantom` activates it when the host permits.
2. Inspect the window with the existing trusted helper:

   ```sh
   printf '%s\n' '{"op":"doctor"}' | ~/.ashlr/bin/desktop-operator
   printf '%s\n' '{"op":"windows","app":"Phantom"}' | ~/.ashlr/bin/desktop-operator
   printf '%s\n' '{"op":"read","app":"Phantom"}' | ~/.ashlr/bin/desktop-operator
   ```

3. Select the dark theme and a populated Fleet view. Capture live lane counts,
   connected provider names and logos, and node RAM and slot measurements.
   Verify mbp-w1/w2, muse/air and the Codex, Claude, Grok and Gemini lanes
   against that session's observations; historical counts are not current data.
   Reject hero frames with unknown, placeholder, loading or empty states.
4. Capture Fleet, Resources and Nodes as separate views. Use the provider
   logos rendered by `src/web-ui/components/primitives/BrandMark.tsx` and
   `src/core/brand/registry.ts`; do not paste logos onto screenshots. If the
   installed build lacks them, capture again after a sanctioned app update.
5. Save the screenshot locally through the CLI wrapper (it returns a private
   PNG path and metadata, without printing base64 image bytes):

   ```sh
   phm desktop screenshot --app Phantom --json
   ```

   The wrapper calls desktop-operator's `screenshot` JSON operation. Keep raw
   pixels private until visually inspected for credentials, account details,
   private conversations and filesystem paths. Navigate to a clean resource
   view before re-shooting if any are visible.
6. Check the returned pixel dimensions. The helper source currently caps width
   at 1280 px; do not upscale and call that retina. For 2× presentation, display
   a capture at no more than half its native pixel width. A wider hero needs a
   trusted helper capable of retaining the native Retina resolution.
7. Optimize approved images losslessly as PNG or WebP, targeting less than
   600 KiB each. Reserve `docs/images/phantom-fleet-live.png`,
   `phantom-resources-live.png` and `phantom-nodes-live.png`. These files do not
   exist yet. Record actual dimensions, byte sizes, SHA-256 checksums, app
   version, capture date and any representative staging here when they do.
8. Replace README hero and section images with descriptive alt text and a
   native-app caption. Refresh stale screenshot embeds in docs, then update
   `test/readme-brand.test.ts` to validate the new assets and live provenance.
   Preserve historical provenance for demo images still used by the site.
   The Universe result graphic in DEMO.md is a measured-results illustration,
   not an app screenshot.

Finish with `node scripts/verify-changed.mjs`, `npm run check:docs` and the
affected documentation tests, running tests with a temporary HOME. Leave
changes uncommitted for publish.sh.
