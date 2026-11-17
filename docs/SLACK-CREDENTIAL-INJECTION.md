# Slack host credential boundary

The existing Socket Mode bridge uses the host environment, not a vault API.
The CLI accepts role-matched `phm_SLACK_AGENTNET_BOT_TOKEN` and
`phm_SLACK_AGENTNET_APP_TOKEN` references. Legacy `phm_SLACK_BOT_TOKEN` and
`phm_SLACK_APP_TOKEN` aliases remain supported. Each resolves only its exact
host environment name. A bot-only probe does not require an app reference.

Missing, malformed, inherited or unresolved named references fail before HTTP.
Opaque Phantom Secrets session tokens remain supported, but require separately
verified host proxy routing. The resolver neither reads the vault nor configures
that proxy. Configuration readiness is not proof that injection works.

No credentials are accepted through CLI arguments or written to observations.
This change does not activate sockets, credentials, or permissions. Follow the
existing [Slack bridge](AGENT-NETWORK.md#slack-bridge) owner workflow and audience
gates; synthetic tests are not live transport or credential qualification.
