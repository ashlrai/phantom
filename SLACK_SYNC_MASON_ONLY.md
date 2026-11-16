# Mason-only: Slack fleet sync setup

RQ-SLACK-SYNC-1. Agent handoff only. No app installation, scope grant, credential creation, live configuration change or Slack send was performed.

## App and identity

- Mason only: select an existing private custom Slack app in the Ashlr workspace, or create one named Ashlr Fleet Sync if none exists. Its actual app ID and workspace ID are unverified; record them before activation. No additional Slack connector app is required.
- Mason only: enable Socket Mode and authorize only its bot identity. Never authorize a user token or post as Mason. Do not publish the app to other workspaces.
- Mason only: invite the bot manually to the approved fleet channels. Record exact channel IDs and bus topics in [[slack.map]], and bind team_id, own_user_id and own_bot_id in [slack]. Map only approved fleet channels, with no DMs, group DMs or Slack Connect/shared channels. Configure the explicit [team] member allowlist.

## Exact scopes and bot events

The full public-and-private fleet-channel profile uses these bot scopes:

| Scope | Required behavior |
| --- | --- |
| channels:read | Inspect public fleet channels and enumerate membership |
| channels:history | Receive public channel messages and reconcile root posts |
| groups:read | Inspect private fleet channels and enumerate membership |
| groups:history | Receive private channel messages and reconcile root posts |
| users:read | Verify member workspace bindings and guest/bot/deleted flags |
| chat:write | Send under the authenticated bot identity |
| app_mentions:read | Receive the bridge's supported app_mention events |

Mason only: authorize the above bot scopes for this profile. A public-only deployment omits groups:read, groups:history and message.groups. A private-only deployment omits channels:read, channels:history and message.channels. If using ordinary channel messages without app_mention subscriptions, omit app_mentions:read as well.

Mason only: authorize the app-level scope connections:write for Socket Mode. This is an app-level grant, separate from bot scopes. No user scopes are required or allowed for this task.

Mason only: configure bot event subscriptions message.channels, message.groups and app_mention for the full profile. Event names are subscriptions, not OAuth scopes.

Do not add im:*, mpim:*, chat:write.public, chat:write.customize, users:read.email, channels:join, admin, file or channel-management scopes. Do not enable automatic joins. No additional paid service or credits are required by this handoff; actual plan availability is unverified.

## Credential custody and offline review

Mason only: use the existing trusted secret injector with Phantom Secrets reference names phm_SLACK_AGENTNET_BOT_TOKEN and phm_SLACK_AGENTNET_APP_TOKEN. Store names only in agent-network.toml. No credential value belongs in this document, the repository, CLI arguments or logs.

Before any later activation, review the offline output of phm channels slack map --json and phm channels slack map --topic <fleet-topic> --snapshot <saved-audience.json> --json. These commands perform no Slack API calls. This job does not authorize a live probe or run.

Existing transport verifies bot/workspace identity and channel membership before delivery, drops its own echoes, refuses external/private-source forwarding and retains uncertain-send intents without replaying them. The general bridge also supports mapped DMs; this handoff's scope forbids configuring them. Existing dry-run and fake-client tests are reused rather than creating a second transport.

The current conversations.replies reference lists channels:history and groups:history for bot tokens. Ambiguous deliveries without matching history evidence remain uncertain; do not request a user token or replay an uncertain post to resolve them. No live delivery or app grant was verified.

## Official scope references

- [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [connections:write](https://docs.slack.dev/reference/scopes/connections.write/)
- [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/)
- [message.channels](https://docs.slack.dev/reference/events/message.channels/)
- [message.groups](https://docs.slack.dev/reference/events/message.groups/)
- [users.info](https://docs.slack.dev/reference/methods/users.info/)
- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postmessage/)
- [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
