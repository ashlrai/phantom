# Phantom area owners

This map identifies entry points and representative modules and tests. Consult CODEOWNERS for the complete, current protected path list.

## Comms intake (email, Telegram, iMessage)

**Purpose:** Receives and routes inbound messages from supported channels.

**Entry points:** CLI: `ashlr imessage`; Telegram and email bridges feed intake.

**Core modules:** `src/core/comms/email-drop-bridge.ts`, `src/core/comms/telegram-inbox-bridge.ts`, `src/core/comms/imessage-inbox-bridge.ts`.

**Tests:** `test/comms-cycle-email-drop-nov01.test.ts`, `test/comms-telegram-leader-314.test.ts`.

**Owner-only paths:** `test/comms-telegram-leader-314.test.ts` — changes here need Mason's review and never auto-merge.

**Owner lane:** fleet (any lane).

## Channel envelope, dedupe and acks

**Purpose:** Normalizes channel messages, suppresses duplicates and records acknowledgements.

**Entry points:** CLI: `ashlr channels`.

**Core modules:** `src/core/fleet/channel-envelope.ts`, `src/core/fleet/channel-dedupe-store.ts`, `src/core/fleet/channel-ack-text.ts`.

**Tests:** `test/phx-channel-ack-deadline-31r5.test.ts`, `test/phx-channelnormalizedroundtrip31ac1.test.ts`.

**Owner-only paths:** None among the paths listed above; check CODEOWNERS before changing other paths.

**Owner lane:** fleet (any lane).

## Leader thread (Mason ↔ Leader)

**Purpose:** Keeps the conversation and routes Leader interactions.

**Entry points:** Desktop: Leader pane; API: Leader routes.

**Core modules:** `src/core/vision/leader-thread.ts`, `src/core/verse/leader-api.ts`, `src/web-ui/routes/verse/leader/LeaderConversation.tsx`.

**Tests:** `test/leader-thread-314.test.ts`, `test/leader-thread-routes-314.test.ts`.

**Owner-only paths:** `test/leader-thread-314.test.ts`, `test/leader-thread-routes-314.test.ts` — changes here need Mason's review and never auto-merge.

**Owner lane:** fleet (any lane).

## Chief of staff

**Purpose:** Accepts and processes chief-of-staff intake and drafts.

**Entry points:** CLI: `ashlr cos`; desktop: fleet chief-of-staff view.

**Core modules:** `src/core/cos/intake.ts`, `src/core/cos/worker.ts`, `src/core/cos/drafts.ts`.

**Tests:** `test/cos-intake.test.ts`, `test/cos-worker.test.ts`.

**Owner-only paths:** None among the paths listed above; check CODEOWNERS before changing other paths.

**Owner lane:** fleet (any lane).

## Agent bus

**Purpose:** Coordinates agent messages, claims and work.

**Entry points:** CLI: `ashlr agents bus`.

**Core modules:** `src/core/agents/bus-v2-schema.ts`, `src/core/cos/bus-notice.ts`.

**Tests:** `test/agent-bus-v2-schema.test.ts`, `test/agent-bus-checkpoint.test.ts`.

**Owner-only paths:** None among the paths listed above; check CODEOWNERS before changing other paths.

**Owner lane:** fleet (any lane).

## Fleet CLI verbs

**Purpose:** Exposes fleet operations through individual verb dispatchers.

**Entry points:** CLI: `ashlr fleet` (verb dispatchers follow the fleet filename convention).

**Core modules:** `src/cli/fleet-backlog.ts`, `src/cli/fleet-cos.ts`, `src/cli/fleet-bus-request.ts`.

**Tests:** `test/fleet-backlog-cli-31.test.ts`, `test/cos-cli-roundtrip.test.ts`.

**Owner-only paths:** `test/fleet-backlog-cli-31.test.ts` — changes here need Mason's review and never auto-merge.

**Owner lane:** fleet (any lane).

## Desktop Verse console panes

**Purpose:** Provides the interactive desktop console and its Leader pane.

**Entry points:** CLI: `ashlr verse`; desktop: Verse panes.

**Core modules:** `src/web-ui/routes/verse/`, `src/web-ui/routes/verse/leader/LeaderConversation.tsx`.

**Tests:** `src/web-ui/routes/verse/leader/LeaderConversation.test.tsx`, `test/verse-api.test.ts`.

**Owner-only paths:** None among the paths listed above; check CODEOWNERS before changing other paths.

**Owner lane:** fleet (any lane).

## Remote/phone gateway

**Purpose:** Serves remote and phone clients under gateway policy.

**Entry points:** API: remote gateway routes; desktop: phone interface.

**Core modules:** `src/core/web/remote-gateway.ts`, `src/core/web/remote-gateway-policy.ts`.

**Tests:** `test/remote-gateway-auth.test.ts`, `test/remote-gateway-http.test.ts`.

**Owner-only paths:** None among the paths listed above; check CODEOWNERS before changing other paths.

**Owner lane:** fleet (any lane).

## Usage and accounts

**Purpose:** Reads account status and usage evidence.

**Entry points:** Desktop: accounts and usage views.

**Core modules:** `src/core/resources/claude-account-status.ts`, `src/core/resources/claude-account-usage.ts`, `src/core/fleet/subscription-usage.ts`.

**Tests:** `test/resource-claude-account-status.test.ts`, `test/resource-claude-account-usage.test.ts`.

**Owner-only paths:** `src/core/fleet/subscription-usage.ts` — changes here need Mason's review and never auto-merge.

**Owner lane:** fleet (any lane).

## Release and self-update

**Purpose:** Manages release publication and desktop updates; much of this area is owner-only.

**Entry points:** CLI: `ashlr desktop update`; desktop: update status.

**Core modules:** `src/cli/desktop-update.ts`, `src/core/release-public-facts.ts`, `scripts/publish-desktop-release.mjs`.

**Tests:** `test/desktop-update-cli.test.ts`, `test/desktop-update-trust.test.ts`.

**Owner-only paths:** `src/cli/desktop-update.ts`, `src/core/release-public-facts.ts`, `scripts/publish-desktop-release.mjs`, `test/desktop-update-cli.test.ts`, `test/desktop-update-trust.test.ts` — changes here need Mason's review and never auto-merge.

**Owner lane:** fleet (any lane).
